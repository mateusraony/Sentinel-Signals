/**
 * Telegram Notification Service
 * The bot token is an app-level Cloud Functions secret — the browser never
 * sees it. Each user only configures their destination chat_id, cached here
 * in localStorage for instant reads and synced to Firestore (telegramConfig)
 * so the telegramNotify Cloud Function can look it up server-side. Filters
 * (timeframes, min_priority, signal_types, events, min_score) are checked
 * before sending — ensuring only configured signals reach Telegram.
 */
import { doc, setDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions } from '@/lib/firebaseClient';

const STORAGE_KEY = 'cryptoradar_telegram_cfg';
const FILTERS_KEY = 'tg_filters';

export function getTelegramConfig() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
}

export function setTelegramConfig(cfg) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  const uid = auth.currentUser?.uid;
  if (uid && cfg.chatId) {
    setDoc(doc(db, 'telegramConfig', uid), { chatId: cfg.chatId }, { merge: true })
      .catch((e) => console.warn('[Telegram] failed to sync chat_id to Firestore:', e.message));
  }
}

export function isTelegramConfigured() {
  const { chatId } = getTelegramConfig();
  return !!chatId;
}

// ─── Filter storage (moved here to avoid circular imports) ───
const DEFAULT_FILTERS = {
  timeframes: ['1h', '4h', '1d'],
  min_priority: 'low',
  signal_types: ['BUY', 'SELL'],
  events: ['signal_detected', 'entry_confirmed', 'tp1_hit', 'tp2_hit', 'stop_hit'],
  min_score: 0,
};

export function getTelegramFilters() {
  try { return JSON.parse(localStorage.getItem(FILTERS_KEY)) || DEFAULT_FILTERS; }
  catch { return DEFAULT_FILTERS; }
}

export function setTelegramFilters(filters) {
  localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
}

// ─── Filter evaluation ───
const PRIORITY_RANK = { low: 0, medium: 1, high: 2 };

/**
 * Check if a notification should be sent based on configured filters.
 * @param {string} event - 'signal_detected' | 'entry_confirmed' | 'tp1_hit' | 'tp2_hit' | 'stop_hit'
 * @param {Object} data - signal or trade operation data
 * @returns {boolean}
 */
function shouldSend(event, data) {
  const f = getTelegramFilters();

  // Event filter
  if (f.events && !f.events.includes(event)) return false;

  // Timeframe filter
  const tf = data.timeframe;
  if (f.timeframes && tf && !f.timeframes.includes(tf)) return false;

  // Signal type filter (BUY/SELL)
  const side = data.signal_type || data.side;
  if (f.signal_types && side && !f.signal_types.includes(side)) return false;

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
  const { chatId } = getTelegramConfig();
  if (!chatId) return;
  try {
    const notify = httpsCallable(functions, 'telegramNotify');
    await notify({ text: html });
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

export async function notifyNewSignal(signal) {
  if (!shouldSend('signal_detected', signal)) return;
  const emoji = signal.signal_type === 'BUY' ? '🟢' : '🔴';
  const dir = signal.signal_type === 'BUY' ? '📈 COMPRA' : '📉 VENDA';
  const strength = { strong: '💪 Forte', moderate: '📊 Moderado', weak: '🔹 Fraco' }[signal.strength] || '';
  return send(
    `${emoji} <b>Novo Sinal RF Detectado</b>\n\n` +
    `<b>${signal.symbol?.replace('USDT', '/USDT')}</b> | ${signal.timeframe?.toUpperCase()} | ${dir}\n` +
    `💰 Preço: $${fmtP(signal.price_at_signal)}\n` +
    `📊 Score: ${signal.context?.score || 0}/100 ${strength}\n` +
    `📝 ${signal.reason || ''}\n\n` +
    `<i>⏳ Aguardando confirmação de entrada — CryptoRadar</i>`
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
    `🔒 Gestão: ${op.partial_percent || 50}% no TP1, runner ${op.runner_percent || 50}%\n\n` +
    `<i>⚡ CryptoRadar</i>`
  );
}

export async function notifyTP1Hit(op, price) {
  if (!shouldSend('tp1_hit', op)) return;
  return send(
    `🎯 <b>TP1 Atingido!</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n` +
    `💰 Preço atual: $${fmtP(price)}\n` +
    `✅ ${op.partial_percent || 50}% da posição realizada\n` +
    `🔄 Stop movido para breakeven: $${fmtP(op.entry_price)}\n` +
    `🏃 Runner ${op.runner_percent || 50}% ativo — aguardando TP2: $${fmtP(op.tp2)}\n\n` +
    `<i>⚡ CryptoRadar — gerencie o runner</i>`
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