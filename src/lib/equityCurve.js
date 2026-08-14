// Duas curvas de capital REAL, compostas — complementam (não substituem) a
// soma percentual ingênua de `summarizeOps.cumulativePct` (tradeMetrics.js),
// que soma pnlPct por operação sem nunca dimensionar posição nem compor
// capital, por isso nunca produziu um drawdown de CONTA real nem uma % que
// componha de verdade:
//
// - `simulateEquityCurve` — capital em USD, position sizing por RISCO
//   (arrisca X% do capital corrente por operação, dimensionado pelo
//   `initial_stop`). Uso: "quanto essa estratégia teria rendido numa conta
//   de $N com risco de X% por operação" (ver Backtest.jsx/Dashboard).
// - `compoundReturnCurve` — 100% do capital REALOCADO a cada operação (sem
//   `initial_stop`, sem R, só o pnlPct bruto de cada trade). Uso: comparar
//   a carteira contra um benchmark de mercado
//   (`src/lib/marketBenchmarks.js`, `PortfolioVsMarket.jsx`) — o benchmark
//   já É uma curva composta por natureza (retorno de preço/juros
//   compostos), então comparar contra a soma ingênua é enganoso (a
//   carteira parece "perder"/"ganhar" do mercado por um artefato de
//   composição, não por desempenho real).
//
// Módulo separado de tradeMetrics.js de propósito (mesmo padrão de
// backtestAnalysis.js: importa só a API pública, zero linha mudada no
// módulo mais crítico/mais testado do projeto). Toda a matemática de custo
// e de TP1+runner já vem embutida em `calcRealizedR`/`calcRealizedPnlPct` —
// este módulo nunca recalcula preço de TP1, pesos nem custo, só compõe
// capital em cima do que o chokepoint existente já calculou:
//
//   pnlDollars = R × (capitalCorrente × risco%)              [simulateEquityCurve]
//   fator *= 1 + pnlPct/100, por operação                    [compoundReturnCurve]
//
// Isso vale mesmo com custo aplicado, porque R/pnlPct já são líquidos de
// custo (calcRealizedR/calcRealizedPnlPct → calcRealizedDelta →
// calcTradeCost).
//
// Limitação deliberada nas DUAS: o laço assume um ÚNICO pool de capital
// disputado SEQUENCIALMENTE por ordem de fechamento — não modela posições
// concorrentes (o sistema real roda vários ativos monitorados ao mesmo
// tempo, com operações sobrepostas no tempo). Mesma simplificação que
// `summarizeOps.cumulativePct` já faz hoje (mesma ordenação por
// closed_at). Alocação de capital para posições sobrepostas é um problema
// mais complexo, fora de escopo desta rodada.
import {
  isClosedOp, getClosedAt, getOpenedAt, calcRealizedR, calcRealizedPnlPct, classifyOutcome,
} from './tradeMetrics.js';

export const DEFAULT_INITIAL_CAPITAL = 1000;
export const DEFAULT_RISK_PCT = 1;

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MIN_YEARS_FOR_CAGR = 30 / 365.25;

/**
 * @param {Array<object>} ops
 * @param {{ initialCapital?: number, riskPct?: number, epsilonR?: number,
 *   epsilonPct?: number, sortBy?: string, costModel?: import('./tradeMetrics.js').CostModel }} [options]
 */
