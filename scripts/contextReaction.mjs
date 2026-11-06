// Contexto de Mercado — Agenda 4d, etapa 1 (docs/known-risks.md item 285, addendum 18): COMO O BTC SE MEXEU nas divulgações passadas
// (Payroll, CPI, PPI e PCE). Parte PURA: sem rede, sem Date.now, sem banco, sem dependência além da conversão de fuso.
//
// MEDIDO, NÃO PREVISTO. O relatório descreve o passado com o número de casos (N) sempre à vista; nunca diz "vai subir" nem "vai cair".
// Quatro limites que o texto do relatório repete: (1) o mercado reage ao que SURPREENDE em relação à expectativa, e a expectativa não
// está disponível de graça; (2) a hora da divulgação tem outras notícias e a abertura das bolsas por perto; (3) com poucos casos uma
// diferença pequena pode ser acaso; (4) correlação não é causa.
//
// Como se mede: referência = o fechamento da vela de 1 min que termina no instante da divulgação (08:30 de Nova York). O movimento em
// +5, +30 e +60 min é o fechamento da vela de 1 min que termina nesse instante, contra a referência. "Amplitude" = (maior máxima − menor
// mínima) dos 60 min seguintes, sobre a referência. Comparação ("dia normal"): o MESMO horário (08:30 de Nova York, o fuso resolve o
// horário de verão) em dias úteis sem divulgação — mesma hora do dia, mesmos 60 min, só sem o evento.
import { nyToUtc } from './contextTime.mjs';

const MIN = 60 * 1000;
export const OFFSETS_MIN = Object.freeze([5, 30, 60]);
/** 1 vela de referência (o minuto antes) + 60 velas da 1ª hora. */
export const WINDOW_CANDLES = 61;
export const RELEASE_CLOCK_NY = '08:30';
/** Abaixo disto o relatório diz "amostra pequena". */
export const SMALL_SAMPLE = 30;
/** Menos dias normais com dado que isto = comparação sem base (o relatório nem sai). */
export const MIN_NORMAL_DAYS = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Velas de 1 min da Binance (`/api/v3/klines`) → `{ t, o, h, l, c }` (números), em ordem; null se o corpo não serve. */
export function parseKlines(body) {
  let j;
  try { j = typeof body === 'string' ? JSON.parse(body) : body; } catch { return null; }
  if (!Array.isArray(j)) return null;
  const out = [];
  for (const k of j) {
    if (!Array.isArray(k) || k.length < 7) return null;
    const [t, o, h, l, c] = [Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4])];
    if (![t, o, h, l, c].every(Number.isFinite) || o <= 0 || h <= 0 || l <= 0 || c <= 0 || h < l) return null;
    out.push({ t, o, h, l, c });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Dia da semana (0 = domingo) de uma data de calendário AAAA-MM-DD, sem depender de fuso. */
function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** Instante UTC (ms) de 08:30 em Nova York na data; null se a data não existe ou o horário não existe nela. `nyToUtc` devolve um OBJETO `{ iso, ms }`. */
function nyMs(date) {
  try { return nyToUtc(date, RELEASE_CLOCK_NY)?.ms ?? null; } catch { return null; }
}

/**
 * Instantes (UTC) das divulgações passadas a partir das datas do FRED: cada data às 08:30 de Nova York. Só entra divulgação que já
 * terminou a janela de medição (≥ 61 min atrás) e que não é anterior a `sinceDate`. Ordem crescente.
 * @param {Record<string, string[]|null>} datesByKind
 */
export function releaseInstants(datesByKind, { sinceDate, nowMs }) {
  const out = [];
  for (const [kind, dates] of Object.entries(datesByKind ?? {})) {
    for (const date of Array.isArray(dates) ? dates : []) {
      if (!DATE_RE.test(date) || (sinceDate && date < sinceDate)) continue;
      const ms = nyMs(date);
      if (ms === null || ms + WINDOW_CANDLES * MIN > nowMs) continue;
      out.push({ kind, date, ms });
    }
  }
  return out.sort((a, b) => a.ms - b.ms || a.kind.localeCompare(b.kind));
}

