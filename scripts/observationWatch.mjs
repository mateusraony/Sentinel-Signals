// Modo de observação sem banco, fase O2a (docs/known-risks.md item 299): o núcleo PURO do vigia de stop/alvo.
//
// O que decide: dado o RETRATO do estado (O1) e as velas de 15 min já fechadas desde então, quais operações vivas tocaram stop, TP1 ou TP2
// enquanto o Postgres estava fora do ar. NÃO escreve em lugar nenhum, NÃO fala com a Binance nem com o Telegram: quem faz I/O é a O2b.
//
// Regras do MOTOR, reaproveitadas (importadas, não copiadas, para o vigia não divergir do que o painel faria com o banco no ar):
//   - `isCandleUsableForExits` + `getEntryReferenceTime` (P0-c/P0-g): vela que ABRE antes da entrada não vale;
//   - `resolveCandleExit`: stop e alvo na mesma vela => o stop vence, com a ambiguidade marcada;
//   - `closesFullyAtTp1`: TP1 que fecha a posição inteira (`partial_percent` 100) é terminal.
// Depois do TP1 o stop vai para a ENTRADA (nunca piora um stop já melhor: mesma regra de `clampMonotonicStop`). O vigia NÃO replica o trailing por
// ATR, nem Time Stop, Chop Exit ou invalidação: isso é a O3. A mensagem diz que o acompanhamento depois do TP1 é manual.
//
// Sem relógio global e sem I/O: o tempo e as velas entram por parâmetro (travado por scripts/observationTripwire.test.js).
import { isCandleUsableForExits, getEntryReferenceTime, resolveCandleExit, closesFullyAtTp1 } from '../src/lib/opExitRules.js';
import { SNAPSHOT_VERSION } from './observationSnapshot.mjs';

export const CANDLE_MS = 15 * 60 * 1000;

/** Decisão do usuário: confiar no retrato até 2 h. A idade conta no INÍCIO da queda (durante ela o Postgres fica congelado e o retrato não envelhece de verdade). */
export const MAX_SNAPSHOT_AGE_AT_OUTAGE_MS = 2 * 60 * 60 * 1000;

/** Os 4 avisos que o vigia sabe dar. `tp1_full` = TP1 que encerra a posição inteira (sem runner). */
export const WATCH_EVENTS = Object.freeze(['tp1', 'tp1_full', 'tp2', 'stop']);

export const EPISODE_STATUSES = Object.freeze(['watching', 'stale', 'no_snapshot']);

const MAX_KEY_LENGTH = 200; // o RTDB aceita até 768 bytes por chave; ids reais têm dezenas de caracteres

// ── Chave do RTDB ────────────────────────────────────────────────────────────────────────────────────────────────────
// O RTDB proíbe `. $ # [ ] /` em chave. O id da operação pode ter qualquer caractere, e duas operações NÃO podem cair na mesma chave (o aviso de uma
// calaria a outra). Codificação injetiva: letras, números, `_` e `-` ficam; todo o resto (inclusive o próprio `~`) vira `~` + 4 dígitos hexadecimais.

/** @returns {string|null} a chave segura, ou null se o id não presta para chave. */
export function encodeKeyPart(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    out += /[A-Za-z0-9_-]/.test(ch) ? ch : `~${value.charCodeAt(i).toString(16).padStart(4, '0')}`;
  }
  return out.length > MAX_KEY_LENGTH ? null : out;
}

/** Caminho do aviso dentro do livro do episódio: `<operação codificada>/<evento>`. */
export function ledgerKey(opId, event) {
  const op = encodeKeyPart(opId);
  if (!op || !WATCH_EVENTS.includes(event)) return null;
  return `${op}/${event}`;
}

// ── Avaliação de uma operação ────────────────────────────────────────────────────────────────────────────────────────

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const positive = (v) => isNum(v) && v > 0;

function validOperation(op) {
  if (!op || typeof op !== 'object') return false;
  if (typeof op.id !== 'string' || op.id.length === 0) return false;
  if (op.side !== 'BUY' && op.side !== 'SELL') return false;
  if (!positive(op.entry_price) || !positive(op.current_stop) || !positive(op.tp1)) return false;
  if (op.tp2_cap_disabled !== true && !positive(op.tp2)) return false;
  return true;
}

