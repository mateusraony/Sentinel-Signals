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
/** Evento do BLS com números que saiu há até isto vira cartão de RESULTADO (Anterior × Atual); depois passa para "Últimas divulgações". */
export const RESULT_CARD_MS = 24 * 60 * 60 * 1000;
/** Tipos que o BLS publica (têm "Anterior"/"Atual"); PCE e FOMC não têm número neste painel. */
export const RESULT_KINDS = Object.freeze(['CPI', 'PPI', 'NFP']);
/** Quantas divulgações a lista "Últimas divulgações" mostra de início. */
export const HISTORY_SHOWN = 5;
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
/**
 * Emojis da Agenda (redesenho de 10/11/2026, addendum 20): TODOS saem desta tabela — nenhum literal solto nos componentes (regra "1 emoji = 1 significado",
 * `src/lib/emojiRegistry.js`; este arquivo é o dono do vocabulário). Sempre acompanham um texto (o emoji é decoração com `aria-hidden`).
 * Nenhum reaproveita glifo do trading (⏳ aguardando entrada, ⏱️ time stop, 📈/📉 preço, 🌊 chop…).
 */
export const KIND_EMOJI = Object.freeze({ NFP: '👷', CPI: '🛒', PPI: '🏭', PCE: '🧾', FOMC: '🏦' });
export const CONTEXT_EMOJI = Object.freeze({
  released: '📣', // "Saiu hoje às 10:30": a divulgação aconteceu
  compare: '🆚', // "Anterior × Atual"
  waiting: '📭', // ainda sem o número do BLS
  unavailable: '🕳️', // saiu, mas esta medida ficou sem número (indisponível, ou lacuna oficial do BLS)
  window: '🪟', // "janela alternativa": período mais curto, só com índices publicados
  btc: '🪙', // "O BTC depois da divulgação"
  horizon: '🕒', // horizonte de tempo (5 min, 30 min, 1 h)
  gauge: '🌡️', // tamanho do movimento do BTC comparado a um dia normal
  howto: '🎓', // "Como ler"
});
/**
 * Cor de destaque por TIPO de notícia — gradiente `from` → `to` — e FONTE ÚNICA: o cartão de resultado, o "Próximo evento" e as colunas por dia usam
 * esta tabela. A cor identifica o PAPEL do dado (tipo da notícia), NUNCA "bom" ou "ruim". Paleta "Brasa" (10/11/2026): o usuário não quis roxo e
 * escolheu entre 3 opções sem roxo vendo o cartão real — inflação = coral, emprego = azul-real, juros = rosa. `from` (o mais claro, contraste ≥ 4,5:1
 * sobre o fundo do cartão) serve para texto e ícone pequenos; o gradiente inteiro só em áreas grandes (≥ 3:1). O ciano do BTC (`BTC_ACCENT`) NÃO pode
 * aparecer aqui: era o fim do gradiente de emprego e os dois se confundiam lado a lado. Tudo isso é travado por teste.
 */
export const CATEGORY_ACCENTS = Object.freeze({
  inflacao: Object.freeze({ from: '#ff7a5c', to: '#ff5c4d' }),
  emprego: Object.freeze({ from: '#5aa9ff', to: '#3d7dff' }),
  juros: Object.freeze({ from: '#ff7eb6', to: '#ec5fa6' }),
});
/** O BTC: ciano (papel "BTC" no cartão de resultado). Nenhuma categoria usa este tom. */
export const BTC_ACCENT = Object.freeze({ from: '#22d3ee', to: '#38bdf8' });
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
    // O mês que o evento mede ('AAAA-MM'), só quando bem formado: a tela o usa para dizer QUAL índice o BLS não publicou (lacuna oficial).
    const reference = typeof e.reference === 'string' && MONTH_RE.test(e.reference) ? e.reference : null;
    out.push({ id: e.id, kind: e.kind, status: e.status, startsAtUtc: e.startsAtUtc, startMs, ...(reference ? { reference } : {}), ...(values ? { values } : {}) });
  }
  return out;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Motivos de lacuna que o coletor publica (lista fechada; o teste confere que é a MESMA de `scripts/contextBls.mjs`). Outro valor é descartado. */
