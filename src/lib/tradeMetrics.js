// Pure, dependency-free performance metrics for closed TradeOperations —
// the single source of truth for PnL, realized R and WIN/LOSS/BE
// classification (docs/known-risks.md item 22). Before this module, calcPnl
// was copy-pasted inline in 6+ components with three divergent win-rate
// schemes (TP2_HIT-only, PnL>0, heuristic 0.5 weight) and none of them used
// the persisted partial_percent or initial_stop.
//
// Model (community convention for R-multiples with scaled exits):
//   risk       = |entry_price - initial_stop|        (never current_stop —
//                post-TP1 it is already breakeven/trailing)
//   realized   = partial · (tp1Price - entry) + runner · (exit - entry)
//                when tp1_hit, else 100% at the exit price
//   R          = realized / risk;  WIN/LOSS/BE decided by realized result
//                with an epsilon band (default 0.05R), NEVER by status —
//                an INVALIDATED op that closed in profit is a WIN.
// Costs (Fase 5, docs/known-risks.md item 44): fees, slippage and funding ARE
// deducted, by default, on every surface — panel and backtest alike. Before
// Fase 5 this module deducted nothing, which made every "compare the backtest
// before activating" gate in items 40-43 optimistic. The default is the real
// cost (not zero) on purpose: this module is the single source of truth, and a
// zero default that each caller had to override would eventually leave one
// screen showing gross while another shows net — the exact divergence item 22
// created this module to kill. Pass ZERO_COST explicitly for gross figures.
// tp1_hit_price is still the THEORETICAL tp1 level written by both scanner
// loops, so the partial leg carries modelled slippage, not a measured fill. A
// manually edited exit_price is respected as the user's declared truth.
import { isTerminalStatus } from './opTransition.js';

const isFinitePrice = (v) => Number.isFinite(v) && v > 0;

const BPS = 10000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

// Defaults anchored on the user's OWN Pine strategy declaration
// (src/pages/PineScript.jsx: commission_value = 0.05, slippage = 1) and on
// Binance USDⓈ-M VIP0 taker (0.05%). Keeping them aligned also keeps the JS
// replay comparable to the TradingView backtest (.claude/rules/pine-parity.md).
//
// Taker on BOTH sides is deliberate and conservative: a signal that fires on
// candle close and wants to be in the market now is a market order (taker),
// and a stop triggers into a market order (taker). Only a take-profit is
// genuinely a resting limit order that could earn the 0.02% maker rate —
// exposed as feeBpsExit for whoever wants to model it, never assumed.
//
// slippageBpsPerSide has NO industry default to inherit: backtesting.py,
// vectorbt, Backtrader, QuantConnect and freqtrade all default to zero
// slippage. 1 bp/side is a registered choice for BTC/ETH-class liquidity
// (~20% of the fee cost), not a convention.
export const DEFAULT_COST_MODEL = {
  feeBpsEntry: 5,
  feeBpsExit: 5,
  slippageBpsPerSide: 1,
  fundingBpsPer8h: 1,
};

// Explicit opt-out — yields the pre-Fase-5 gross numbers. Used by the tests
// that document the gross formula and by the backtest's --no-costs A/B run.
export const ZERO_COST = {
  feeBpsEntry: 0,
  feeBpsExit: 0,
  slippageBpsPerSide: 0,
  fundingBpsPer8h: 0,
};

// Exportada para src/lib/backtestAnalysis.js poder montar modelos isolados
// (só taxa, só slippage, só funding) a partir dos MESMOS valores efetivos que
// este módulo usa — se a lógica de fallback vivesse em dois lugares, a
// decomposição do custo poderia divergir do custo que o relatório cobrou.
export function resolveCostModel(model) {
  if (!model) return DEFAULT_COST_MODEL;
  return {
    feeBpsEntry: Number.isFinite(model.feeBpsEntry) ? model.feeBpsEntry : DEFAULT_COST_MODEL.feeBpsEntry,
    feeBpsExit: Number.isFinite(model.feeBpsExit) ? model.feeBpsExit : DEFAULT_COST_MODEL.feeBpsExit,
    slippageBpsPerSide: Number.isFinite(model.slippageBpsPerSide)
      ? model.slippageBpsPerSide : DEFAULT_COST_MODEL.slippageBpsPerSide,
    fundingBpsPer8h: Number.isFinite(model.fundingBpsPer8h)
      ? model.fundingBpsPer8h : DEFAULT_COST_MODEL.fundingBpsPer8h,
  };
}

