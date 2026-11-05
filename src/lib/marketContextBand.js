// Contexto de Mercado — Fase 3 (docs/known-risks.md item 285, addendum 11): lógica PURA da faixa de eventos do
// Dashboard. Sem rede, sem React. O dado vem do `events.json` que o coletor (`context-collect.yml`) grava na branch
// pública `context-data`; este módulo só valida, filtra, ordena e formata.
//
// Isolamento: nada do motor de trading importa este arquivo (travado por `scripts/contextIsolationTripwire.test.js`:
// o nome começa com "marketContext"). A faixa é INFORMAÇÃO — não altera sinal, stop, alvo, score nem operação.
// Texto neutro de propósito: "evento à frente", nunca "vai subir/cair" nem probabilidade.

export const CONTEXT_DATA_BASE = 'https://raw.githubusercontent.com/mateusraony/Sentinel-Signals/context-data';
/** Sem checagem nova há mais que isto = "desatualizado" (o coletor roda ≥ 3x/dia; 36 h tolera um dia sem coleta). */
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;
/** Evento que começou há até isto ainda aparece, como "acabou de sair". */
export const JUST_RELEASED_MS = 30 * 60 * 1000;
/** Quantos eventos a faixa mostra de início (1 em destaque + a linha do tempo); "Ver todos" mostra o resto. */
export const MAX_EVENTS_SHOWN = 6;
/** Horizonte da barra de aproximação do evento em destaque: ela enche nos 7 dias antes da hora. */
export const APPROACH_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

export const EVENT_LABELS = Object.freeze({ CPI: 'CPI', NFP: 'Payroll', PPI: 'PPI', PCE: 'PCE', FOMC: 'FOMC' });
/**
 * Nome em português claro + importância de REFERÊNCIA do mercado (3 = alta, 2 = média). A importância é um rótulo editorial
 * (CPI, Payroll e a decisão de juros do Fed costumam mexer mais com o mercado que PPI e PCE); NÃO é previsão de direção
 * nem de tamanho de movimento. Texto neutro de propósito (nada de "vai subir/cair" nem probabilidade).
 */
export const EVENT_META = Object.freeze({
  NFP: { title: 'Emprego dos EUA', short: 'Payroll', impact: 3, category: 'emprego' },
  CPI: { title: 'Inflação ao consumidor', short: 'CPI', impact: 3, category: 'inflacao' },
  FOMC: { title: 'Decisão de juros do Fed', short: 'FOMC', impact: 3, category: 'juros' },
  PPI: { title: 'Inflação ao produtor', short: 'PPI', impact: 2, category: 'inflacao' },
  PCE: { title: 'Gastos e inflação do consumo', short: 'PCE', impact: 2, category: 'inflacao' },
});
/**
 * Categoria do evento: a COR na tela identifica o TIPO de notícia (emprego / inflação / juros), nunca "bom" ou "ruim".
 * O rótulo em texto acompanha sempre a cor (a cor sozinha não pode carregar o significado).
 */
export const CATEGORY_META = Object.freeze({
  emprego: { label: 'Emprego' },
  inflacao: { label: 'Inflação' },
  juros: { label: 'Juros' },
});
export const IMPACT_LABELS = Object.freeze({ 3: 'Impacto alto', 2: 'Impacto médio', 1: 'Impacto baixo' });
export const EVENT_HINTS = Object.freeze({
  CPI: 'inflação dos EUA',
  NFP: 'emprego dos EUA',
  PPI: 'inflação ao produtor',
  PCE: 'inflação do consumo',
  FOMC: 'decisão de juros do Fed',
});
export const STATUS_LABELS = Object.freeze({ oficial: 'oficial', confirmada: 'confirmada', a_confirmar: 'data a confirmar' });

export const BAND_STATES = Object.freeze({
  FRESH: 'atualizado',
  STALE: 'desatualizado',
  UNAVAILABLE: 'indisponivel',
  OFF: 'desligado',
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isoMs = (v) => (typeof v === 'string' && ISO_RE.test(v) ? Date.parse(v) : NaN);

/**
 * Do JSON público, só as linhas bem formadas (tipo e situação conhecidos, hora ISO válida). O arquivo vem da rede:
 * qualquer outra coisa é ignorada em vez de quebrar a tela. Lança se o corpo nem é uma lista.
 */
export function parseEvents(json) {
  if (!Array.isArray(json)) throw new Error('events.json não é uma lista');
  const out = [];
  const seen = new Set();
  for (const e of json) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string') continue;
    // Id repetido (arquivo público, vem da rede): vale o primeiro — senão a tela teria `key` duplicada no React.
    if (seen.has(e.id)) continue;
    if (!Object.prototype.hasOwnProperty.call(EVENT_LABELS, e.kind)) continue;
    if (!Object.prototype.hasOwnProperty.call(STATUS_LABELS, e.status)) continue;
    const startMs = isoMs(e.startsAtUtc);
    if (!Number.isFinite(startMs)) continue;
    seen.add(e.id);
    const values = parseEventValues(e.values);
    out.push({ id: e.id, kind: e.kind, status: e.status, startsAtUtc: e.startsAtUtc, startMs, ...(values ? { values } : {}) });
  }
  return out;
}

/** Texto dos números curto (ex.: "151 mil", "3,2%"); o arquivo vem da rede, então qualquer coisa fora disso é descartada. */
const VALUE_MAX_LEN = 24;
function cleanValueText(v) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return t && t.length <= VALUE_MAX_LEN ? t : null;
}