/**
 * Referência de entrada do motor, mas ilegível NÃO pode calar o vigia: `isCandleUsableForExits` compara com `>=` e um texto que vira NaN
 * daria "nenhuma vela vale" para sempre. Ilegível = sem referência = avalia (o mesmo fallback que o motor dá a uma operação antiga).
 */
function entryReference(op) {
  const ref = getEntryReferenceTime(op);
  return ref && Number.isFinite(Date.parse(ref)) ? ref : null;
}

/**
 * Avalia UMA operação contra as velas de 15 min já fechadas.
 *
 * @param {{ op: object, candles: Array<{openTime:number, high:number, low:number}>, snapshotAtMs: number, nowMs: number }} p
 * @returns {{ ok: true, events: Array<{event:string, level:number, candleOpen:number, ambiguous:boolean}>, final: {terminal:boolean, tp1Hit:boolean, stop:number} }
 *          | { ok: false, reason: string }}
 */
export function evaluateOperation({ op, candles, snapshotAtMs, nowMs } = {}) {
  if (!isNum(snapshotAtMs) || !isNum(nowMs)) return { ok: false, reason: 'relogio_invalido' };
  if (!validOperation(op)) return { ok: false, reason: 'operacao_invalida' };
  if (!Array.isArray(candles)) return { ok: false, reason: 'velas_invalidas' };
  for (const c of candles) {
    // Pular uma vela ruim poderia esconder justamente o toque no stop: falha em vez de ignorar.
    if (!c || !isNum(c.openTime) || !isNum(c.high) || !isNum(c.low)) return { ok: false, reason: 'vela_invalida' };
  }

  const isBuy = op.side === 'BUY';
  const entryRef = entryReference(op);
  const fullCloseAtTp1 = closesFullyAtTp1(op);

  let tp1Hit = op.tp1_hit === true || op.status === 'RUNNER_ACTIVE';
  let stop = op.current_stop;
  let terminal = false;
  const events = [];

  const ordered = [...candles].sort((a, b) => a.openTime - b.openTime);
  for (const c of ordered) {
    if (terminal) break;
    if (c.openTime + CANDLE_MS > nowMs) continue; // ainda aberta: só vela FECHADA decide
    if (c.openTime + CANDLE_MS <= snapshotAtMs) continue; // terminou antes do retrato: o motor já a tinha visto
    if (!isCandleUsableForExits(new Date(c.openTime).toISOString(), entryRef)) continue; // P0-g: abriu antes da entrada

    const stopTouched = isBuy ? c.low <= stop : c.high >= stop;

    if (!tp1Hit) {
      const tp1Touched = isBuy ? c.high >= op.tp1 : c.low <= op.tp1;
      const { stopWins, ambiguous } = resolveCandleExit({ stopTouched, targetTouched: tp1Touched });
      if (stopWins) {
        events.push({ event: 'stop', level: stop, candleOpen: c.openTime, ambiguous });
        terminal = true;
      } else if (tp1Touched) {
        if (fullCloseAtTp1) {
          events.push({ event: 'tp1_full', level: op.tp1, candleOpen: c.openTime, ambiguous: false });
          terminal = true;
        } else {
          events.push({ event: 'tp1', level: op.tp1, candleOpen: c.openTime, ambiguous: false });
          tp1Hit = true;
          // O stop sobe para a entrada a partir da vela SEGUINTE (P0-d) e nunca piora um stop que já estava melhor.
          stop = isBuy ? Math.max(stop, op.entry_price) : Math.min(stop, op.entry_price);
        }
      }
    } else {
      const tp2Touched = op.tp2_cap_disabled !== true && (isBuy ? c.high >= op.tp2 : c.low <= op.tp2);
      const { stopWins, ambiguous } = resolveCandleExit({ stopTouched, targetTouched: tp2Touched });
      if (stopWins) {
        events.push({ event: 'stop', level: stop, candleOpen: c.openTime, ambiguous });
        terminal = true;
      } else if (tp2Touched) {
        events.push({ event: 'tp2', level: op.tp2, candleOpen: c.openTime, ambiguous: false });
        terminal = true;
      }
    }
  }

  return { ok: true, events, final: { terminal, tp1Hit, stop } };
}

/**
 * Faltou alguma vela fechada entre `firstOpenMs` e agora? Uma vela ausente poderia esconder justamente o toque no stop, então o chamador trata
 * `ok: false` como "sem dado confiável nesta passada" (tenta de novo na próxima), nunca como "nada aconteceu".
 */
