/**
 * Telegram Notification Service
 * Config + filters stored in localStorage. Uses Telegram Bot API directly from browser.
 * Filters (timeframes, min_priority, signal_types, events, min_score) are checked
 * before sending — ensuring only configured signals reach Telegram.
 *
 * Auditoria do Telegram, Fase 4 (2026-10-02) — o corpo de cada mensagem
 * (os `build*Message` abaixo) mora em `src/lib/notificationTemplates.js`,
 * compartilhado com `scripts/adminTelegram.js`. Este arquivo continua
 * decidindo SE envia (shouldSend, filtros) e COMO envia (send, credencial
 * em localStorage) — só o texto da mensagem deixou de ser duplicado à mão.
 * Ver `docs/known-risks.md` item 250.
 */
import { logWarn } from './logger';
import {
  buildSignalDetectedMessage, buildVerificationTaskMessage, buildSignalCanceledMessage,
  buildTradeCreatedMessage, buildTp1HitMessage, buildTp2HitMessage, buildStopHitMessage,
  buildInvalidatedMessage, buildTimeStopMessage, buildChopExitMessage,
} from './notificationTemplates';

const STORAGE_KEY = 'cryptoradar_telegram_cfg';
const FILTERS_KEY = 'tg_filters';

export function getTelegramConfig() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch (e) {
    logWarn('telegram', 'Config do Telegram corrompida no localStorage', { error: e.message });
    return {};
  }
}

export function setTelegramConfig(cfg) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function isTelegramConfigured() {
  const { botToken, chatId } = getTelegramConfig();
  return !!(botToken && chatId);
}

// ─── Filter storage (moved here to avoid circular imports) ───
const DEFAULT_FILTERS = {
  timeframes: ['1h', '4h', '1d'],
  min_priority: 'low',
  signal_types: ['BUY', 'SELL'],
  // invalidated/time_stop/chop_exit added 2026-07-18 (known-risks.md item
  // 29) — a closed/invalidated operation is at least as informative to the
  // user as a stop hit, so on by default like the other closure events.
  events: ['signal_detected', 'entry_confirmed', 'tp1_hit', 'tp2_hit', 'stop_hit', 'invalidated', 'time_stop', 'chop_exit', 'verification_task_created', 'signal_canceled'],
  min_score: 0,
  // Signal SOURCE (as opposed to the events above, which are trade-lifecycle
  // moments). Only matters for signal_detected — see shouldSend. No migration
  // flag needed for pre-existing saved filters missing this key: `f.sources
  // && ...` in shouldSend already short-circuits to "unfiltered" on absence,
  // which IS the non-breaking default.
  sources: ['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi'],
};

// Event IDs added after filters could already be saved in localStorage
// (known-risks.md item 29, Codex review PR #60) — merged ONCE into old saved
// filters below so a user who saved BEFORE this change still gets them on by
// default, matching DEFAULT_FILTERS, instead of silently missing until they
// open Settings. Guarded by MIGRATION_FLAG and persisted immediately so a
// later deliberate opt-out (unchecking the toggle) sticks — without the
// flag, every read would treat the still-missing event as "old data" again
// and re-add it forever.
const NEW_EVENTS_2026_07_18 = ['invalidated', 'time_stop', 'chop_exit'];
const MIGRATION_FLAG = '_migratedEvents20260718';

// Same one-time merge, for the verification-task notification added later —
// a user who saved filters BEFORE this change must still get it by default,
// like DEFAULT_FILTERS, instead of silently missing it until they reopen
// Settings. Separate flag so it runs independently of the 2026-07-18 batch.
const NEW_EVENTS_2026_08_10 = ['verification_task_created'];
const MIGRATION_FLAG_2 = '_migratedEvents20260810';

// Fase 3 da auditoria do Telegram (2026-10-02) — mesmo mecanismo, para quem
// já salvou filtro antes de "signal_canceled" existir.
const NEW_EVENTS_2026_10_02 = ['signal_canceled'];
const MIGRATION_FLAG_3 = '_migratedEvents20261002';

