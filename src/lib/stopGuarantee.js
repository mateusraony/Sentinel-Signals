/**
 * "Se o preço voltar e bater no stop AGORA, com quanto a operação fecha?" (aba Trades, docs/known-risks.md item 303).
 *
 * Pedido do usuário (13/11/2026): o cartão dizia "Stop 🔒" e "proteção aumentada", mas nunca QUANTO está protegido. Este módulo
 * só faz a conta — não decide nada, não é lido pelo motor e não muda nenhuma operação.
 *
 * Reusa a fonte única do resultado (`tradeMetrics.js`): monta a MESMA operação como se tivesse fechado no stop atual e pede o
 * resultado BRUTO (`ZERO_COST`). Assim a parcela já realizada no TP1 entra com o mesmo peso (`partial_percent`) que o Histórico
 * usa, sem uma segunda fórmula para divergir.
 *
 * Limites honestos (o cartão repete na dica): é bruto (sem taxa/funding) e supõe saída exatamente no preço do stop — o stop do
 * Sentinel é virtual e, se o preço pular o nível (gap), o resultado real é pior.
 */
import { calcRealizedPnlPct, calcRealizedR, getTp1Price, getWeights, ZERO_COST } from './tradeMetrics.js';

const OPEN_STATUSES = new Set(['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE']);

/** Abaixo disso (em % da entrada) o resultado é tratado como zero a zero: ruído de ponto flutuante não vira "lucro". */
export const ZERO_BAND_PCT = 1e-4;

const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * @param {object} op operação ABERTA (SIGNAL_CONFIRMED ou RUNNER_ACTIVE)
 * @returns {null | {
 *   kind: 'profit'|'zero'|'loss',
 *   pct: number,              // resultado bruto da posição inteira, em % da entrada (com sinal)
 *   r: number|null,           // o mesmo em múltiplos do risco inicial; null sem `initial_stop` utilizável
 *   stop: number,             // o stop usado na conta (`current_stop`)
 *   includesTp1: boolean,     // true quando a conta já soma a parcela realizada no TP1
 *   tp1SharePct: number|null, // % da posição realizada no TP1 (só quando `includesTp1`)
 * }} `null` para operação fechada, lado desconhecido ou preço inutilizável — o cartão simplesmente não mostra a frase.
 */
export function stopOutcomeIfHit(op) {
  if (!op || typeof op !== 'object') return null;
  if (!OPEN_STATUSES.has(op.status)) return null;
  if (op.side !== 'BUY' && op.side !== 'SELL') return null;
  if (!isPrice(op.entry_price) || !isPrice(op.current_stop)) return null;

  const closedAtStop = { ...op, status: 'STOP_HIT', exit_price: op.current_stop };
  const pct = calcRealizedPnlPct(closedAtStop, ZERO_COST);
  if (pct === null || !Number.isFinite(pct)) return null;
  const r = calcRealizedR(closedAtStop, ZERO_COST);

  const includesTp1 = op.tp1_hit === true && getTp1Price(op) !== null;
  const kind = Math.abs(pct) <= ZERO_BAND_PCT ? 'zero' : pct > 0 ? 'profit' : 'loss';

  return {
    kind,
    pct: kind === 'zero' ? 0 : pct,
    r: r !== null && Number.isFinite(r) ? (kind === 'zero' ? 0 : r) : null,
    stop: op.current_stop,
    includesTp1,
    tp1SharePct: includesTp1 ? Math.round(getWeights(op).partial * 100) : null,
  };
}

/**
 * "+0.48R" / "-1.00R" / "0.00R" — mesma escrita de número do resto do painel (`formatSignedPct`, `priceProximity.js`): ponto
 * decimal e "+" só no positivo. `null` sem R.
 */
export function formatSignedR(r, digits = 2) {
  return typeof r === 'number' && Number.isFinite(r) ? `${r > 0 ? '+' : ''}${r.toFixed(digits)}R` : null;
}
