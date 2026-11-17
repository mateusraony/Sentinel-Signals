// Contexto de Mercado — Fase 4b (docs/known-risks.md item 285, addendum 27): o que o BTC fez nas últimas divulgações do MESMO tipo.
// Busca as velas de 1 min (Binance Spot, `data-api.binance.vision`, sem chave) de cada divulgação passada e mede o movimento em +5, +30 e +60 min
// com as mesmas funções da medição de reação (`contextReaction.mjs`: referência = fechamento do minuto antes da divulgação; janela incompleta = sem número,
// nunca completada com vela vizinha). É MEDIDO, NÃO PREVISTO: descreve o passado com o número de casos à vista, sem direção e sem probabilidade.
//
// Sem banco, sem Telegram, sem segredo (a Binance não pede chave). Falha de rede de UMA divulgação vira "sem dado" daquela linha; nunca lança.
import { fetchWindow } from './context-reaction.mjs';
import { reactionAt, median, OFFSETS_MIN } from './contextReaction.mjs';
import { KIND_TIMES } from './contextCalendar.mjs';
import { nyToUtc } from './contextTime.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { HISTORY_FILE, parseHistory, lastDates } from './contextHistory.mjs';

const MIN = 60 * 1000;
export const REACTION_COUNT = 3;

const releaseMs = (kind, date) => {
  try { return nyToUtc(date, KIND_TIMES[kind])?.ms ?? null; } catch { return null; }
};

/**
 * As reações do BTC nas últimas `count` divulgações passadas do tipo (da mais recente à mais antiga). Tipo sem histórico → lista vazia.
 * Cada linha: `{ date, reaction }`; `reaction` é `{ moves: { 5, 30, 60 }, rangePct }` (em %) ou `null` quando faltou dado.
 * @param {{ kind: string, history: unknown, count?: number, fetchImpl?: Function, env?: object, sleep?: Function }} p
 */
export async function loadReactions({ kind, history, count = REACTION_COUNT, fetchImpl, env = {}, sleep }) {
  const rows = [];
  for (const date of lastDates(history, kind, count)) {
    const t0 = releaseMs(kind, date);
    let reaction = null;
    if (t0 !== null) {
      try {
        const candles = await fetchWindow(t0, { fetchImpl, env, ...(sleep ? { sleep } : {}) });
        reaction = candles ? reactionAt(candles, t0) : null;
      } catch {
        reaction = null; // (fetchWindow já trata a rede; isto é só o cinto de segurança)
      }
    }
    rows.push({ date, reaction });
  }
  return rows;
}

/** Resumo para a mensagem: quantos casos tiveram número, a mediana do TAMANHO do movimento em 60 min e a contagem de quantas vezes subiu e caiu. */
export function summarizeReactions(rows) {
  const ok = (Array.isArray(rows) ? rows : []).filter((r) => r?.reaction);
  const m60 = ok.map((r) => r.reaction.moves[60]);
  return {
    total: Array.isArray(rows) ? rows.length : 0,
    n: ok.length,
    medAbs60: median(m60.map((x) => Math.abs(x))),
    up60: m60.filter((x) => x > 0).length,
    down60: m60.filter((x) => x < 0).length,
  };
}

/** O `history.json` da pasta da branch `context-data`; ausente ou ilegível = histórico vazio (a mensagem diz "ainda sem histórico"). Nunca lança. */
export function readHistoryFile(dir) {
  try {
    return parseHistory(JSON.parse(fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8')));
  } catch {
    return parseHistory(null);
  }
}

/**
 * O movimento do BTC DESDE a divulgação até agora: `{ 5, 30, 60 }` em %, cada um `null` enquanto aquele prazo não terminou (a vela de 1 min do prazo precisa
 * já ter FECHADO: a que ainda está se formando tem preço provisório) ou se a vela faltar. A referência é a mesma da medição (fechamento do minuto antes).
 * Devolve `null` se não há nem a vela de referência.
 */
export function partialMoves(candles, t0Ms, nowMs) {
  const byOpen = new Map((candles ?? []).map((c) => [c.t, c]));
  const ref = byOpen.get(t0Ms - MIN);
  if (!ref) return null;
  const moves = {};
  for (const n of OFFSETS_MIN) {
    const c = byOpen.get(t0Ms + (n - 1) * MIN);
    moves[n] = c && t0Ms + n * MIN <= nowMs ? (c.c / ref.c - 1) * 100 : null;
  }
  return moves;
}

/** Busca as velas e devolve o movimento parcial desde `t0Ms` (ver `partialMoves`); `null` se a fonte não respondeu. Nunca lança. */
export async function loadMovesSince({ t0Ms, nowMs, fetchImpl, env = {}, sleep }) {
  try {
    const candles = await fetchWindow(t0Ms, { fetchImpl, env, ...(sleep ? { sleep } : {}) });
    return candles ? partialMoves(candles, t0Ms, nowMs) : null;
  } catch {
    return null;
  }
}