export function getTelegramFilters() {
  try {
    const stored = JSON.parse(localStorage.getItem(FILTERS_KEY));
    if (!stored) return DEFAULT_FILTERS;
    let result = stored;
    let changed = false;
    if (!result[MIGRATION_FLAG] && Array.isArray(result.events)) {
      const missing = NEW_EVENTS_2026_07_18.filter((e) => !result.events.includes(e));
      result = { ...result, events: [...result.events, ...missing], [MIGRATION_FLAG]: true };
      changed = true;
    }
    if (!result[MIGRATION_FLAG_2] && Array.isArray(result.events)) {
      const missing = NEW_EVENTS_2026_08_10.filter((e) => !result.events.includes(e));
      result = { ...result, events: [...result.events, ...missing], [MIGRATION_FLAG_2]: true };
      changed = true;
    }
    if (!result[MIGRATION_FLAG_3] && Array.isArray(result.events)) {
      const missing = NEW_EVENTS_2026_10_02.filter((e) => !result.events.includes(e));
      result = { ...result, events: [...result.events, ...missing], [MIGRATION_FLAG_3]: true };
      changed = true;
    }
    if (changed) setTelegramFilters(result);
    return result;
  } catch (e) {
    logWarn('telegram', 'Filtros do Telegram corrompidos no localStorage, usando defaults', { error: e.message });
    return DEFAULT_FILTERS;
  }
}

// Mirrors filters.sources to Firestore (telegramFilters/current) so the 24/7
// cron channel (scripts/adminTelegram.js — no localStorage there) can honor
// the same signal-source preference the browser Settings screen sets. Same
// sync pattern already used for strategyConfig/current (pineParser.js), and
// the same dynamic import to avoid a static circular import.
export async function setTelegramFilters(filters) {
  localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  try {
    const { backend } = await import('@/api/entities');
    await backend.entities.TelegramFilters.set('current', { sources: filters.sources ?? DEFAULT_FILTERS.sources });
  } catch (e) {
    logWarn('telegram', 'Falha ao sincronizar filtro de origem com o canal 24h', { error: e.message });
  }
}

// ─── Filter evaluation ───
const PRIORITY_RANK = { low: 0, medium: 1, high: 2 };
// Fail-open for any source outside this list — mirrors the pre-existing
// SOURCE_LABELS fallback (unrecognized/future source → generic "RF" label,
// never silently dropped). Filtering only applies to KNOWN sources the user
// actually had a toggle for; an unrecognized value must keep reaching the
// user, the same way it already keeps reaching them today, unlabeled.
const KNOWN_SOURCES = ['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi'];

/**
 * Check if a notification should be sent based on configured filters.
 * @param {string} event - 'signal_detected' | 'entry_confirmed' | 'tp1_hit' | 'tp2_hit' | 'stop_hit'
 * @param {Object} data - signal or trade operation data
 * @param {Object} [asset] - MonitoredAsset the signal belongs to, only used
 *   (and only needed) for signal_detected — see notify_sources/
 *   notify_signal_types below. Omitted entirely for trade-lifecycle events.
 * @returns {boolean}
 */
function shouldSend(event, data, asset) {
  const f = getTelegramFilters();

  // Event filter
  if (f.events && !f.events.includes(event)) return false;

  // Signal-source filter (RF/SMC/MACD/EMA Cross/RSI) — gated to
  // signal_detected/signal_canceled on purpose. Those are the only events
  // whose payload is a SignalEvent using this source vocabulary; every other
  // event's payload is a TradeOperation, whose OWN `source` field is a
  // different, unrelated enum (scanner/scanner_smc/tradingview_webhook/
  // manual — see docs/schema-reference/TradeOperation.jsonc). Checking
  // data.source unconditionally would collide with that field and silently
  // drop every entry/TP/stop notification. signal_canceled (Fase 3, 2026-
  // 10-02) shares signal_detected's exact payload shape — same SignalEvent,
  // same source field — so it belongs in the same exception, not a new one.
  //
  // Per-asset override (known-risks item 47): asset.notify_sources, when
  // set, REPLACES the global f.sources for this asset entirely (not
  // intersected) — same "explicit per-asset value wins" convention already
  // used by rsi_overbought/rsi_oversold. Absent = inherit the global filter.
  if (event === 'signal_detected' || event === 'signal_canceled') {
    const sources = asset?.notify_sources ?? f.sources;
    if (sources && KNOWN_SOURCES.includes(data.source) && !sources.includes(data.source)) return false;
  }

  // Timeframe filter — signal_timeframe (4h/1h) when present, since that's
  // what the UI lets the user pick from. data.timeframe alone would be the
  // ENTRY-confirmation candle (15m/5m) for trade-lifecycle events, which
  // never matches any configured filter and silently drops every
  // entry/TP/stop notification (only signal_detected/signal_canceled have a
  // matching value — same SignalEvent payload shape, see source filter above).
  const tf = data.signal_timeframe || data.timeframe;
  if (f.timeframes && tf && !f.timeframes.includes(tf)) return false;

  // Signal type filter (BUY/SELL). Per-asset override, signal_detected/
  // signal_canceled only — same reasoning and precedence as the source
  // filter above: a muted side for THIS asset's new-signal alerts must never
  // also silence a legitimately open position's TP/stop notifications on
  // that same asset.
  const side = data.signal_type || data.side;
  const signalTypes = ((event === 'signal_detected' || event === 'signal_canceled') && asset?.notify_signal_types) || f.signal_types;
  if (signalTypes && side && !signalTypes.includes(side)) return false;

  // Priority filter
  if (f.min_priority && f.min_priority !== 'low') {
    const dataPriority = data.priority || (data.score >= 85 ? 'high' : data.score >= 75 ? 'medium' : 'low');
    if (PRIORITY_RANK[dataPriority] < PRIORITY_RANK[f.min_priority]) return false;
  }

  // Score filter
  if (f.min_score && f.min_score > 0) {
    const score = data.score || data.context?.score || 0;
    if (score < f.min_score) return false;
  }

  return true;
}

