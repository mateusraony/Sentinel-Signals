// Diagnóstico do stop furado por gap (docs/known-risks.md itens 192/260/261).
//
// O motor registra toda saída por stop NO PRÓPRIO STOP (`exit_price =
// op.current_stop`, scanner.js) — mesmo quando o candle de saída já ABRE do
// outro lado do stop, isto é, quando o mercado nunca negociou no nível do
// stop e a ordem real sairia pior. Isso é otimista e não é tratado; este
// módulo só MEDE o tamanho do efeito num backtest, sem mudar preenchimento
// nenhum. Decidir se o motor passa a preencher na abertura é do usuário,
// depois de ver este número.
//
// O que é medido: para cada operação STOP_HIT, o candle de saída (o do
// timeframe de gestão, `signal_timeframe`, achado pelo fechamento gravado em
// `stop_hit_real_time`). Se a ABERTURA dele já estava além do preço de saída
// registrado, a diferença em R — ponderada pela fração da posição que saiu no
// stop (o runner, quando o TP1 já tinha realizado a parcial) — é o quanto o
// relatório ficou otimista nessa operação, supondo preenchimento na abertura.
//
// Limites (honestos):
// - É um PISO: só pega o gap na fronteira do candle. Um gap DENTRO do candle
//   (abriu acima do stop e despencou sem negociar nele) não aparece no OHLC.
// - É R BRUTO: não refaz o custo de saída (taxa/slippage em bps sobre o preço
//   de saída), que mudaria um pouco com o preço novo.
// - Candle não encontrado é contado à parte (`unresolved`), nunca adivinhado.
import { getExitPrice, getWeights } from './tradeMetrics.js';

const MAX_SAMPLES = 10;

// Busca binária pelo candle cujo closeTime é EXATAMENTE `closeMs` (a série
// vem ordenada por tempo — garantido pela checagem de integridade do item
// 260). Devolve também o candle anterior, usado para separar "o preço pulou o
// stop na virada do candle" de "o stop foi colocado além do preço" (ex.: stop
// movido para a entrada no TP1 com o preço já abaixo dela).
export function findCandleByCloseTime(series, closeMs) {
  if (!Array.isArray(series)) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = series[mid]?.closeTime;
    if (t === closeMs) return { candle: series[mid], prev: mid > 0 ? series[mid - 1] : null };
    if (t < closeMs) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

const round = (x) => +x.toFixed(4);

/**
 * @param {Array<object>} ops operações avaliadas do relatório
 * @param {{ seriesFor?: (symbol: string, timeframe: string) => Array<object>, countedOps?: number }} [options]
 */
export function diagnoseStopGaps(ops, { seriesFor, countedOps } = {}) {
  const phases = () => ({ stopExits: 0, withGap: 0, totalGapR: 0 });
  const byPhase = { pre_tp1: phases(), runner: phases() };
  const unresolved = { count: 0, byReason: {} };
  const gapped = [];
  let stopExits = 0;
  let prevCloseBeyondStop = 0;

  const markUnresolved = (reason) => {
    unresolved.count += 1;
    unresolved.byReason[reason] = (unresolved.byReason[reason] || 0) + 1;
  };

  for (const op of ops || []) {
    if (op?.status !== 'STOP_HIT') continue;
    stopExits += 1;
    const phase = op.tp1_hit ? 'runner' : 'pre_tp1';
    byPhase[phase].stopExits += 1;

    const closeMs = Date.parse(op.stop_hit_real_time);
    if (!Number.isFinite(closeMs)) { markUnresolved('no_exit_candle_time'); continue; }
    const risk = Math.abs(op.entry_price - op.initial_stop);
    if (!Number.isFinite(risk) || risk <= 0) { markUnresolved('no_initial_risk'); continue; }
    const exit = getExitPrice(op);
    if (!Number.isFinite(exit)) { markUnresolved('no_exit_price'); continue; }
    const timeframe = op.signal_timeframe || '4h';
    const found = findCandleByCloseTime(seriesFor?.(op.symbol, timeframe), closeMs);
    if (!found || !Number.isFinite(found.candle.open)) { markUnresolved('candle_not_found'); continue; }

    const isBuy = op.side === 'BUY';
    const gapPrice = isBuy ? exit - found.candle.open : found.candle.open - exit;
    if (!(gapPrice > 0)) continue;

    // Fração da posição que saiu no stop: inteira antes do TP1; só o runner
    // depois dele (a parcial já foi realizada no TP1). Mesma fonte de pesos
    // que o cálculo de R do relatório (tradeMetrics.getWeights).
    const weight = op.tp1_hit ? getWeights(op).runner : 1;
    const gapR = (gapPrice / risk) * weight;
    const prevClose = found.prev?.close;
    const stopWasBeyondPrevClose = Number.isFinite(prevClose)
      && (isBuy ? prevClose < exit : prevClose > exit);
    if (stopWasBeyondPrevClose) prevCloseBeyondStop += 1;

    byPhase[phase].withGap += 1;
    byPhase[phase].totalGapR += gapR;
    gapped.push({
      id: op.id, symbol: op.symbol, side: op.side, phase, timeframe,
      exitCandleCloseTime: op.stop_hit_real_time,
      exitPriceRecorded: exit, exitCandleOpen: found.candle.open,
      gapR: round(gapR), stopWasBeyondPrevClose,
    });
  }

  const resolved = stopExits - unresolved.count;
  const totalGapR = gapped.reduce((sum, g) => sum + g.gapR, 0);
  const counted = Number.isFinite(countedOps) && countedOps > 0 ? countedOps : null;
  for (const phase of Object.values(byPhase)) phase.totalGapR = round(phase.totalGapR);

  return {
    stopExits,
    resolved,
    withGap: gapped.length,
    gapRate: resolved > 0 ? round(gapped.length / resolved) : null,
    totalGapR: round(totalGapR),
    avgGapR: gapped.length > 0 ? round(totalGapR / gapped.length) : null,
    maxGapR: gapped.length > 0 ? Math.max(...gapped.map((g) => g.gapR)) : null,
    // Quanto a expectância (R por operação contada) cairia se toda saída com
    // gap fosse preenchida na abertura do candle — PISO, bruto, ver o topo.
    expectancyRDeltaIfFilledAtOpen: counted ? round(-totalGapR / counted) : null,
    // Quantas das saídas com gap tinham o stop ALÉM do fechamento anterior
    // (stop colocado onde o preço já não estava) — causa diferente de um
    // salto do preço na virada do candle.
    prevCloseBeyondStop,
    byPhase,
    unresolved,
    samples: [...gapped].sort((a, b) => b.gapR - a.gapR).slice(0, MAX_SAMPLES),
  };
}
