/**
 * Telegram Notification Service
 * Config + filters stored in localStorage. Uses Telegram Bot API directly from browser.
 * Filters (timeframes, min_priority, signal_types, events, min_score) are checked
 * before sending — ensuring only configured signals reach Telegram.
 */
import { logWarn } from './logger';
import { closesFullyAtTp1 } from './opExitRules';

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
  events: ['signal_detected', 'entry_confirmed', 'tp1_hit', 'tp2_hit', 'stop_hit', 'invalidated', 'time_stop', 'chop_exit', 'verification_task_created'],
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
  // signal_detected on purpose. That's the only event whose payload is a
  // SignalEvent using this source vocabulary; every other event's payload is
  // a TradeOperation, whose OWN `source` field is a different, unrelated
  // enum (scanner/scanner_smc/tradingview_webhook/manual — see
  // docs/schema-reference/TradeOperation.jsonc). Checking data.source
  // unconditionally would collide with that field and silently drop every
  // entry/TP/stop notification.
  //
  // Per-asset override (known-risks item 47): asset.notify_sources, when
  // set, REPLACES the global f.sources for this asset entirely (not
  // intersected) — same "explicit per-asset value wins" convention already
  // used by rsi_overbought/rsi_oversold. Absent = inherit the global filter.
  if (event === 'signal_detected') {
    const sources = asset?.notify_sources ?? f.sources;
    if (sources && KNOWN_SOURCES.includes(data.source) && !sources.includes(data.source)) return false;
  }

  // Timeframe filter — signal_timeframe (4h/1h) when present, since that's
  // what the UI lets the user pick from. data.timeframe alone would be the
  // ENTRY-confirmation candle (15m/5m) for trade-lifecycle events, which
  // never matches any configured filter and silently drops every
  // entry/TP/stop notification (only signal_detected has a matching value).
  const tf = data.signal_timeframe || data.timeframe;
  if (f.timeframes && tf && !f.timeframes.includes(tf)) return false;

  // Signal type filter (BUY/SELL). Per-asset override, signal_detected only
  // — same reasoning and precedence as the source filter above: a muted
  // side for THIS asset's new-signal alerts must never also silence a
  // legitimately open position's TP/stop notifications on that same asset.
  const side = data.signal_type || data.side;
  const signalTypes = (event === 'signal_detected' && asset?.notify_signal_types) || f.signal_types;
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

async function send(html) {
  const { botToken, chatId } = getTelegramConfig();
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.warn('[Telegram] send failed:', e.message);
  }
}