/**
 * Os `count` dias úteis (em Nova York) SEM divulgação, ESPALHADOS por todo o período desde `sinceDate` (do mais antigo ao mais recente, incluindo os dois
 * extremos), no mesmo horário das divulgações. Espalhar importa: pegar só os mais recentes comparava divulgações de 2024-2026 com um trecho curto de 2026, e a
 * volatilidade do BTC muda com o período (achado na 1ª execução real, 06/11/2026). Com menos dias elegíveis que `count`, devolve todos.
 */
export function normalDayInstants({ eventDates, nowMs, count, sinceDate = '2000-01-01' }) {
  const days = new Set(eventDates);
  const todayNy = new Date(nowMs - 6 * 3600 * 1000).toISOString().slice(0, 10); // dia de Nova York com folga; os recentes demais caem fora abaixo
  const eligible = [];
  for (let date = addDays(todayNy, -1); date >= sinceDate; date = addDays(date, -1)) {
    const wd = weekdayOf(date);
    if (wd === 0 || wd === 6 || days.has(date)) continue;
    const ms = nyMs(date);
    if (ms === null || ms + WINDOW_CANDLES * MIN > nowMs) continue;
    eligible.push({ kind: 'NORMAL', date, ms });
  }
  eligible.sort((x, y) => x.ms - y.ms);
  if (eligible.length <= count || count < 1) return eligible;
  if (count === 1) return [eligible[eligible.length - 1]];
  return Array.from({ length: count }, (_, i) => eligible[Math.floor((i * (eligible.length - 1)) / (count - 1))]);
}

/**
 * Movimento do BTC depois de `t0Ms`. Devolve `{ moves: {5, 30, 60}, rangePct }` (em %), ou null se faltar QUALQUER vela da janela
 * (nunca se completa com vizinha: um buraco no dado não vira número).
 */
export function reactionAt(candles, t0Ms, offsets = OFFSETS_MIN) {
  const byOpen = new Map((candles ?? []).map((c) => [c.t, c]));
  const ref = byOpen.get(t0Ms - MIN);
  if (!ref) return null;
  const moves = {};
  for (const n of offsets) {
    const c = byOpen.get(t0Ms + (n - 1) * MIN);
    if (!c) return null;
    moves[n] = (c.c / ref.c - 1) * 100;
  }
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = 0; i < WINDOW_CANDLES - 1; i += 1) {
    const c = byOpen.get(t0Ms + i * MIN);
    if (!c) return null;
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
  }
  return { moves, rangePct: ((hi - lo) / ref.c) * 100 };
}

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Fração (0..1) dos valores de `sorted` estritamente menores que `x`; null sem dados. */
export function percentRank(values, x) {
  const v = values.filter(Number.isFinite);
  if (!v.length || !Number.isFinite(x)) return null;
  return v.filter((y) => y < x).length / v.length;
}

/**
 * Resumo de um grupo de reações. `rows` = `{ date, reaction }`; reação null = sem dado (conta em `noData`, nunca entra nas medianas).
 * `up60`/`down60` são só contagem do sinal do movimento de 60 min (zero exato não conta em nenhum).
 */
export function summarizeGroup(rows) {
  const ok = rows.filter((r) => r.reaction);
  const abs = (n) => ok.map((r) => Math.abs(r.reaction.moves[n]));
  return {
    total: rows.length,
    n: ok.length,
    noData: rows.length - ok.length,
    medAbs: Object.fromEntries(OFFSETS_MIN.map((n) => [n, median(abs(n))])),
    medRange: median(ok.map((r) => r.reaction.rangePct)),
    up60: ok.filter((r) => r.reaction.moves[60] > 0).length,
    down60: ok.filter((r) => r.reaction.moves[60] < 0).length,
    abs60: abs(60),
  };
}

