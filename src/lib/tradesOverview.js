/**
 * Filtros e resumo do topo da aba Trades (docs/known-risks.md item 304).
 *
 * Tirado de dentro do JSX de `src/pages/Trades.jsx`, onde não era testável e tinha dois defeitos reais:
 *  1. o filtro "1H / 4H / 1D" comparava com `TradeOperation.timeframe`, que é o gráfico da ENTRADA ('15m'/'5m'), não o do
 *     aviso ('4h'/'1h') — escolher "4H" escondia TODAS as operações da cascata (o mesmo defeito que o Histórico já tinha
 *     corrigido com `opSignalTimeframe`);
 *  2. com tudo escondido pelo filtro a tela dizia "Nenhuma operação ativa.", como se não houvesse nenhuma.
 *
 * Só exibição: não decide nada, não é lido pelo motor.
 */
import moment from 'moment';
import { opSignalTimeframe } from './tradeStory.js';
import { stopOutcomeIfHit } from './stopGuarantee.js';

export const EMPTY_FILTERS = Object.freeze({ search: '', timeframe: 'all', side: 'all', period: 'all' });

/** As opções de período, na ordem do seletor. `id` é o valor guardado no estado; `label` é o texto da tela. */
export const PERIOD_OPTIONS = Object.freeze([
  Object.freeze({ id: 'all', label: 'Todo o período' }),
  Object.freeze({ id: 'today', label: 'Hoje' }),
  Object.freeze({ id: 'week', label: 'Esta semana' }),
  Object.freeze({ id: 'month', label: 'Este mês' }),
  Object.freeze({ id: 'last_month', label: 'Mês passado' }),
  Object.freeze({ id: 'quarter', label: 'Este trimestre' }),
  Object.freeze({ id: 'year', label: 'Este ano' }),
]);

const text = (v) => (typeof v === 'string' ? v : '');

/** Quantos filtros estão ligados (0 = nenhum). Valor desconhecido/ausente conta como desligado. */
export function countActiveFilters(filters) {
  const f = filters ?? EMPTY_FILTERS;
  return (text(f.search).trim() ? 1 : 0)
    + (text(f.timeframe) && f.timeframe !== 'all' ? 1 : 0)
    + (text(f.side) && f.side !== 'all' ? 1 : 0)
    + (text(f.period) && f.period !== 'all' ? 1 : 0);
}

/**
 * Intervalo [from, to] de um período, no fuso do navegador (o mesmo recorte que a página já fazia com `moment`).
 * `null` = sem recorte ("Todo o período" ou valor desconhecido).
 * @param {string} period @param {number} [nowMs]
 */
export function periodRange(period, nowMs = Date.now()) {
  const now = moment(nowMs);
  const span = (unit, back = 0) => {
    const base = back ? now.clone().subtract(back, unit) : now.clone();
    return { from: base.clone().startOf(unit).toDate(), to: base.clone().endOf(unit).toDate() };
  };
  switch (period) {
    case 'today': return span('day');
    case 'week': return span('week');
    case 'month': return span('month');
    case 'last_month': return span('month', 1);
    case 'quarter': return span('quarter');
    case 'year': return span('year');
    default: return null;
  }
}

/** Lado de uma operação (`side`) ou de um aviso (`signal_type`). */
export function itemSide(item) {
  return item?.side || item?.signal_type || null;
}

/**
 * Aplica os filtros a uma lista de operações OU de avisos.
 * - Gráfico: o do AVISO (`opSignalTimeframe`: '4h'/'1h'), nunca o da entrada ('15m'/'5m'). Num aviso é o próprio `timeframe`.
 * - Período: pela data de criação. Item sem data válida só passa quando não há recorte de período.
 * @param {any[]} list operações ou avisos @param {typeof EMPTY_FILTERS} filters @param {{ nowMs?: number }} [opts] @returns {any[]}
 */
export function applyTradeFilters(list, filters, { nowMs = Date.now() } = {}) {
  if (!Array.isArray(list)) return [];
  const f = filters ?? EMPTY_FILTERS;
  const needle = text(f.search).trim().toLowerCase();
  const range = periodRange(f.period, nowMs);
  return list.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    if (text(f.timeframe) && f.timeframe !== 'all' && opSignalTimeframe(item) !== f.timeframe) return false;
    if (text(f.side) && f.side !== 'all' && itemSide(item) !== f.side) return false;
    if (needle && !text(item.symbol).toLowerCase().includes(needle)) return false;
    if (range) {
      const at = new Date(item.created_date).getTime();
      if (!Number.isFinite(at) || at < range.from.getTime() || at > range.to.getTime()) return false;
    }
    return true;
  });
}

/**
 * Resumo das operações ATIVAS para o topo da página: quantas, como está o stop de cada uma e o resultado somado se TODAS
 * baterem no stop agora (em R, bruto — a mesma conta de `stopOutcomeIfHit`, uma por operação).
 *
 * `stopSumR` só existe quando TODAS as operações têm R (stop inicial conhecido): somar só algumas daria um número que parece
 * o da carteira e não é. A soma em R supõe o mesmo risco por operação (o painel não guarda tamanho de posição).
 *
 * @param {object[]} activeOps
 * @returns {{ total: number, protectedCount: number, zeroCount: number, riskCount: number, unknownCount: number, stopSumR: number|null }}
 */
export function summarizeActiveOps(activeOps) {
  const ops = Array.isArray(activeOps) ? activeOps : [];
  let protectedCount = 0;
  let zeroCount = 0;
  let riskCount = 0;
  let unknownCount = 0;
  let sum = 0;
  let allHaveR = ops.length > 0;
  for (const op of ops) {
    const outcome = stopOutcomeIfHit(op);
    if (!outcome) { unknownCount += 1; allHaveR = false; continue; }
    if (outcome.kind === 'profit') protectedCount += 1;
    else if (outcome.kind === 'zero') zeroCount += 1;
    else riskCount += 1;
    if (outcome.r === null) allHaveR = false; else sum += outcome.r;
  }
  return { total: ops.length, protectedCount, zeroCount, riskCount, unknownCount, stopSumR: allHaveR ? sum : null };
}

/** "2 com lucro protegido · 1 com risco em jogo" — só as partes que existem; '' sem operação. */
export function describeActiveSummary(summary) {
  if (!summary) return '';
  const parts = [];
  if (summary.protectedCount) parts.push(`${summary.protectedCount} com lucro protegido`);
  if (summary.zeroCount) parts.push(`${summary.zeroCount} no zero a zero`);
  if (summary.riskCount) parts.push(`${summary.riskCount} com risco em jogo`);
  if (summary.unknownCount) parts.push(`${summary.unknownCount} sem stop legível`);
  return parts.join(' · ');
}
