// Contexto de Mercado — Fase 4b (docs/known-risks.md item 285, addendum 27): as DATAS PASSADAS das divulgações (CPI, Payroll, PPI, PCE).
// O aviso "1 hora antes" mostra o que o BTC fez nas últimas 3 divulgações do mesmo tipo; para isso precisa das datas passadas, que o coletor já
// recebe do FRED (as mesmas respostas das datas futuras) e agora publica em `history.json` na branch pública `context-data`.
//
// Só DATAS (AAAA-MM-DD): fato de calendário, sem valor de série (os termos do FRED proíbem repassar o número; ver addendum 5). Parte PURA: sem rede,
// sem relógio global, sem arquivo. Lista FECHADA de campos, travada por `assertHistoryShape` (o repositório é público).
//
// Datas suspeitas ficam de fora: o FRED lista, às vezes, DUAS datas do mesmo tipo no mesmo mês (revisão anual, remarcação) e só uma é a divulgação
// principal — o mesmo problema que `monthsWithTwoDates` aponta na medição de reação. Como não dá para saber qual é a certa, o mês inteiro sai
// (melhor 2 casos confiáveis do que 3 com um possivelmente errado). FOMC (addendum 36) vem do calendário do site do Fed, não do FRED: as reuniões já passadas entram aqui.
import { KIND_TIMES } from './contextCalendar.mjs';
import { nyToUtc } from './contextTime.mjs';
import { FRED_RELEASES } from './contextCollect.mjs';

export const HISTORY_FILE = 'history.json';
/** Os tipos com histórico: os 4 do FRED e o FOMC (datas das reuniões lidas no site do Fed). */
export const HISTORY_KINDS = Object.freeze([...Object.keys(FRED_RELEASES), 'FOMC']);
export const HISTORY_VERSION = 1;
/** Quantas datas passadas guardar por tipo (a mensagem usa as 3 mais recentes; o resto é folga para meses descartados). */
export const HISTORY_PER_KIND = 8;
/** Uma divulgação só entra depois de a hora de medição acabar (1 h + a vela de referência), senão o histórico teria um caso incompleto. */
export const SETTLE_MS = 61 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Data de calendário que existe (o motor de datas do JavaScript aceita 30/02 e "corrige"; aqui isso seria um dia inventado). */
const isRealDate = (d) => typeof d === 'string' && DATE_RE.test(d) && new Date(`${d}T00:00:00.000Z`).toISOString().slice(0, 10) === d;

const instantMs = (kind, date) => {
  try { return nyToUtc(date, KIND_TIMES[kind])?.ms ?? null; } catch { return null; }
};

const emptyHistory = () => ({ version: HISTORY_VERSION, dates: {} });

/** Uma lista de datas "limpa": só `AAAA-MM-DD` válidas, sem repetir, da mais recente à mais antiga, no máximo `HISTORY_PER_KIND`. */
function cleanDates(list) {
  const out = [...new Set((Array.isArray(list) ? list : []).filter(isRealDate))];
  return out.sort().reverse().slice(0, HISTORY_PER_KIND);
}

/** O `history.json` lido (disco/rede: não é confiável): só os tipos conhecidos e as datas bem formadas. Lixo vira histórico vazio. Nunca lança. */
export function parseHistory(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || json.version !== HISTORY_VERSION) return emptyHistory();
  const src = json.dates && typeof json.dates === 'object' && !Array.isArray(json.dates) ? json.dates : {};
  const dates = {};
  for (const kind of HISTORY_KINDS) {
    const list = cleanDates(src[kind]);
    if (list.length) dates[kind] = list;
  }
  return { version: HISTORY_VERSION, dates };
}

/**
 * O histórico novo a partir das datas desta coleta (FRED + as reuniões do Fed em `FOMC`). Tipo que o FRED respondeu: as datas passadas dele (meses com 2 datas saem). Tipo que NÃO
 * respondeu (`null`): fica o que já estava publicado — uma falha de rede não apaga o histórico.
 * @param {{ fredDatesByKind?: Record<string, string[]|null>, previous?: unknown, nowMs: number }} p
 */
export function buildHistory({ fredDatesByKind = {}, previous = null, nowMs }) {
  const before = parseHistory(previous);
  const dates = {};
  for (const kind of HISTORY_KINDS) {
    const fred = fredDatesByKind?.[kind];
    if (Array.isArray(fred)) {
      const past = [...new Set(fred.filter(isRealDate))].filter((d) => {
        const ms = instantMs(kind, d);
        return ms !== null && ms + SETTLE_MS <= nowMs;
      });
      const perMonth = new Map();
      for (const d of past) perMonth.set(d.slice(0, 7), (perMonth.get(d.slice(0, 7)) ?? 0) + 1);
      const reliable = cleanDates(past.filter((d) => perMonth.get(d.slice(0, 7)) === 1));
      if (reliable.length) dates[kind] = reliable;
      else if (before.dates[kind]) dates[kind] = before.dates[kind];
    } else if (before.dates[kind]) {
      dates[kind] = before.dates[kind];
    }
  }
  return { version: HISTORY_VERSION, dates };
}

/** Trava do conteúdo PÚBLICO: só `version` e `dates` (tipo → datas AAAA-MM-DD, da mais recente à mais antiga, sem repetir). Lança se fugir. */
export function assertHistoryShape(history) {
  const fail = (msg) => { throw new Error(`history.json fora do formato: ${msg}`); };
  if (!history || typeof history !== 'object' || Array.isArray(history)) fail('não é um objeto');
  if (Object.keys(history).sort().join(',') !== 'dates,version') fail('campos devem ser só version e dates');
  if (history.version !== HISTORY_VERSION) fail('versão');
  if (!history.dates || typeof history.dates !== 'object' || Array.isArray(history.dates)) fail('dates não é um objeto');
  for (const [kind, list] of Object.entries(history.dates)) {
    if (!HISTORY_KINDS.includes(kind)) fail(`tipo desconhecido (${String(kind).slice(0, 20)})`);
    if (!Array.isArray(list) || !list.length || list.length > HISTORY_PER_KIND) fail(`${kind}: quantidade de datas`);
    for (const d of list) if (!isRealDate(d)) fail(`${kind}: data inválida`);
    if (new Set(list).size !== list.length) fail(`${kind}: data repetida`);
    if ([...list].sort().reverse().join(',') !== list.join(',')) fail(`${kind}: fora de ordem`);
  }
  return history;
}

/** O texto exato gravado no arquivo. */
export const serializeHistory = (history) => `${JSON.stringify(assertHistoryShape(history), null, 2)}\n`;

/** As `count` datas mais recentes do tipo (da mais recente à mais antiga); vazio se o tipo não tem histórico. */
export function lastDates(history, kind, count = 3) {
  return (parseHistory(history).dates[kind] ?? []).slice(0, count);
}
