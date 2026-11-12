// Modo de observação sem banco, fase O2b (docs/known-risks.md item 299): a busca das velas de 15 min que o vigia compara com o retrato.
//
// Fonte: Binance Spot (`data-api.binance.vision`), a MESMA do cron (scripts/adminMarketDataProvider.js): o painel usa Futures, mas o Futures dá 451 em
// datacenter dos EUA (item 4 de docs/known-risks.md). O símbolo vem do retrato (dado do banco), então é validado antes de entrar na URL.
//
// Devolve só velas FECHADAS, ordenadas e sem repetição. Qualquer falha vira só um CÓDIGO (`rede`, `http_503`, `resposta_invalida`, `janela_longa`...):
// a mensagem de um erro de rede pode citar a URL, e o log do Actions é público. Uma sequência furada (falha numa página do meio, janela longa demais)
// é RECUSADA em vez de devolvida pela metade: pular uma vela poderia esconder justamente o toque no stop.
import { fetchWithRetry } from '../src/lib/httpRetry.js';
import { CANDLE_MS } from './observationWatch.mjs';

export const BINANCE_BASE_URL = 'https://data-api.binance.vision/api/v3';
const PAGE_LIMIT = 1000; // máximo da Binance por pedido
const DEFAULT_MAX_PAGES = 5; // 5.000 velas de 15 min = ~52 dias; a queda real de 19/10 a 04/11 (16 dias) cabe em 2 páginas
const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;

// Poucas tentativas e prazo curto: o vigia roda com a queda em curso, dentro do tempo que sobra do scan.
// O `httpRetry` imprime o `context` no log PÚBLICO quando a Binance responde 429/5xx: nunca pôr aqui o símbolo (revelaria qual operação está sendo vigiada). Achado do Codex, PR #572.
const FIXED_CONTEXT = 'vigia (velas de 15 min)';
const RETRY = { maxRetries: 2, baseDelayMs: 250, attemptTimeoutMs: 10_000 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** O símbolo do retrato (dado do banco) pode entrar na URL? Só letras maiúsculas e números, 2 a 20 caracteres. */
export const isValidSymbol = (symbol) => typeof symbol === 'string' && SYMBOL_RE.test(symbol);

function parseRow(r) {
  if (!Array.isArray(r) || r.length < 5) return null;
  const [openTime, open, high, low, close] = [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])];
  return [openTime, open, high, low, close].every(isNum) ? { openTime, open, high, low, close } : null;
}

/**
 * @param {{ symbol: string, startMs: number, nowMs: number, maxPages?: number, fetchFn?: Function }} p
 * @returns {Promise<{ ok: true, candles: Array<{openTime:number, open:number, high:number, low:number, close:number}>, pages: number } | { ok: false, reason: string }>}
 */
export async function fetchClosedCandles15m({ symbol, startMs, nowMs, maxPages = DEFAULT_MAX_PAGES, fetchFn = fetchWithRetry } = {}) {
  if (!isValidSymbol(symbol)) return { ok: false, reason: 'simbolo_invalido' };
  if (!isNum(startMs) || !isNum(nowMs)) return { ok: false, reason: 'relogio_invalido' };
  if (startMs > nowMs) return { ok: true, candles: [], pages: 0 };

  const byOpen = new Map();
  let cursor = startMs;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) return { ok: false, reason: 'janela_longa' };
    pages += 1;
    let rows;
    try {
      const url = `${BINANCE_BASE_URL}/klines?symbol=${symbol}&interval=15m&startTime=${cursor}&limit=${PAGE_LIMIT}`;
      const res = await fetchFn(url, { context: FIXED_CONTEXT, ...RETRY });
      if (!res?.ok) return { ok: false, reason: `http_${Number.isInteger(res?.status) ? res.status : 0}` };
      rows = await res.json();
    } catch {
      // De propósito não olhamos `err.message`: pode conter a URL.
      return { ok: false, reason: 'rede' };
    }
    if (!Array.isArray(rows)) return { ok: false, reason: 'resposta_invalida' };
    let last = cursor - CANDLE_MS;
    for (const r of rows) {
      const c = parseRow(r);
      if (!c) return { ok: false, reason: 'resposta_invalida' };
      byOpen.set(c.openTime, c);
      if (c.openTime > last) last = c.openTime;
    }
    // Página incompleta = acabou. Página cheia pede a próxima, a partir da vela seguinte à última, enquanto ainda houver vela a fechar.
    if (rows.length < PAGE_LIMIT) break;
    cursor = last + CANDLE_MS;
    if (cursor + CANDLE_MS > nowMs) break;
  }

  const candles = [...byOpen.values()]
    .filter((c) => c.openTime + CANDLE_MS <= nowMs) // só vela FECHADA decide
    .sort((a, b) => a.openTime - b.openTime);
  return { ok: true, candles, pages };
}