export const GAP_REASONS = Object.freeze(['paralisacao_2025', 'nao_divulgado']);

/** Meses de `a` até `b` ('AAAA-MM'). */
const monthsFrom = (a, b) => (Number(b.slice(0, 4)) * 12 + Number(b.slice(5))) - (Number(a.slice(0, 4)) * 12 + Number(a.slice(5)));

/** 'AAAA-MM' deslocado `delta` meses. */
export function shiftMonth(ym, delta) {
  const t = Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5)) - 1) + delta;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/**
 * A "janela alternativa" do coletor: "+3,5% de 2025-11 a 2026-10" → { pct: '+3,5%', from: '2025-11', to: '2026-10', months: 11 }. Só o formato fechado, com
 * 2 a 11 meses (12 seria o número oficial); qualquer outra coisa, ou algo que não é texto, vira null.
 */
export function parseAlt(text) {
  const m = typeof text === 'string' ? /^((?:[+-]\d{1,2},\d|0,0)%) de (\d{4}-(?:0[1-9]|1[0-2])) a (\d{4}-(?:0[1-9]|1[0-2]))$/.exec(text) : null;
  if (!m) return null;
  const months = monthsFrom(m[2], m[3]);
  return months >= 2 && months <= 11 ? { pct: m[1], from: m[2], to: m[3], months } : null;
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
 * Números oficiais do evento: `{ previous, actual, revised, source }` (textos curtos). O coletor grava o "Anterior" antes da divulgação e,
 * depois dela, o "Atual" e — se o BLS corrigiu o mês anterior — o "Revisado" (addenda 14 e 15 do item 285). A tela só desenha o espaço
 * quando o campo existe (nada de "—" permanente). Não existe "projeção": não há fonte gratuita e licenciada, e o painel não inventa número.
 * "Revisado" sem "Atual" é descartado (só existe junto da divulgação).
 */
export function parseEventValues(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const previous = cleanValueText(raw.previous);
  const actual = cleanValueText(raw.actual);
  if (!previous && !actual) return null;
  // Lacuna oficial (addendum 22): `gap` (motivo da lista fechada) e `alt` (janela alternativa, já interpretada) só existem junto do "Atual"; `alt` só junto do `gap`.
  const gap = actual && GAP_REASONS.includes(raw.gap) ? raw.gap : null;
  const alt = gap ? parseAlt(raw.alt) : null;
  return { previous, actual, revised: actual ? cleanValueText(raw.revised) : null, ...(gap ? { gap } : {}), ...(alt ? { alt } : {}), source: cleanValueText(raw.source) };
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

const MEASURE_ORDER = ['mom', 'yoy', 'jobs', 'raw'];
const MEASURE_ROW_LABELS = Object.freeze({ mom: 'No mês', yoy: 'Em 12 meses', jobs: 'No mês', raw: 'Valor' });

/**
 * Parte o texto do coletor em medidas, com o nome POR EXTENSO: "+0,3% m/m · +3,0% a/a" → [{ key: 'mom', label: 'no mês', value: '+0,3%' },
 * { key: 'yoy', label: 'em 12 meses', value: '+3,0%' }]; "+119 mil" → [{ key: 'jobs', label: 'no mês', value: '+119 mil' }]. Formato que não
 * é nenhum desses vira uma medida 'raw' sem rótulo (a tela mostra o texto como veio, nunca quebra). Texto vazio ou não-texto: [].
 */
export function splitValueText(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  return text.split(' · ').map((part) => {
    const t = part.trim();
    let m = /^(.+?)\s+m\/m$/.exec(t);
    if (m) return { key: 'mom', label: 'no mês', value: m[1] };
    m = /^(.+?)\s+a\/a$/.exec(t);
    if (m) return { key: 'yoy', label: 'em 12 meses', value: m[1] };
    if (/\smil$/.test(t)) return { key: 'jobs', label: 'no mês', value: t };
    return { key: 'raw', label: null, value: t };
  }).filter((x) => x.value);
}

/** "+0,3%" → 0.3; "-0,2%" → -0.2; "+1.234 mil" → 1234; "151 mil" → 151. null se não começa por um número. */
export function valueNumber(value) {
  const m = /^([+-]?)(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?/.exec(String(value ?? '').trim());
  if (!m) return null;
  const n = Number(`${m[1]}${m[2].replace(/\./g, '')}.${m[3] ?? '0'}`);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compara o "Atual" com o "Anterior" (os dois textos de uma medida). 'acima' | 'abaixo' | 'igual', ou null se faltar um dos lados ou algum
 * não for número. É um FATO sobre os dois números — não diz se é bom ou ruim, nem o que o mercado vai fazer.
 */
export function compareValues(actual, previous) {
  const a = valueNumber(actual);
  const p = valueNumber(previous);
  if (a === null || p === null) return null;
  if (Math.abs(a - p) < 1e-9) return 'igual';
  return a > p ? 'acima' : 'abaixo';
}

/**
 * As linhas do cartão de resultado: uma por medida (no mês, em 12 meses ou vagas do mês), com Anterior, Atual, Revisado e a comparação.
 * Cada lado pode faltar (`null`): o "Atual" some até o BLS divulgar; o "Revisado" só existe se o BLS corrigiu aquela medida.
 */
export function resultRows(values, reference = null) {
  if (!values) return [];
  const sides = { previous: splitValueText(values.previous), actual: splitValueText(values.actual), revised: splitValueText(values.revised) };
  const pick = (list, key) => list.find((x) => x.key === key)?.value ?? null;
  const rows = [];
  for (const key of MEASURE_ORDER) {
    const previous = pick(sides.previous, key);
    const actual = pick(sides.actual, key);
    const revisedRaw = pick(sides.revised, key);
    // "Revisado" só aparece onde o BLS de fato mudou aquela medida (no CPI, o 12 meses pode ficar igual enquanto o mês muda).
    const revised = revisedRaw !== null && revisedRaw !== previous ? revisedRaw : null;
    if (previous === null && actual === null && revised === null) continue;
    const row = { key, label: MEASURE_ROW_LABELS[key], previous, actual, revised, direction: compareValues(actual, previous) };
    // A medida "em 12 meses" que NÃO existe porque o mês-base é uma lacuna oficial do BLS: o motivo, o mês-base (se o evento traz o mês que mede) e a janela alternativa.
    if (key === 'yoy' && actual === null && values.gap) {
      row.gap = values.gap;
      row.gapMonth = typeof reference === 'string' && MONTH_RE.test(reference) ? shiftMonth(reference, -12) : null;
      row.alt = values.alt ?? null;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Eventos do BLS que JÁ saíram (há até 24 h) e trazem números: viram o cartão de RESULTADO (mais recente primeiro). Evento sem número fica
 * no fluxo antigo ("acabou de sair" por 30 min); data "a confirmar" nunca entra.
 */
export function resultEvents(events, nowMs) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => RESULT_KINDS.includes(e?.kind) && e.status !== 'a_confirmar' && Number.isFinite(e.startMs)
      && e.startMs <= nowMs && nowMs - e.startMs <= RESULT_CARD_MS && (e.values?.previous || e.values?.actual))
    .sort((a, b) => (a.startMs === b.startMs ? String(a.id).localeCompare(String(b.id)) : b.startMs - a.startMs));
}

/**
 * "Últimas divulgações": eventos que JÁ têm o "Atual" e saíram há mais de 24 h (os de menos de 24 h estão no cartão de resultado). Mais
 * recente primeiro. Evento sem "Atual" não entra (a lista só mostra o que tem número oficial) e data "a confirmar" também não.
 */
export function releaseHistory(events, nowMs) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e?.status !== 'a_confirmar' && Number.isFinite(e?.startMs) && e.startMs < nowMs - RESULT_CARD_MS && e.values?.actual)
    .sort((a, b) => (a.startMs === b.startMs ? String(a.id).localeCompare(String(b.id)) : b.startMs - a.startMs));
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
