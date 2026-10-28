// Contexto de Mercado (docs/known-risks.md item 284/285) — conversões de fuso.
// Parte pura: sem rede, sem Date.now, sem dependência. Tudo o que a camada de
// contexto guarda fica em UTC; aqui só se converte na entrada (horário de
// Nova York das divulgações dos EUA) e na saída (Brasília, para o usuário).
//
// Regra: NUNCA somar um deslocamento fixo ("−4h"/"−5h") — os EUA mudam o
// horário de verão (em 2026 acaba em 01/11, em 2027 começa em 14/03) e o
// Brasil não tem horário de verão hoje (UTC−3 o ano todo). Quem sabe a
// diferença em cada data é o `Intl` (base de fusos do Node).

export const NY_ZONE = 'America/New_York';
export const BRT_ZONE = 'America/Sao_Paulo';

// Coletas do usuário (item 284): 07:00, 12:00 e 21:00 em Brasília.
export const COLLECTION_HOURS_BRT = Object.freeze([7, 12, 21]);

const partsFormatter = (zone) => new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const formatters = new Map();
function getFormatter(zone) {
  if (!formatters.has(zone)) formatters.set(zone, partsFormatter(zone));
  return formatters.get(zone);
}

/** Relógio da parede de `zone` no instante `ms` (UTC), como números. */
export function wallClockIn(zone, ms) {
  const out = {};
  for (const p of getFormatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second };
}

/** Quanto `zone` está adiantada/atrasada de UTC no instante `ms`, em minutos. */
export function offsetMinutes(zone, ms) {
  const w = wallClockIn(zone, ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

function parseDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error(`data inválida (esperado AAAA-MM-DD): ${dateStr}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function parseTime(timeStr) {
  const m = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!m) throw new Error(`hora inválida (esperado HH:MM): ${timeStr}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`hora inválida: ${timeStr}`);
  return { hour, minute };
}

/**
 * Relógio da parede de `zone` (data + HH:MM) → instante UTC em ISO.
 *
 * Casos de borda do horário de verão (documentados e testados):
 * - hora que NÃO existe (pulo da primavera, ex.: 2027-03-14 02:30 em NY):
 *   devolve `null` — o chamador trata como "horário inválido", nunca chuta;
 * - hora que existe DUAS vezes (volta de outono, ex.: 2026-11-01 01:30 em NY):
 *   devolve a PRIMEIRA ocorrência (a de verão) e marca `ambiguous: true`.
 *   Divulgações econômicas não saem nessa janela; o marcador existe só para
 *   o dado nunca passar despercebido.
 *
 * @returns {{ iso: string, ms: number, ambiguous: boolean } | null}
 */
export function wallTimeToUtc(zone, dateStr, timeStr) {
  const { year, month, day } = parseDate(dateStr);
  const { hour, minute } = parseTime(timeStr);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Os deslocamentos possíveis em torno da data: o de antes e o de depois.
  const candidates = new Set();
  for (const delta of [-36, 36]) {
    candidates.add(offsetMinutes(zone, naive + delta * 3600 * 1000));
  }
  const matches = [];
  for (const off of candidates) {
    const ms = naive - off * 60000;
    const w = wallClockIn(zone, ms);
    if (w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute) {
      matches.push(ms);
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a - b);
  return { iso: new Date(matches[0]).toISOString(), ms: matches[0], ambiguous: matches.length > 1 };
}

/** Atalho: horário de Nova York (como o BLS/FOMC publicam) → UTC. */
export function nyToUtc(dateStr, timeStr) {
  return wallTimeToUtc(NY_ZONE, dateStr, timeStr);
}

/** Instante UTC → texto em Brasília "DD/MM/AAAA HH:MM" (para o usuário). */
export function formatBrt(msOrIso) {
  const ms = typeof msOrIso === 'number' ? msOrIso : Date.parse(msOrIso);
  const w = wallClockIn(BRT_ZONE, ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(w.day)}/${p2(w.month)}/${w.year} ${p2(w.hour)}:${p2(w.minute)}`;
}

/** Os EUA estão no horário de verão neste instante? */
export function isUsDst(ms) {
  return offsetMinutes(NY_ZONE, ms) === -240;
}

/** Horas UTC das 3 coletas diárias (07h/12h/21h de Brasília), em ordem. */
export function collectionHoursUtc(referenceMs = Date.UTC(2026, 9, 28)) {
  return COLLECTION_HOURS_BRT.map((h) => {
    const brtOffsetH = offsetMinutes(BRT_ZONE, referenceMs) / 60; // -3
    return (h - brtOffsetH + 24) % 24;
  });
}