/**
 * Números oficiais do evento, se o coletor um dia os trouxer: `{ previous, actual, source }` (textos curtos). Hoje o arquivo
 * público NÃO tem esse campo — a tela só desenha o espaço quando ele existe (nada de "—" permanente). Não existe "projeção":
 * não há fonte gratuita e licenciada, e o painel não inventa número.
 */
export function parseEventValues(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const previous = cleanValueText(raw.previous);
  const actual = cleanValueText(raw.actual);
  if (!previous && !actual) return null;
  return { previous, actual, source: cleanValueText(raw.source) };
}

/**
 * Espaços de número do evento, na ordem da tela: Anterior e Atual. Vazio se o evento não traz números. Com "Anterior" mas sem
 * "Atual", o Atual aparece como "aguardando" (`text: null`) — o número só entra quando a fonte oficial publicar.
 */
export function eventValueSlots(e) {
  const v = e?.values;
  if (!v || (!v.previous && !v.actual)) return [];
  const slots = [];
  if (v.previous) slots.push({ key: 'previous', label: 'Anterior', text: v.previous });
  slots.push({ key: 'actual', label: 'Atual', text: v.actual ?? null });
  return slots;
}

/** Hora da última checagem do coletor (`status.json`), em ms; null se o corpo não serve. */
export function parseCheckedAt(json) {
  const ms = isoMs(json?.checkedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Eventos de agora em diante (mais os que saíram há até 30 min), em ordem de hora. `phase`: 'agora' = já começou
 * (acabou de sair), 'futuro' = ainda não.
 */
export function upcomingEvents(events, nowMs, limit = MAX_EVENTS_SHOWN) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => Number.isFinite(e?.startMs) && e.startMs >= nowMs - JUST_RELEASED_MS)
    .sort((a, b) => (a.startMs === b.startMs ? String(a.id).localeCompare(String(b.id)) : a.startMs - b.startMs))
    .slice(0, limit)
    .map((e) => ({ ...e, phase: e.startMs <= nowMs ? 'agora' : 'futuro' }));
}

/**
 * Estado da faixa. `events === null` = nunca conseguiu ler (rede, branch ainda inexistente) → indisponível.
 * Lido mas a última checagem do coletor é velha (ou não tem hora) → desatualizado.
 */
export function bandState({ enabled, events, checkedAtMs, nowMs }) {
  if (!enabled) return BAND_STATES.OFF;
  if (!Array.isArray(events)) return BAND_STATES.UNAVAILABLE;
  if (!Number.isFinite(checkedAtMs) || nowMs - checkedAtMs > STALE_AFTER_MS) return BAND_STATES.STALE;
  return BAND_STATES.FRESH;
}

/** "em 12 min", "em 5h 20min", "em 3d 4h". */
export function formatCountdown(msUntil) {
  if (!Number.isFinite(msUntil) || msUntil <= 0) return 'agora';
  const total = Math.floor(msUntil / 60000);
  if (total < 1) return 'em menos de 1 min';
  if (total < 60) return `em ${total} min`;
  if (total < 1440) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `em ${h}h ${m}min` : `em ${h}h`;
  }
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  return h ? `em ${d}d ${h}h` : `em ${d}d`;
}