// Returns whether the message was actually delivered (2xx from Telegram) —
// mirrors scripts/adminTelegram.js's send(), which already has this contract.
// Existing callers here just `return send(...)` or `.catch(() => {})` the
// promise without inspecting the resolved value, so adding a real boolean
// (instead of always resolving undefined) doesn't change their behavior —
// only notifyVerificationTask's caller (scanner.js) reads it, to avoid
// recording a delivery that didn't happen (Codex review, PR #159 follow-up).
async function send(html) {
  const { botToken, chatId } = getTelegramConfig();
  if (!botToken || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn('[Telegram] send failed:', res.status, body);
      // item 166 Fase 2: só console.warn deixava a falha invisível — nem o
      // Debug Log do painel nem scripts/health-audit.mjs (que só lê
      // SystemLog) saberiam que o canal de alerta parou.
      logWarn('telegram', 'Falha ao enviar mensagem ao Telegram', { status: res.status, body });
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[Telegram] send failed:', e.message);
    logWarn('telegram', 'Falha ao enviar mensagem ao Telegram (exceção)', { error: e.message });
    return false;
  }
}

export async function notifyNewSignal(signal, asset) {
  if (!shouldSend('signal_detected', signal, asset)) return;
  return send(buildSignalDetectedMessage(signal));
}

// signal here is the SignalEvent that triggered the VerificationTask (same
// shape notifyNewSignal receives) — used both on automatic creation
// (scanner.js) and on manual resend from the dedicated Verification page.
export async function notifyVerificationTask(signal, asset) {
  if (!shouldSend('verification_task_created', signal, asset)) return false;
  return send(buildVerificationTaskMessage(signal));
}

export async function notifySignalCanceled(signal, asset) {
  if (!shouldSend('signal_canceled', signal, asset)) return;
  return send(buildSignalCanceledMessage(signal));
}

export async function notifyTradeCreated(op) {
  if (!shouldSend('entry_confirmed', op)) return;
  return send(buildTradeCreatedMessage(op));
}

export async function notifyTP1Hit(op, price) {
  if (!shouldSend('tp1_hit', op)) return;
  return send(buildTp1HitMessage(op, price));
}

export async function notifyTP2Hit(op, price) {
  if (!shouldSend('tp2_hit', op)) return;
  return send(buildTp2HitMessage(op, price));
}

export async function notifyStopHit(op, price) {
  if (!shouldSend('stop_hit', op)) return;
  return send(buildStopHitMessage(op, price));
}

export async function notifyInvalidated(op, price) {
  if (!shouldSend('invalidated', op)) return;
  return send(buildInvalidatedMessage(op, price));
}

export async function notifyTimeStop(op, price) {
  if (!shouldSend('time_stop', op)) return;
  return send(buildTimeStopMessage(op, price));
}

export async function notifyChopExit(op, price) {
  if (!shouldSend('chop_exit', op)) return;
  return send(buildChopExitMessage(op, price));
}
