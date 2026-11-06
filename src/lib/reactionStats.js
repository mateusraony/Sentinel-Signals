// Contexto de Mercado — Agenda 4d, etapa 2 (docs/known-risks.md item 285, addendum 18): "como o BTC se mexeu nas últimas divulgações".
// Parte PURA e SÓ LEITURA: lê um arquivo de AGREGADOS medido fora do painel (src/data/reactionStats.json, saída da Medição da reação do BTC) e monta os
// textos. MEDIDO, NÃO PREVISTO: o texto mostra o TAMANHO do movimento (sem sinal), sempre com o número de casos e a data da medição; nunca diz "vai
// subir/cair", nem dá porcentagem de acerto, nem cor de "bom/ruim". O motor de trading não importa este módulo (tripwire).
import raw from '@/data/reactionStats.json';

/**
 * Critério escrito ANTES de ver os números (addendum 18): só se afirma que o tipo "costuma mexer mais que num dia normal" quando a mediana de 60 min dele
 * passa a de pelo menos 75% dos dias normais E é pelo menos 1,3 vez a do dia normal. Senão: "perto de um dia normal". Não ajustar depois de ver o resultado.
 */
export const REACTION_CRITERION = Object.freeze({ minRank: 0.75, minRatio: 1.3 });

const KINDS = ['NFP', 'CPI', 'PPI', 'PCE'];
const num = (x) => typeof x === 'number' && Number.isFinite(x);

function cleanGroup(g, keys) {
  if (!g || typeof g !== 'object') return null;
  if (!Number.isInteger(g.n) || g.n < 1) return null;
  for (const k of keys) if (!num(g[k]) || g[k] < 0) return null;
  return g;
}

/** Valida o arquivo inteiro; qualquer defeito = null (a tela simplesmente não mostra o bloco). */
export function parseReactionStats(json) {
  if (!json || typeof json !== 'object' || json.version !== 1) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(json.measuredAt ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(json.sinceDate ?? '')) return null;
  const normal = cleanGroup(json.normal, ['med5', 'med60']);
  if (!normal || normal.med60 <= 0) return null;
  const kinds = {};
  for (const k of KINDS) {
    const g = cleanGroup(json.kinds?.[k], ['med5', 'med60', 'ratio60', 'rank60']);
    if (g && g.rank60 <= 1) kinds[k] = g;
  }
  return { measuredAt: json.measuredAt, sinceDate: json.sinceDate, normal, kinds };
}

/** 'maior' (mexe mais que num dia normal, pelo critério) ou 'normal'. */
export function reactionVerdict(g) {
  return g.rank60 >= REACTION_CRITERION.minRank && g.ratio60 >= REACTION_CRITERION.minRatio ? 'maior' : 'normal';
}

const STATS = parseReactionStats(raw);

const pct = (x) => `${(Math.round(x * 100) / 100).toFixed(2).replace('.', ',')}%`;
const ratio = (x) => `${(Math.round(x * 10) / 10).toFixed(1).replace('.', ',')}×`;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthYear = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]}/${iso.slice(0, 4)}`;
const dayMonthYear = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * Textos do bloco para um tipo de evento (CPI, NFP, PPI, PCE); null para FOMC, tipo sem dado ou arquivo inválido.
 * `stats` é injetável só para teste.
 */
export function reactionNote(kind, stats = STATS) {
  const g = stats?.kinds?.[kind];
  if (!g) return null;
  const verdict = reactionVerdict(g);
  return {
    verdict,
    chip: verdict === 'maior' ? 'Costuma mexer mais que num dia normal' : 'Perto de um dia normal',
    cases: `${g.n} divulgações desde ${monthYear(stats.sinceDate)}`,
    hour: { value: pct(g.med60), normal: pct(stats.normal.med60), times: verdict === 'maior' ? ratio(g.ratio60) : null },
    first5: { value: pct(g.med5), normal: pct(stats.normal.med5) },
    measuredAt: dayMonthYear(stats.measuredAt),
  };
}