const BRT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** "seg 10/11, 10:30 (Brasília)" — a hora vem sempre de UTC convertida (nunca deslocamento fixo). */
export function formatEventWhen(iso) {
  const ms = isoMs(iso);
  if (!Number.isFinite(ms)) return '—';
  const p = Object.fromEntries(BRT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${String(p.weekday).replace('.', '')} ${p.day}/${p.month}, ${p.hour}:${p.minute} (Brasília)`;
}

/** Contagem sem o "em ": "2d 5h", "38 min", "agora". Para o número grande do cartão do próximo evento. */
export function formatCountdownBare(msUntil) {
  const s = formatCountdown(msUntil);
  return s.startsWith('em ') ? s.slice(3) : s;
}

const BRT_YMD = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
const BRT_CLOCK = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const BRT_WEEKDAY = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short' });
const BRT_DAY_MONTH = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
const partsOf = (fmt, ms) => Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));

/** Dia do calendário de Brasília como "AAAA-MM-DD" (a virada do dia é à meia-noite de Brasília, não de UTC). */
export function brtDayKey(ms) {
  const p = partsOf(BRT_YMD, ms);
  return `${p.year}-${p.month}-${p.day}`;
}

const dayNumber = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

/** Quantos dias de calendário (Brasília) o evento está à frente de agora: 0 = hoje, 1 = amanhã, −1 = ontem. */
export function brtDayDiff(ms, nowMs) {
  return dayNumber(brtDayKey(ms)) - dayNumber(brtDayKey(nowMs));
}

/** "Hoje", "Amanhã", "Ontem" ou "em 5 dias". */
export function relativeDayLabel(diff) {
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Amanhã';
  if (diff === -1) return 'Ontem';
  return diff > 0 ? `em ${diff} dias` : `há ${-diff} dias`;
}

/** "10:30" em horário de Brasília (sempre convertido de UTC; nunca deslocamento fixo). */
export function formatEventClock(iso) {
  const ms = isoMs(iso);
  if (!Number.isFinite(ms)) return '—';
  const p = partsOf(BRT_CLOCK, ms);
  return `${p.hour}:${p.minute}`;
}

/**
 * Agrupa por dia de Brasília (a lista já vem em ordem de hora). Cada grupo: `weekday` ("SEX"), `dayMonth` ("06/11"),
 * `relative` ("Hoje" / "Amanhã" / "em 9 dias") e os eventos do dia. Dia com data só estimada (a confirmar) é agrupado igual.
 */
export function groupEventsByDay(events, nowMs) {
  const groups = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!Number.isFinite(e?.startMs)) continue;
    const key = brtDayKey(e.startMs);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      const p = partsOf(BRT_DAY_MONTH, e.startMs);
      g = {
        key,
        diff: brtDayDiff(e.startMs, nowMs),
        weekday: String(partsOf(BRT_WEEKDAY, e.startMs).weekday).replace('.', '').toUpperCase(),
        dayMonth: `${p.day}/${p.month}`,
        day: p.day,
        month: p.month,
        relative: relativeDayLabel(brtDayDiff(e.startMs, nowMs)),
        items: [],
      };
      groups.push(g);
    }
    g.items.push(e);
  }
  return groups;
}

/**
 * Evento em destaque = o primeiro com data FIRME (oficial/confirmada). Data "a confirmar" nunca vira "próximo evento":
 * não tem contagem regressiva e enganaria. Devolve `{ featured, rest }`; `featured` é null se todos forem a confirmar.
 */
export function splitFeatured(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const i = list.findIndex((e) => e?.status !== 'a_confirmar');
  if (i < 0) return { featured: null, rest: list };
  return { featured: list[i], rest: list.filter((_, j) => j !== i) };
}

/**
 * Urgência do evento, para a cor e o ponto pulsante: 'pendente' (data a confirmar), 'agora' (acabou de sair),
 * 'iminente' (≤ 1 h), 'em24h' (≤ 24 h), 'proximo' (≤ 7 dias), 'distante'.
 */
export function eventUrgency(e, nowMs) {
  if (e?.status === 'a_confirmar') return 'pendente';
  const until = e.startMs - nowMs;
  if (until <= 0) return 'agora';
  if (until <= 60 * 60 * 1000) return 'iminente';
  if (until <= 24 * 60 * 60 * 1000) return 'em24h';
  if (until <= APPROACH_HORIZON_MS) return 'proximo';
  return 'distante';
}

/** 0..1: quanto da janela de 7 dias já passou (a barra do cartão enche até a hora do evento). */
export function approachFraction(msUntil, horizonMs = APPROACH_HORIZON_MS) {
  if (!Number.isFinite(msUntil)) return 0;
  if (msUntil <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - msUntil / horizonMs));
}

/** "há 5 h" / "há 40 min"; null se não há hora. */
export function formatAge(checkedAtMs, nowMs) {
  if (!Number.isFinite(checkedAtMs)) return null;
  const min = Math.max(0, Math.floor((nowMs - checkedAtMs) / 60000));
  if (min < 60) return `há ${min} min`;
  return `há ${Math.floor(min / 60)} h`;
}

// Chave de ligar/desligar (por navegador). Padrão: ligada. Tudo em try/catch — localStorage pode não existir
// (modo privado, quota, teste), e a faixa tem que continuar funcionando.
const OFF_KEY = 'sentinel_market_context_band_off';

export function isBandEnabled() {
  try { return localStorage.getItem(OFF_KEY) !== '1'; } catch { return true; }
}

export function setBandEnabled(enabled) {
  try {
    if (enabled) localStorage.removeItem(OFF_KEY);
    else localStorage.setItem(OFF_KEY, '1');
  } catch { /* sem localStorage: a escolha vale só nesta sessão da tela */ }
}
