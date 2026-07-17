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
// Limitations (accepted — virtual trading, no real fills): no fees, funding
// or slippage; tp1_hit_price is written by both scanner loops as the
// THEORETICAL tp1 level, so the partial leg is a no-slippage proxy. A
// manually edited exit_price is respected as the user's declared truth.
import { isTerminalStatus } from './opTransition.js';

const isFinitePrice = (v) => Number.isFinite(v) && v > 0;

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
function calcRealizedDelta(op) {
  if (!isClosedOp(op) || !isFinitePrice(op.entry_price)) return null;
  const exit = getExitPrice(op);
  if (exit === null) return null;
  const sign = op.side === 'SELL' ? -1 : 1;
  if (op.tp1_hit) {
    const tp1Price = getTp1Price(op);
    if (tp1Price !== null) {
      const { partial, runner } = getWeights(op);
      return sign * (partial * (tp1Price - op.entry_price) + runner * (exit - op.entry_price));
    }
  }
  return sign * (exit - op.entry_price);
}

export function calcRealizedPnlPct(op) {
  const delta = calcRealizedDelta(op);
  return delta === null ? null : (delta / op.entry_price) * 100;
}

export function calcRealizedR(op) {
  const delta = calcRealizedDelta(op);
  if (delta === null || !isFinitePrice(op.initial_stop)) return null;
  const risk = Math.abs(op.entry_price - op.initial_stop);
  return risk === 0 ? null : delta / risk;
}

// WIN/LOSS/BE by realized result, preferring R (epsilon band: |r| ≤ 0.05R is
// a scratch trade). Ops without a usable R (legacy docs missing initial_stop,
// zero risk) fall back to the same rule over PnL% — never to status-based
// classification, which is the inconsistency this module removes.
export function classifyOutcome(op, { epsilonR = 0.05, epsilonPct = 0.1 } = {}) {
  if (!isClosedOp(op)) return 'OPEN';
  const r = calcRealizedR(op);
  if (r !== null) {
    if (r > epsilonR) return 'WIN';
    if (r < -epsilonR) return 'LOSS';
    return 'BE';
  }
  const pnl = calcRealizedPnlPct(op);
  if (pnl !== null) {
    if (pnl > epsilonPct) return 'WIN';
    if (pnl < -epsilonPct) return 'LOSS';
    return 'BE';
  }
  return 'UNKNOWN';
}

// Aggregate a raw op list (open ops are filtered out here) into the numbers
// every performance surface renders. winRate = wins/(wins+losses+be) is THE
// win-rate definition — no per-screen denominators. The equity curve orders
// by close time (sortBy 'created' opts back into creation order); profitFactor
// is null when there are no losses (render '∞').
export function summarizeOps(ops, { epsilonR = 0.05, epsilonPct = 0.1, sortBy = 'closed' } = {}) {
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

  for (const op of closed) {
    const outcome = classifyOutcome(op, { epsilonR, epsilonPct });
    const pnlPct = calcRealizedPnlPct(op);
    const r = calcRealizedR(op);
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
      if (outcome === 'WIN') { sumWinR += r; winsWithR += 1; }
      if (outcome === 'LOSS') { sumLossR += -r; lossesWithR += 1; }
    }
    cumulativePct += pnlPct;
    peak = Math.max(peak, cumulativePct);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak - cumulativePct);
    curve.push({ op, pnlPct, r, cumulativePct, outcome });
  }

  const counted = wins + losses + be;
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
    expectancyR: rCounted > 0 ? sumR / rCounted : null,
    rCounted,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdownPct,
    curve,
  };
}