/** Compara o grupo de um tipo com o dos dias normais: razão das medianas de 60 min e posição da mediana do tipo entre os dias normais. */
export function compareToNormal(group, normal) {
  const ratio = group.medAbs[60] !== null && normal.medAbs[60] ? group.medAbs[60] / normal.medAbs[60] : null;
  return { ratio60: ratio, rank60: percentRank(normal.abs60, group.medAbs[60]) };
}

const BR = (x, d = 2) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d).replace('.', ',');
const pct = (x) => (x === null ? 'sem dado' : `${BR(x)}%`);
const signed = (x) => `${x > 0 ? '+' : x < 0 ? '-' : ''}${BR(Math.abs(x))}%`;

const KIND_LABEL = Object.freeze({ NFP: 'Payroll (emprego)', CPI: 'CPI (inflação ao consumidor)', PPI: 'PPI (inflação ao produtor)', PCE: 'PCE (gastos pessoais)' });
export const REPORT_NOTE = [
  'Como ler: isto é um retrato do PASSADO, com o número de casos ao lado. Não é previsão e não diz para onde o BTC vai.',
  '- O mercado reage ao que SURPREENDE em relação à expectativa dos analistas, e não temos essa expectativa de graça: aqui não se separa "veio acima/abaixo do esperado".',
  '- Na mesma hora saem outras notícias e as bolsas dos EUA estão perto de abrir; o movimento não é só da divulgação. Correlação não é causa.',
  `- Com menos de ${SMALL_SAMPLE} casos uma diferença pequena pode ser acaso; as colunas "subiu/caiu" são só contagem, sem tendência.`,
].join('\n');

/**
 * Relatório em Markdown (português simples, sem emoji).
 * @param {{ perKind: Record<string, {group: object, vsNormal: object}>, normal: object, generatedAtMs: number, sinceDate: string }} r
 */
export function formatReport({ perKind, normal, generatedAtMs, sinceDate }) {
  const lines = [
    '## Como o BTC se mexeu nas divulgações passadas dos EUA',
    `Medido em ${new Date(generatedAtMs).toISOString().slice(0, 16).replace('T', ' ')} UTC, divulgações desde ${sinceDate}. Velas de 1 minuto do BTC/USDT (Binance Spot).`,
    '',
    '| Tipo | Casos (com dado / total) | Mediana 5 min | Mediana 30 min | Mediana 60 min | Amplitude da 1ª hora | Subiu / caiu em 60 min | Mediana 60 min vs. dia normal | Posição entre os dias normais |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const [kind, { group, vsNormal }] of Object.entries(perKind)) {
    const small = group.n < SMALL_SAMPLE ? ' (amostra pequena)' : '';
    lines.push(`| ${KIND_LABEL[kind] ?? kind} | ${group.n} / ${group.total}${small} | ${pct(group.medAbs[5])} | ${pct(group.medAbs[30])} | ${pct(group.medAbs[60])} | ${pct(group.medRange)} | ${group.up60} / ${group.down60} | ${vsNormal.ratio60 === null ? 'sem dado' : `${BR(vsNormal.ratio60, 1)}x`} | ${vsNormal.rank60 === null ? 'sem dado' : `maior que ${Math.round(vsNormal.rank60 * 100)}% dos dias normais`} |`);
  }
  lines.push(`| Dia normal (mesmo horário, dia útil sem divulgação, espalhado pelo mesmo período) | ${normal.n} / ${normal.total} | ${pct(normal.medAbs[5])} | ${pct(normal.medAbs[30])} | ${pct(normal.medAbs[60])} | ${pct(normal.medRange)} | ${normal.up60} / ${normal.down60} | 1,0x | referência |`);
  lines.push('', 'Os valores das medianas são o tamanho do movimento (sem o sinal). "Subiu / caiu" conta quantas vezes o BTC estava acima / abaixo da referência 60 minutos depois.', '', REPORT_NOTE);
  return lines.join('\n');
}