export function simulateEquityCurve(ops, {
  initialCapital = DEFAULT_INITIAL_CAPITAL,
  riskPct = DEFAULT_RISK_PCT,
  epsilonR = 0.05,
  epsilonPct = 0.1,
  sortBy = 'closed',
  costModel,
} = {}) {
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    throw new Error('simulateEquityCurve: initialCapital deve ser um número finito > 0.');
  }
  if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > 100) {
    throw new Error('simulateEquityCurve: riskPct deve ser um número finito em (0, 100].');
  }

  const closed = (ops || []).filter(isClosedOp);
  const keyOf = sortBy === 'created'
    ? (op) => op.created_date ?? ''
    : (op) => getClosedAt(op) ?? '';
  closed.sort((a, b) => (keyOf(a) > keyOf(b) ? 1 : keyOf(a) < keyOf(b) ? -1 : 0));

  const riskFraction = riskPct / 100;
  let capital = initialCapital;
  let peakCapital = initialCapital;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  let accountBlown = false;
  let sized = 0;
  let unsized = 0;
  const curve = [];

  for (const op of closed) {
    const outcome = classifyOutcome(op, { epsilonR, epsilonPct, costModel });
    const r = calcRealizedR(op, costModel);
    const capitalBefore = capital;

    if (accountBlown || r === null) {
      unsized += 1;
      curve.push({
        op,
        outcome,
        r,
        capitalBefore,
        capitalAfter: capitalBefore,
        pnlDollars: 0,
        riskDollars: null,
        sized: false,
        reason: accountBlown ? 'account_blown' : 'unsized_no_r',
        peakCapital,
        drawdownAbs: maxDrawdownAbs,
        drawdownPct: maxDrawdownPct,
      });
      continue;
    }

    const riskDollars = capitalBefore * riskFraction;
    const pnlDollars = r * riskDollars;
    capital = capitalBefore + pnlDollars;
    if (capital <= 0) {
      capital = 0;
      accountBlown = true;
    }
    sized += 1;

    peakCapital = Math.max(peakCapital, capital);
    const drawdownAbs = peakCapital - capital;
    const drawdownPct = peakCapital > 0 ? (drawdownAbs / peakCapital) * 100 : 0;
    maxDrawdownAbs = Math.max(maxDrawdownAbs, drawdownAbs);
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);

    curve.push({
      op,
      outcome,
      r,
      capitalBefore,
      capitalAfter: capital,
      pnlDollars,
      riskDollars,
      sized: true,
      reason: null,
      peakCapital,
      drawdownAbs,
      drawdownPct,
    });
  }

  const finalCapital = capital;
  const totalReturnPct = ((finalCapital / initialCapital) - 1) * 100;

  const firstOpenedAt = closed.length > 0 ? getOpenedAt(closed[0]) : null;
  const lastClosedAt = closed.length > 0 ? getClosedAt(closed[closed.length - 1]) : null;
  let years = null;
  if (firstOpenedAt && lastClosedAt) {
    const startMs = new Date(firstOpenedAt).getTime();
    const endMs = new Date(lastClosedAt).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      years = (endMs - startMs) / MS_PER_YEAR;
    }
  }

  let cagrPct = null;
  let cagrUnavailableReason = null;
  if (accountBlown) {
    cagrUnavailableReason = 'account_blown';
  } else if (finalCapital <= 0) {
    cagrUnavailableReason = 'non_positive_final_capital';
  } else if (years === null) {
    cagrUnavailableReason = 'no_time_range';
  } else if (years < MIN_YEARS_FOR_CAGR) {
    cagrUnavailableReason = 'window_too_short';
  } else {
    cagrPct = (((finalCapital / initialCapital) ** (1 / years)) - 1) * 100;
  }

  return {
    initialCapital,
    riskPct,
    finalCapital,
    totalReturnPct,
    maxDrawdownAbs,
    maxDrawdownPct,
    accountBlown,
    years,
    cagrPct,
    cagrUnavailableReason,
    sized,
    unsized,
    total: closed.length,
    curve,
  };
}

// Segunda curva composta, mais simples: 100% do capital realocado a cada
// operação (não é dimensionamento por risco — sem `initial_stop`, sem
// unidades, sem R). Existe pra comparar a carteira contra um benchmark de
// mercado (`src/lib/marketBenchmarks.js`), que É uma curva composta por
// natureza (retorno de preço/juros compostos) — comparar isso contra a soma
// ingênua de `summarizeOps.cumulativePct` é enganoso (a carteira "perde" ou
// "ganha" do mercado por um artefato de composição, não por desempenho real).
// Devolve o MESMO formato de entrada de `summarizeOps().curve`
// (`{ op, outcome, pnlPct, cumulativePct }`) — troca direta em quem já
// consome aquele array, só o cálculo de `cumulativePct` muda.
/**
 * @param {Array<object>} ops
 * @param {{ epsilonR?: number, epsilonPct?: number, sortBy?: string, costModel?: import('./tradeMetrics.js').CostModel }} [options]
 */
export function compoundReturnCurve(ops, {
  epsilonR = 0.05,
  epsilonPct = 0.1,
  sortBy = 'closed',
  costModel,
} = {}) {
  const closed = (ops || []).filter(isClosedOp);
  const keyOf = sortBy === 'created'
    ? (op) => op.created_date ?? ''
    : (op) => getClosedAt(op) ?? '';
  closed.sort((a, b) => (keyOf(a) > keyOf(b) ? 1 : keyOf(a) < keyOf(b) ? -1 : 0));

  let factor = 1;
  const curve = [];
  for (const op of closed) {
    const outcome = classifyOutcome(op, { epsilonR, epsilonPct, costModel });
    const pnlPct = calcRealizedPnlPct(op, costModel);
    if (pnlPct === null) {
      curve.push({ op, outcome, pnlPct: null, cumulativePct: (factor - 1) * 100 });
      continue;
    }
    factor *= 1 + (pnlPct / 100);
    curve.push({ op, outcome, pnlPct, cumulativePct: (factor - 1) * 100 });
  }
  return curve;
}