// Funding settles at fixed wall-clock boundaries (00:00/08:00/16:00 UTC on
// Binance) and is charged ONLY if the position is open at that exact instant —
// close at 07:59 and you pay nothing. So this counts boundaries crossed, it
// does not prorate by duration. Research (item 44): for positions lasting
// hours this is 2.5-10% of the fee cost — reported for telemetry, not because
// it moves a decision. Returns 0 when either timestamp is unusable.
// Melhor "quando a posição passou a existir" disponível. Difere de propósito
// de opExitRules.getEntryReferenceTime, que PARA em candle_close_time: aquela
// guarda protege contra candle contaminado e precisa falhar para o lado
// conservador, esta aqui só mede duração e prefere um fallback a devolver 0.
export function getOpenedAt(op) {
  return op?.entry_candle_time_15m ?? op?.entry_candle_time_5m ?? op?.entry_candle_time_4h ?? op?.candle_close_time ?? op?.created_date ?? null;
}

export function countFundingSettlements(op) {
  const openedAt = getOpenedAt(op);
  const closedAt = getClosedAt(op);
  if (!openedAt || !closedAt) return 0;
  const startMs = new Date(openedAt).getTime();
  const endMs = new Date(closedAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.floor(endMs / EIGHT_HOURS_MS) - Math.floor(startMs / EIGHT_HOURS_MS);
}

// Same boundary count as countFundingSettlements, split at TP1 — a
// settlement crossed AFTER TP1 only applies to whatever fraction of the
// position the runner leg still holds, not the full notional. Before this
// split, calcTradeCost billed every settlement at 100% of entry_price even
// after a partial close reduced exposure, the one cost component fee/
// slippage already avoid (they're weighted per-leg via getWeights). No
// TP1 (or an unusable tp1_hit_at) falls back to "whole duration at full
// notional" — identical to the pre-split behaviour, so ops without a
// partial exit are unaffected.
export function countFundingSettlementsByLeg(op) {
  const openedAt = getOpenedAt(op);
  const closedAt = getClosedAt(op);
  if (!openedAt || !closedAt) return { beforeTp1: 0, afterTp1: 0 };
  const startMs = new Date(openedAt).getTime();
  const endMs = new Date(closedAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { beforeTp1: 0, afterTp1: 0 };
  }
  const tp1Ms = op.tp1_hit && op.tp1_hit_at ? new Date(op.tp1_hit_at).getTime() : NaN;
  if (!Number.isFinite(tp1Ms) || tp1Ms <= startMs || tp1Ms >= endMs) {
    const total = Math.floor(endMs / EIGHT_HOURS_MS) - Math.floor(startMs / EIGHT_HOURS_MS);
    return { beforeTp1: total, afterTp1: 0 };
  }
  return {
    beforeTp1: Math.floor(tp1Ms / EIGHT_HOURS_MS) - Math.floor(startMs / EIGHT_HOURS_MS),
    afterTp1: Math.floor(endMs / EIGHT_HOURS_MS) - Math.floor(tp1Ms / EIGHT_HOURS_MS),
  };
}

// Total round-trip cost in PRICE units (always >= 0 — a cost never helps the
// trader, regardless of side). Fee and slippage are charged per fill on that
// fill's own notional; the module has no position size, so notional is the
// fill price and every leg is weighted by its share of the position.
//
// Fill count follows the same tp1_hit branch calcRealizedDelta uses: 3 fills
// with a TP1 partial (entry + partial + runner), 2 without.
export function calcTradeCost(op, costModel) {
  const zero = { total: 0, entryCost: 0, exitCost: 0, fundingCost: 0, fills: 0, fundingSettlements: 0 };
  if (!isClosedOp(op) || !isFinitePrice(op.entry_price)) return zero;
  const exit = getExitPrice(op);
  if (exit === null) return zero;

  const m = resolveCostModel(costModel);
  const entryRate = (m.feeBpsEntry + m.slippageBpsPerSide) / BPS;
  const exitRate = (m.feeBpsExit + m.slippageBpsPerSide) / BPS;

  const entryCost = op.entry_price * entryRate;

  let exitCost;
  let fills;
  const tp1Price = op.tp1_hit ? getTp1Price(op) : null;
  if (tp1Price !== null) {
    const { partial, runner } = getWeights(op);
    exitCost = (partial * tp1Price + runner * exit) * exitRate;
    fills = 3;
  } else {
    exitCost = exit * exitRate;
    fills = 2;
  }

  let fundingSettlements = 0;
  let fundingCost = 0;
  if (m.fundingBpsPer8h > 0) {
    const { beforeTp1, afterTp1 } = countFundingSettlementsByLeg(op);
    fundingSettlements = beforeTp1 + afterTp1;
    const rate = m.fundingBpsPer8h / BPS;
    const { runner } = getWeights(op);
    fundingCost = (beforeTp1 * op.entry_price + afterTp1 * runner * op.entry_price) * rate;
  }

  return {
    total: entryCost + exitCost + fundingCost,
    entryCost,
    exitCost,
    fundingCost,
    fills,
    fundingSettlements,
  };
}

export function isClosedOp(op) {
  return isTerminalStatus(op?.status);
}

// Best available "when did it close" — closed_at is written on every terminal
// transition; the fallbacks only serve legacy/manually edited docs.
export function getClosedAt(op) {
  return op.closed_at ?? op.updated_date ?? op.created_date ?? null;
}

// Runner exit price. exit_price is primary (the scanner writes it on every
// terminal transition; manual edits land here too). The per-status fallbacks
// only cover legacy docs: STOP_HIT uses current_stop unconditionally — after
// TP1 it already IS breakeven or the advanced trailing stop, so the old
// `tp1_hit ? entry_price : current_stop` branch was never more accurate.
export function getExitPrice(op) {
  if (!isClosedOp(op)) return null;
  if (isFinitePrice(op.exit_price)) return op.exit_price;
  if (op.status === 'TP2_HIT' && isFinitePrice(op.tp2)) return op.tp2;
  if (op.status === 'STOP_HIT') {
    if (isFinitePrice(op.current_stop)) return op.current_stop;
    if (isFinitePrice(op.entry_price)) return op.entry_price;
    return null;
  }
  // INVALIDATED / CLOSED without exit_price: current_stop is the only proxy
  // persisted (the candle close that triggered the exit is not stored).
  return isFinitePrice(op.current_stop) ? op.current_stop : null;
}

// Price of the TP1 partial. Both scanner loops write tp1_hit_price as the
// theoretical op.tp1 level, so either field yields the same no-slippage proxy.
export function getTp1Price(op) {
  if (isFinitePrice(op.tp1_hit_price)) return op.tp1_hit_price;
  return isFinitePrice(op.tp1) ? op.tp1 : null;
}

// Position split frozen at creation (partial_percent). The runner is always
// the complement — buildTradeOpData writes runner_percent = 100 - partial, so
// deriving it here is equivalent for well-formed docs and keeps the two legs
// summing to exactly 100% of the position even on corrupted/edited docs.
export function getWeights(op) {
  const partial = Number.isFinite(op.partial_percent) ? op.partial_percent / 100 : 0.5;
  return { partial, runner: 1 - partial };
}

// Realized result in price units (signed by side). With tp1_hit the two legs
// are weighted regardless of the final status — a runner that later stopped at
// breakeven, invalidated or time-stopped still keeps the banked partial. If
// the TP1 price is unrecoverable (corrupted doc) the op degrades to a plain
// 100%-at-exit result instead of dropping out of the stats entirely.
// `costModel` defaults to the real cost (see DEFAULT_COST_MODEL's comment);
// pass ZERO_COST for the gross result. The cost is subtracted AFTER the signed
// gross delta, so it always works against the trader on both sides.
function calcRealizedDelta(op, costModel) {
  if (!isClosedOp(op) || !isFinitePrice(op.entry_price)) return null;
  const exit = getExitPrice(op);
  if (exit === null) return null;
  const sign = op.side === 'SELL' ? -1 : 1;
  let gross;
  const tp1Price = op.tp1_hit ? getTp1Price(op) : null;
  if (tp1Price !== null) {
    const { partial, runner } = getWeights(op);
    gross = sign * (partial * (tp1Price - op.entry_price) + runner * (exit - op.entry_price));
  } else {
    gross = sign * (exit - op.entry_price);
  }
  return gross - calcTradeCost(op, costModel).total;
}

export function calcRealizedPnlPct(op, costModel) {
  const delta = calcRealizedDelta(op, costModel);
  return delta === null ? null : (delta / op.entry_price) * 100;
}

export function calcRealizedR(op, costModel) {
  const delta = calcRealizedDelta(op, costModel);
  if (delta === null || !isFinitePrice(op.initial_stop)) return null;
  const risk = Math.abs(op.entry_price - op.initial_stop);
  return risk === 0 ? null : delta / risk;
}

// R the op WOULD have realized closing 100% of the position at TP1, for ops
// that provably reached it. Not a hypothetical price path: `tp1_hit` is an
// observed fact and TP1 is a known level, so this is a counterfactual on
// position management only — never on price, and never look-ahead.
//
// Exists because the runner (the leg left running past TP1) is the one piece
// of exit geometry no phase ever measured. Comparing this against
// calcRealizedR(op, ZERO_COST) — gross against gross, the ONLY honest pairing
// — attributes exactly what the runner added or subtracted. See
// backtestAnalysis.js `runner` and docs/known-risks.md item 46.
//
// Same risk denominator as calcRealizedR so the two are directly comparable.
export function calcRAtTp1(op) {
  if (!op?.tp1_hit || !isFinitePrice(op.entry_price) || !isFinitePrice(op.initial_stop)) return null;
  const tp1Price = getTp1Price(op);
  if (tp1Price === null) return null;
  const risk = Math.abs(op.entry_price - op.initial_stop);
  if (risk === 0) return null;
  const sign = op.side === 'SELL' ? -1 : 1;
  return (sign * (tp1Price - op.entry_price)) / risk;
}

// Cost expressed in R — THE number that decides whether an edge was ever real.
// A config showing +0.15R expectancy with 0.20R of cost per trade is negative,
// and before Fase 5 that fact was invisible. Uses the SAME initial-stop risk
// denominator as calcRealizedR so the two are directly comparable.
export function calcCostR(op, costModel) {
  if (!isClosedOp(op) || !isFinitePrice(op.entry_price) || !isFinitePrice(op.initial_stop)) return null;
  const risk = Math.abs(op.entry_price - op.initial_stop);
  if (risk === 0) return null;
  return calcTradeCost(op, costModel).total / risk;
}

// WIN/LOSS/BE by realized result, preferring R (epsilon band: |r| ≤ 0.05R is
// a scratch trade). Ops without a usable R (legacy docs missing initial_stop,
// zero risk) fall back to the same rule over PnL% — never to status-based
// classification, which is the inconsistency this module removes.
/** @param {object} op @param {{ epsilonR?: number, epsilonPct?: number, costModel?: CostModel }} [options] */
export function classifyOutcome(op, { epsilonR = 0.05, epsilonPct = 0.1, costModel } = {}) {
  if (!isClosedOp(op)) return 'OPEN';
  const r = calcRealizedR(op, costModel);
  if (r !== null) {
    if (r > epsilonR) return 'WIN';
    if (r < -epsilonR) return 'LOSS';
    return 'BE';
  }
  const pnl = calcRealizedPnlPct(op, costModel);
  if (pnl !== null) {
    if (pnl > epsilonPct) return 'WIN';
    if (pnl < -epsilonPct) return 'LOSS';
    return 'BE';
  }
  return 'UNKNOWN';
}

// Additive helper, not used by summarizeOps itself (which keeps the fixed
// z=1.96 95% CI used everywhere else in the project — see expectancyRCI95
// below). Lets a caller recompute the same expectancyR/expectancyRStdErr at
// a DIFFERENT confidence level without re-deriving the samples — e.g. a
// Bonferroni-corrected z for a report that's really m>1 simultaneous
// comparisons of the same underlying hypothesis (docs/known-risks.md item
// 56 "Modo sombra": the RF-1h-conditional cascade's shadow expectancy
// competes with the still-open Bloco 0 question about native RF, so m=2 →
// two-sided z≈2.24 at alpha=0.05/2 instead of the usual 1.96).
export function expectancyCIAtZ(expectancyR, expectancyRStdErr, z) {
  if (expectancyR === null || expectancyRStdErr === null) return null;
  return [expectancyR - z * expectancyRStdErr, expectancyR + z * expectancyRStdErr];
}

// Aggregate a raw op list (open ops are filtered out here) into the numbers
// every performance surface renders. winRate = wins/(wins+losses+be) is THE
// win-rate definition — no per-screen denominators. The equity curve orders
// by close time (sortBy 'created' opts back into creation order); profitFactor
// is null when there are no losses (render '∞').
/**
 * @typedef {object} CostModel
 * @property {number} [feeBpsEntry]
 * @property {number} [feeBpsExit]
 * @property {number} [slippageBpsPerSide]
 * @property {number} [fundingBpsPer8h]
 * @property {boolean} [applied]
 */

/**
 * @param {Array<object>} ops
 * @param {{ epsilonR?: number, epsilonPct?: number, sortBy?: string, costModel?: CostModel, minTrades?: number }} [options]
 */
export function summarizeOps(ops, {
  epsilonR = 0.05, epsilonPct = 0.1, sortBy = 'closed', costModel, minTrades = 30,
} = {}) {
  const closed = (ops || []).filter(isClosedOp);
  const keyOf = sortBy === 'created'
    ? (op) => op.created_date ?? ''
    : (op) => getClosedAt(op) ?? '';
  closed.sort((a, b) => (keyOf(a) > keyOf(b) ? 1 : keyOf(a) < keyOf(b) ? -1 : 0));

  const curve = [];
  let wins = 0; let losses = 0; let be = 0; let unknown = 0;
  let totalPnlPct = 0; let grossProfit = 0; let grossLoss = 0;
  let sumWinPct = 0; let sumLossPct = 0;
  let sumWinR = 0; let sumLossR = 0; let winsWithR = 0; let lossesWithR = 0;
  let sumR = 0; let rCounted = 0;
  let cumulativePct = 0; let peak = 0; let maxDrawdownPct = 0;
  let totalCostPct = 0; let sumCostR = 0; let costRCounted = 0;
  let sumGrossR = 0; let grossRCounted = 0;
  const rSamples = [];

  for (const op of closed) {
    const outcome = classifyOutcome(op, { epsilonR, epsilonPct, costModel });
    const pnlPct = calcRealizedPnlPct(op, costModel);
    const r = calcRealizedR(op, costModel);
    // Custo e resultado bruto, medidos em paralelo ao líquido — é a comparação
    // que mostra quanto da "vantagem" era só ausência de custo (item 44).
    const cost = calcTradeCost(op, costModel);
    if (isFinitePrice(op.entry_price)) totalCostPct += (cost.total / op.entry_price) * 100;
    const costR = calcCostR(op, costModel);
    if (costR !== null) { sumCostR += costR; costRCounted += 1; }
    const grossR = calcRealizedR(op, ZERO_COST);
    if (grossR !== null) { sumGrossR += grossR; grossRCounted += 1; }
    if (outcome === 'UNKNOWN') {
      unknown += 1;
      curve.push({ op, pnlPct: null, r: null, cumulativePct, outcome });
      continue;
    }
    if (outcome === 'WIN') wins += 1;
    else if (outcome === 'LOSS') losses += 1;
    else be += 1;

    totalPnlPct += pnlPct;
    if (pnlPct > 0) grossProfit += pnlPct;
    else grossLoss += -pnlPct;
    if (outcome === 'WIN') sumWinPct += pnlPct;
    if (outcome === 'LOSS') sumLossPct += -pnlPct;
    if (r !== null) {
      sumR += r;
      rCounted += 1;
      rSamples.push(r);
      if (outcome === 'WIN') { sumWinR += r; winsWithR += 1; }
      if (outcome === 'LOSS') { sumLossR += -r; lossesWithR += 1; }
    }
    cumulativePct += pnlPct;
    peak = Math.max(peak, cumulativePct);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak - cumulativePct);
    curve.push({ op, pnlPct, r, cumulativePct, outcome });
  }

  const counted = wins + losses + be;
  const expectancyR = rCounted > 0 ? sumR / rCounted : null;

  // Gate de amostra (Fase 5, item 44). Precisão de uma média escala com 1/√N e
  // não existe técnica que escape disso: detectar expectância de 0.25R exige
  // ~181 operações; 0.10R exige ~1.130 (cálculo de poder em known-risks 44).
  // minTrades=30 é APENAS o limiar do Teorema Central do Limite — o ponto em
  // que a média amostral fica aproximadamente normal e um IC PODE ser
  // calculado. NÃO é o ponto em que o IC fica estreito o bastante para
  // decidir. Um relatório com counted >= 30 e IC cruzando zero continua
  // inconclusivo, e é isso que `conclusive` reporta.
  let expectancyRStdErr = null;
  let expectancyRCI95 = null;
  if (rCounted > 1 && expectancyR !== null) {
    const variance = rSamples.reduce((acc, x) => acc + (x - expectancyR) ** 2, 0) / (rCounted - 1);
    expectancyRStdErr = Math.sqrt(variance / rCounted);
    expectancyRCI95 = [expectancyR - 1.96 * expectancyRStdErr, expectancyR + 1.96 * expectancyRStdErr];
  }

  let inconclusiveReason = null;
  if (counted < minTrades) inconclusiveReason = 'sample_too_small';
  else if (expectancyRCI95 === null) inconclusiveReason = 'no_r_samples';
  else if (expectancyRCI95[0] <= 0 && expectancyRCI95[1] >= 0) inconclusiveReason = 'ci_straddles_zero';

  return {
    total: closed.length,
    counted,
    unknown,
    wins,
    losses,
    be,
    winRate: counted > 0 ? (wins / counted) * 100 : 0,
    totalPnlPct,
    avgWinPct: wins > 0 ? sumWinPct / wins : 0,
    avgLossPct: losses > 0 ? sumLossPct / losses : 0,
    avgWinR: winsWithR > 0 ? sumWinR / winsWithR : null,
    avgLossR: lossesWithR > 0 ? sumLossR / lossesWithR : null,
    expectancyR,
    rCounted,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdownPct,
    // Fase 5 — custo e honestidade estatística.
    totalCostPct,
    avgCostR: costRCounted > 0 ? sumCostR / costRCounted : null,
    grossExpectancyR: grossRCounted > 0 ? sumGrossR / grossRCounted : null,
    expectancyRStdErr,
    expectancyRCI95,
    conclusive: inconclusiveReason === null,
    inconclusiveReason,
    minTrades,
    curve,
  };
}
