// Contexto de Mercado — "o BTC depois da divulgação" (Agenda 4d, parte 2; docs/known-risks.md item 285, addendum 18). Parte PURA: sem rede, sem relógio
// próprio (o "agora" vem de fora). Mede, nas velas de 1 minuto do BTCUSDT, quanto o preço andou nos 5, 30 e 60 minutos DEPOIS de uma divulgação que já saiu —
// o que aconteceu, não o que vai acontecer, e sem afirmar que a divulgação causou o movimento (correlação não é causa).
//
// Mesma conta da Medição da reação (scripts/contextReaction.mjs, mantida em sincronia à mão porque o navegador não importa de scripts/): a referência é o
// fechamento da vela que TERMINA no instante da divulgação; o movimento em N minutos é o fechamento da vela que termina nesse instante, contra a referência.
// Um horizonte só aparece quando a vela dele JÁ fechou (divulgação de 12 minutos atrás mostra só o de 5 min) e vela faltando = esse horizonte fica vazio
// (nunca completa com a vizinha).
const MIN = 60 * 1000;
export const HORIZONS_MIN = Object.freeze([5, 30, 60]);
/** 1 vela de referência (o minuto antes) + 60 velas da 1ª hora. */
export const WINDOW_CANDLES = 61;

/** Velas de 1 min da Binance (`/klines`) → `{ t, o, h, l, c }` (números), em ordem; null se o corpo não serve. */
export function parseKlines(body) {
  let j;
  try { j = typeof body === 'string' ? JSON.parse(body) : body; } catch { return null; }
  if (!Array.isArray(j)) return null;
  const out = [];
  for (const k of j) {
    if (!Array.isArray(k) || k.length < 5) return null;
    const [t, o, h, l, c] = [Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4])];
    if (![t, o, h, l, c].every(Number.isFinite) || o <= 0 || h <= 0 || l <= 0 || c <= 0 || h < l) return null;
    out.push({ t, o, h, l, c });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Tira as velas que AINDA ESTAVAM ABERTAS no instante da busca (`nowMs`): o preço delas é provisório e, guardado em cache, passaria por fechamento
 * definitivo só porque o relógio andou (achado do Codex no PR #555). Vela que termina exatamente em `nowMs` já fechou e fica. Sem velas (null) devolve null.
 * @template {{ t: number }} T
 * @param {T[] | null} candles
 * @param {number} nowMs
 * @returns {T[] | null}
 */
export function dropOpenCandles(candles, nowMs) {
  return Array.isArray(candles) ? candles.filter((c) => c.t + MIN <= nowMs) : null;
}

/**
 * Movimento (%, com sinal) do BTC depois de `t0Ms`, por horizonte. `{ 5, 30, 60 }`: número, ou null se a vela daquele horizonte ainda não fechou
 * (`nowMs`) ou não veio. Devolve null se a vela de referência não veio (sem referência não há conta).
 * `series` = o caminho minuto a minuto para o minigráfico: `{ m: 0, pct: 0 }` (a referência) e um ponto por vela JÁ fechada até o minuto 60; vela
 * faltando fica de fora (nunca se completa com a vizinha).
 * @param {{ t: number, c: number }[]} candles
 * @returns {{ moves: Record<number, number|null>, series: { m: number, pct: number }[] } | null}
 */
export function afterRelease(candles, t0Ms, nowMs) {
  const byOpen = new Map((candles ?? []).map((c) => [c.t, c]));
  const ref = byOpen.get(t0Ms - MIN);
  if (!ref) return null;
  /** @type {Record<number, number|null>} */
  const moves = {};
  for (const n of HORIZONS_MIN) {
    const c = t0Ms + n * MIN <= nowMs ? byOpen.get(t0Ms + (n - 1) * MIN) : undefined;
    moves[n] = c ? (c.c / ref.c - 1) * 100 : null;
  }
  /** @type {{ m: number, pct: number }[]} */
  const series = [{ m: 0, pct: 0 }];
  for (let m = 1; m <= 60 && t0Ms + m * MIN <= nowMs; m += 1) {
    const c = byOpen.get(t0Ms + (m - 1) * MIN);
    if (c) series.push({ m, pct: (c.c / ref.c - 1) * 100 });
  }
  return { moves, series };
}

/** "+0,12%" / "-0,54%" em português (vírgula), sem cor: o sinal é só fato, nunca "bom" ou "ruim". */
export function formatMove(x) {
  if (!Number.isFinite(x)) return '—';
  const r = Math.round(x * 100) / 100;
  const body = Math.abs(r).toFixed(2).replace('.', ',');
  return `${r > 0 ? '+' : r < 0 ? '-' : ''}${body}%`;
}

const LABELS = { 5: '5 min', 30: '30 min', 60: '1 h' };
export const horizonLabel = (n) => LABELS[n] ?? `${n} min`;

/** Quantos horizontes já têm número. */
export const movesCount = (moves) => HORIZONS_MIN.filter((n) => Number.isFinite(moves?.[n])).length;

/** O horizonte mais longo que já tem número (para a linha curta da lista): `{ n, label, text }` ou null. */
export function lastMove(moves) {
  for (const n of [...HORIZONS_MIN].reverse()) if (Number.isFinite(moves?.[n])) return { n, label: horizonLabel(n), text: formatMove(moves[n]) };
  return null;
}