/** Meses com 2 ou mais datas do MESMO tipo (ex.: revisão anual ou remarcação do FRED, que não é a divulgação principal): "CPI 2024-02". */
export function monthsWithTwoDates(rowsByKind) {
  const out = [];
  for (const [kind, rows] of Object.entries(rowsByKind)) {
    const count = new Map();
    for (const r of rows) count.set(r.date.slice(0, 7), (count.get(r.date.slice(0, 7)) ?? 0) + 1);
    for (const [month, n] of [...count].sort()) if (n > 1) out.push(`${kind} ${month}`);
  }
  return out;
}

/** Por ano: divulgações (todos os tipos juntos) contra os dias normais do MESMO ano, para ver se a diferença é do período ou da divulgação. */
export function formatYearTable(eventRows, normalRows) {
  const years = [...new Set([...eventRows, ...normalRows].map((r) => r.date.slice(0, 4)))].sort();
  const lines = ['', '### Por ano (todos os tipos juntos)', '', '| Ano | Divulgações (casos) | Mediana 60 min | Dias normais (casos) | Mediana 60 min | Razão |', '|---|---:|---:|---:|---:|---:|'];
  for (const y of years) {
    const ev = summarizeGroup(eventRows.filter((r) => r.date.startsWith(y)));
    const no = summarizeGroup(normalRows.filter((r) => r.date.startsWith(y)));
    const enough = ev.n >= 5 && no.n >= 5;
    lines.push(`| ${y} | ${ev.n} | ${pct(ev.medAbs[60])} | ${no.n} | ${pct(no.medAbs[60])} | ${enough && no.medAbs[60] ? `${BR(ev.medAbs[60] / no.medAbs[60], 1)}x` : 'poucos casos'} |`);
  }
  return lines.join('\n');
}

/** Linha por divulgação (tipo, data, movimentos com sinal, amplitude), em ordem de data, para conferência. */
export function formatEventList(rowsByKind) {
  const lines = ['', '### Divulgações medidas', '', '| Tipo | Data (Nova York) | +5 min | +30 min | +60 min | Amplitude 1ª hora |', '|---|---|---:|---:|---:|---:|'];
  const all = Object.entries(rowsByKind).flatMap(([kind, rows]) => rows.map((r) => ({ kind, ...r })));
  all.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  for (const r of all) {
    lines.push(r.reaction
      ? `| ${r.kind} | ${r.date} | ${signed(r.reaction.moves[5])} | ${signed(r.reaction.moves[30])} | ${signed(r.reaction.moves[60])} | ${pct(r.reaction.rangePct)} |`
      : `| ${r.kind} | ${r.date} | sem dado | sem dado | sem dado | sem dado |`);
  }
  const duplicated = monthsWithTwoDates(rowsByKind);
  if (duplicated.length) lines.push('', `Meses com 2 datas do mesmo tipo (pode ser revisão anual ou remarcação, e não a divulgação principal; tende a diluir a mediana do tipo): ${duplicated.join(', ')}.`);
  return lines.join('\n');
}

/** Agregados em JSON (sem listas de preços): o que uma etapa seguinte poderia publicar. Números arredondados a 4 casas. */
export function toJson({ perKind, normal, generatedAtMs, sinceDate }) {
  const r4 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);
  const pack = (g) => ({ total: g.total, n: g.n, noData: g.noData, medAbs: Object.fromEntries(Object.entries(g.medAbs).map(([k, v]) => [k, r4(v)])), medRange: r4(g.medRange), up60: g.up60, down60: g.down60 });
  return {
    version: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    sinceDate,
    normal: pack(normal),
    kinds: Object.fromEntries(Object.entries(perKind).map(([kind, { group, vsNormal }]) => [kind, { ...pack(group), ratio60: r4(vsNormal.ratio60), rank60: r4(vsNormal.rank60) }])),
  };
}