export function checkCandleCoverage({ candles, firstOpenMs, nowMs } = {}) {
  if (!Array.isArray(candles) || !isNum(firstOpenMs) || !isNum(nowMs)) return { ok: false, missing: Number.POSITIVE_INFINITY };
  const have = new Set(candles.filter((c) => c && isNum(c.openTime)).map((c) => c.openTime));
  let missing = 0;
  for (let open = firstOpenMs; open + CANDLE_MS <= nowMs; open += CANDLE_MS) {
    if (!have.has(open)) missing += 1;
  }
  return { ok: missing === 0, missing };
}

// ── Livro de avisos ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Dos eventos achados, quais ainda NÃO foram avisados neste episódio? `sent` é o livro `{ <operação codificada>: { <evento>: {...} } }`.
 * Id inválido => nada pendente: sem chave não dá para marcar o aviso como enviado depois, e enviar sem poder marcar repetiria a cada passada.
 */
export function pendingEvents({ opId, events, sent } = {}) {
  const key = encodeKeyPart(opId);
  if (!key || !Array.isArray(events)) return [];
  const book = sent && typeof sent === 'object' && !Array.isArray(sent) ? sent[key] : null;
  const done = book && typeof book === 'object' && !Array.isArray(book) ? book : {};
  return events.filter((e) => WATCH_EVENTS.includes(e?.event) && !Object.prototype.hasOwnProperty.call(done, e.event));
}

// ── Retrato e episódio ───────────────────────────────────────────────────────────────────────────────────────────────

/** O retrato lido do RTDB serve? (versão conhecida, carimbo legível, lista de operações). */
export function isUsableSnapshot(snapshot) {
  return Boolean(
    snapshot && typeof snapshot === 'object'
    && snapshot.version === SNAPSHOT_VERSION
    && typeof snapshot.snapshot_at === 'string'
    && Number.isFinite(Date.parse(snapshot.snapshot_at))
    && Array.isArray(snapshot.operations),
  );
}

function validEpisode(ep) {
  return Boolean(
    ep && typeof ep === 'object' && !Array.isArray(ep)
    && !ep.ended_at
    && EPISODE_STATUSES.includes(ep.status)
    && typeof ep.started_at === 'string' && Number.isFinite(Date.parse(ep.started_at))
    // O Realtime Database NÃO guarda `null`: um episódio gravado com `snapshot_at: null` ("sem retrato") volta da leitura SEM o campo.
    && (ep.snapshot_at == null || (typeof ep.snapshot_at === 'string' && Number.isFinite(Date.parse(ep.snapshot_at)))),
  );
}

/**
 * Abre ou continua o episódio da queda.
 *
 * A regra das 2 h olha o retrato NO INÍCIO da queda: no 1º passo compara `agora − snapshot_at`; nos seguintes mantém o veredito gravado. Comparar a cada
 * passada desligaria o vigia 2 h depois do início, justamente quando ele mais importa (a queda real de 19/10 a 04/11 durou dias).
 *
 * Um episódio é reaproveitado só se NÃO foi encerrado e é do MESMO retrato. Qualquer outra coisa (encerrado, retrato novo, registro ilegível) abre outro.
 *
 * @returns {{ kind: 'start'|'continue', episode: object } | { kind: 'invalid', reason: string }}
 */
export function decideEpisode({ episode, snapshot, nowMs } = {}) {
  if (!isNum(nowMs)) return { kind: 'invalid', reason: 'relogio_invalido' };
  const usable = isUsableSnapshot(snapshot);
  const snapshotAt = usable ? snapshot.snapshot_at : null;

  if (validEpisode(episode) && (episode.snapshot_at ?? null) === snapshotAt) {
    return { kind: 'continue', episode: { ...episode, snapshot_at: snapshotAt } };
  }

  let status = 'no_snapshot';
  if (usable) status = nowMs - Date.parse(snapshotAt) > MAX_SNAPSHOT_AGE_AT_OUTAGE_MS ? 'stale' : 'watching';
  return {
    kind: 'start',
    episode: {
      started_at: new Date(nowMs).toISOString(),
      snapshot_at: snapshotAt,
      status,
      alerts_sent: 0,
      start_notice_sent: false,
    },
  };
}