function fmtP(p) {
  if (!p && p !== 0) return '—';
  if (p >= 10000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

// Codex review (PR #65): this used to hardcode "RF" and `context.score` for
// EVERY signal source — harmless while smc_structure/macd/ema_cross/rsi
// signals rarely reached here, but enabling the SMC cascade by default
// (known-risks.md item 9) makes source_structure signals a normal,
// frequent occurrence. Only 'range_filter' actually carries a real 0-100
// score (see scanner.js); the others don't, so `|| 0` was silently showing
// a fake "Score: 0/100" on a real, valid signal — reads as "this is a bad
// signal" when it's really just a different, non-scored signal type.
const SOURCE_LABELS = {
  range_filter: 'RF',
  smc_structure: 'SMC',
  macd: 'MACD',
  ema_cross: 'EMA',
  rsi: 'RSI',
};

export async function notifyNewSignal(signal, asset) {
  if (!shouldSend('signal_detected', signal, asset)) return;
  const emoji = signal.signal_type === 'BUY' ? '🟢' : '🔴';
  const dir = signal.signal_type === 'BUY' ? '📈 COMPRA' : '📉 VENDA';
  const strength = { strong: '💪 Forte', medium: '📊 Médio', moderate: '📊 Moderado', weak: '🔹 Fraco' }[signal.strength] || '';
  const sourceLabel = SOURCE_LABELS[signal.source] || 'RF';
  const scoreLine = Number.isFinite(signal.context?.score)
    ? `📊 Score: ${signal.context.score}/100 ${strength}\n`
    : (strength ? `📊 Força: ${strength}\n` : '');
  return send(
    `${emoji} <b>Novo Sinal ${sourceLabel} Detectado</b>\n\n` +
    `<b>${signal.symbol?.replace('USDT', '/USDT')}</b> | ${signal.timeframe?.toUpperCase()} | ${dir}\n` +
    `💰 Preço: $${fmtP(signal.price_at_signal)}\n` +
    scoreLine +
    `📝 ${signal.reason || ''}\n\n` +
    `<i>⏳ Aguardando confirmação de entrada — CryptoRadar</i>`
  );
}

// signal here is the SignalEvent that triggered the VerificationTask (same
// shape notifyNewSignal receives) — used both on automatic creation
// (scanner.js) and on manual resend from the dedicated Verification page.
export async function notifyVerificationTask(signal, asset) {
  if (!shouldSend('verification_task_created', signal, asset)) return;
  const emoji = signal.signal_type === 'BUY' ? '🟢' : '🔴';
  const dir = signal.signal_type === 'BUY' ? '📈 COMPRA' : '📉 VENDA';
  const sourceLabel = SOURCE_LABELS[signal.source] || 'RF';
  const scoreLine = Number.isFinite(signal.context?.score)
    ? `📊 Score: ${signal.context.score}/100\n`
    : '';
  return send(
    `✅ ${emoji} <b>Tarefa de Verificação Criada — ${sourceLabel}</b>\n\n` +
    `<b>${signal.symbol?.replace('USDT', '/USDT')}</b> | ${signal.timeframe?.toUpperCase()} | ${dir}\n` +
    `⭐ Prioridade: ALTA\n` +
    scoreLine +
    `📝 ${signal.reason || ''}\n\n` +
    `<i>🔎 Revise em /verification — CryptoRadar</i>`
  );
}

export async function notifyTradeCreated(op) {
  if (!shouldSend('entry_confirmed', op)) return;
  const emoji = op.side === 'BUY' ? '✅🟢' : '✅🔴';
  const dir = op.side === 'BUY' ? 'COMPRA' : 'VENDA';
  const tfLabel = op.timeframe === '15m' ? '15m (entrada 4h)' : op.timeframe?.toUpperCase();
  return send(
    `${emoji} <b>Entrada Confirmada — ${dir}</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${tfLabel}\n` +
    `📍 Entrada: $${fmtP(op.entry_price)}\n` +
    `🛑 Stop: $${fmtP(op.initial_stop)}\n` +
    `🎯 TP1: $${fmtP(op.tp1)}  |  TP2: $${fmtP(op.tp2)}\n` +
    `📊 Score: ${op.score}/100\n` +
    `🔒 Gestão: ${op.partial_percent ?? 50}% no TP1, runner ${op.runner_percent ?? 50}%\n\n` +
    `<i>⚡ CryptoRadar</i>`
  );
}

export async function notifyTP1Hit(op, price) {
  if (!shouldSend('tp1_hit', op)) return;
  return send(
    `🎯 <b>TP1 Atingido!</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n` +
    `💰 Preço atual: $${fmtP(price)}\n` +
    // Sem runner (known-risks item 46) o TP1 é saída TERMINAL — anunciar
    // "runner ativo, aguardando TP2" seria mentira no canal.
    (closesFullyAtTp1(op)
      ? `✅ Posição encerrada 100% no TP1\n\n<i>⚡ CryptoRadar — operação fechada</i>`
      : `✅ ${op.partial_percent ?? 50}% da posição realizada\n`
        + `🔄 Stop movido para breakeven: $${fmtP(op.entry_price)}\n`
        + `🏃 Runner ${op.runner_percent ?? 50}% ativo — aguardando TP2: $${fmtP(op.tp2)}\n\n`
        + `<i>⚡ CryptoRadar — gerencie o runner</i>`)
  );
}

export async function notifyTP2Hit(op, price) {
  if (!shouldSend('tp2_hit', op)) return;
  return send(
    `🏆 <b>TP2 Atingido — Operação Completa!</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n` +
    `💰 Preço: $${fmtP(price)}\n` +
    `📍 Entrada: $${fmtP(op.entry_price)} → TP2: $${fmtP(op.tp2)}\n\n` +
    `<i>✅ Lucro completo realizado — CryptoRadar</i>`
  );
}

export async function notifyStopHit(op, price) {
  if (!shouldSend('stop_hit', op)) return;
  const beMsg = op.tp1_hit ? '(breakeven — sem prejuízo)' : '(stop inicial)';
  return send(
    `🛑 <b>Stop Atingido ${beMsg}</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n` +
    `💰 Preço: $${fmtP(price)}\n` +
    `📍 Stop em: $${fmtP(op.current_stop)}\n\n` +
    `<i>⚡ CryptoRadar</i>`
  );
}

export async function notifyInvalidated(op, price) {
  if (!shouldSend('invalidated', op)) return;
  const stageMsg = op.tp1_hit ? '(após TP1 — parcial já realizada)' : '(pré-TP1)';
  return send(
    `⚠️ <b>Sinal Invalidado ${stageMsg}</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n` +
    `💰 Preço: $${fmtP(price)}\n` +
    `📍 Entrada: $${fmtP(op.entry_price)}\n\n` +
    `<i>🔄 Estrutura/tendência reverteu — CryptoRadar</i>`
  );
}

export async function notifyTimeStop(op, price) {
  if (!shouldSend('time_stop', op)) return;
  return send(
    `⏱️ <b>Time Stop — Operação Encerrada</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n` +
    `💰 Preço: $${fmtP(price)}\n` +
    `📍 Entrada: $${fmtP(op.entry_price)}\n\n` +
    `<i>⌛ Prazo máximo sem atingir TP1 — CryptoRadar</i>`
  );
}

export async function notifyChopExit(op, price) {
  if (!shouldSend('chop_exit', op)) return;
  return send(
    `🌊 <b>Chop Exit — Operação Encerrada</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n` +
    `💰 Preço: $${fmtP(price)}\n` +
    `📍 Entrada: $${fmtP(op.entry_price)}\n\n` +
    `<i>📉 Mercado lateralizado (choppiness alto) — CryptoRadar</i>`
  );
}