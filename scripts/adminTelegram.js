// Node/GitHub Actions counterpart to src/lib/telegram.js — same notify*()
// functions scanner.js calls, but the bot token and chat id come from
// GitHub Actions secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) instead of
// browser localStorage. Filters match telegram.js's own defaults (no UI to
// customize them here — this is the "don't miss anything" 24/7 channel),
// EXCEPT signal source, which the user CAN configure from the browser
// Settings screen — see loadTelegramSources below.
//
// Imports deste espelho: a regra pura que decide se o TP1 encerra a posição
// (compartilhada com telegram.js de propósito — se cada canal decidisse por
// conta, o do navegador e o das 24h anunciariam gestões diferentes para a
// MESMA operação; opExitRules já está no bundle do scan) e o cliente
// firebase-admin, mesmo padrão de scripts/adminPineConfig.js.
import { closesFullyAtTp1 } from '../src/lib/opExitRules.js';
import { getFirestore } from 'firebase-admin/firestore';

const DEFAULT_FILTERS = {
  timeframes: ['1h', '4h', '1d'],
  min_priority: 'low',
  signal_types: ['BUY', 'SELL'],
  events: ['signal_detected', 'entry_confirmed', 'tp1_hit', 'tp2_hit', 'stop_hit', 'invalidated', 'time_stop', 'chop_exit'],
  min_score: 0,
};

const DEFAULT_SOURCES = ['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi'];
// Fail-open for any source outside this list — mirrors src/lib/telegram.js's
// KNOWN_SOURCES: filtering only applies to sources the user actually had a
// toggle for; an unrecognized/future value must keep reaching the "don't
// miss anything" channel, never be silently dropped.
const KNOWN_SOURCES = DEFAULT_SOURCES;

// Lido de telegramFilters/current — o mesmo doc que a tela de Configurações
// do navegador escreve (src/lib/telegram.js:setTelegramFilters). Memoizado
// por PROCESSO (não por-passada): cada `npm run scan` é uma execução curta e
// isolada do GitHub Actions, então uma leitura por execução é correta e não
// fica desatualizada. Falha ao ler = fail-open para TODAS as origens — nunca
// silenciar o canal "não perder nada" por um erro transitório de rede/Firestore,
// mesmo espírito do fail-open de adminPineConfig.js:getPineConfig.
let sourcesPromise = null;
async function loadTelegramSources() {
  if (!sourcesPromise) {
    sourcesPromise = (async () => {
      try {
        const snap = await getFirestore().collection('telegramFilters').doc('current').get();
        const sources = snap.exists && Array.isArray(snap.data().sources) ? snap.data().sources : null;
        return sources ?? DEFAULT_SOURCES;
      } catch (e) {
        console.warn('[adminTelegram] Falha ao ler telegramFilters, notificando todas as origens:', e.message);
        return DEFAULT_SOURCES;
      }
    })();
  }
  return sourcesPromise;
}

const PRIORITY_RANK = { low: 0, medium: 1, high: 2 };

export function isTelegramConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function shouldSend(event, data) {
  const f = DEFAULT_FILTERS;
  if (f.events && !f.events.includes(event)) return false;

  // Signal-source filter — mesmo guard de evento de src/lib/telegram.js: só
  // signal_detected usa este vocabulário de `source` (RF/SMC/MACD/EMA/RSI);
  // os demais eventos carregam uma TradeOperation, cujo `source` é um enum
  // não relacionado (scanner/scanner_smc/tradingview_webhook/manual).
  if (event === 'signal_detected' && KNOWN_SOURCES.includes(data.source)) {
    const sources = await loadTelegramSources();
    if (!sources.includes(data.source)) return false;
  }

  // See src/lib/telegram.js for why signal_timeframe takes priority here.
  const tf = data.signal_timeframe || data.timeframe;
  if (f.timeframes && tf && !f.timeframes.includes(tf)) return false;

  const side = data.signal_type || data.side;
  if (f.signal_types && side && !f.signal_types.includes(side)) return false;

  if (f.min_priority && f.min_priority !== 'low') {
    const dataPriority = data.priority || (data.score >= 85 ? 'high' : data.score >= 75 ? 'medium' : 'low');
    if (PRIORITY_RANK[dataPriority] < PRIORITY_RANK[f.min_priority]) return false;
  }

  if (f.min_score && f.min_score > 0) {
    const score = data.score || data.context?.score || 0;
    if (score < f.min_score) return false;
  }

  return true;
}

// Returns whether the message was actually delivered (2xx from Telegram) —
// callers that need to know delivery succeeded (e.g. the per-asset healthcheck
// dedup marker, see checkAssetHealthchecks in run-scan.mjs) must not assume
// a resolved promise means the message went out; existing fire-and-forget
// callers in scanner.js are unaffected, they already ignore the return value.
async function send(html) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      console.warn('[Telegram] send failed:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[Telegram] send failed:', e.message);
    return false;
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

export async function notifyNewSignal(signal) {
  if (!(await shouldSend('signal_detected', signal))) return;
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

export async function notifyTradeCreated(op) {
  if (!(await shouldSend('entry_confirmed', op))) return;
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
  if (!(await shouldSend('tp1_hit', op))) return;
  return send(
    `🎯 <b>TP1 Atingido!</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n` +
    `💰 Preço atual: $${fmtP(price)}\n` +
    (closesFullyAtTp1(op)
      ? `✅ Posição encerrada 100% no TP1\n\n<i>⚡ CryptoRadar — operação fechada</i>`
      : `✅ ${op.partial_percent ?? 50}% da posição realizada\n`
        + `🔄 Stop movido para breakeven: $${fmtP(op.entry_price)}\n`
        + `🏃 Runner ${op.runner_percent ?? 50}% ativo — aguardando TP2: $${fmtP(op.tp2)}\n\n`
        + `<i>⚡ CryptoRadar — gerencie o runner</i>`)
  );
}

export async function notifyTP2Hit(op, price) {
  if (!(await shouldSend('tp2_hit', op))) return;
  return send(
    `🏆 <b>TP2 Atingido — Operação Completa!</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n` +
    `💰 Preço: $${fmtP(price)}\n` +
    `📍 Entrada: $${fmtP(op.entry_price)} → TP2: $${fmtP(op.tp2)}\n\n` +
    `<i>✅ Lucro completo realizado — CryptoRadar</i>`
  );
}

// System alert (per-asset healthcheck, scripts/run-scan.mjs) — bypasses
// shouldSend() filtering intentionally: this isn't a trading signal event
// subject to timeframe/priority/score filters, it's an operational "this
// asset stopped being scanned properly" warning that must always go through,
// the same way the healthchecks.io dead-man's-switch ping does for the whole
// scan pass.
export async function notifyAssetStale(asset, reason) {
  const label = asset.symbol?.replace('USDT', '/USDT') || asset.symbol;
  if (reason === 'persistent_error') {
    return send(
      `⚠️ <b>Ativo falhando continuamente</b>\n\n` +
      `<b>${label}</b>\n` +
      `🔁 Erro desde: ${asset.scan_error_since || '—'}\n` +
      `📝 ${asset.scan_error || '—'}\n\n` +
      `<i>⚡ CryptoRadar — verifique o ativo/Debug Log</i>`
    );
  }
  return send(
    `⚠️ <b>Ativo sem atualização</b>\n\n` +
    `<b>${label}</b>\n` +
    `🔇 Último scan: ${asset.last_scan_at || '—'}\n\n` +
    `<i>⚡ CryptoRadar — verifique se o ativo segue ativo no painel</i>`
  );
}

export async function notifyStopHit(op, price) {
  if (!(await shouldSend('stop_hit', op))) return;
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
  if (!(await shouldSend('invalidated', op))) return;
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
  if (!(await shouldSend('time_stop', op))) return;
  return send(
    `⏱️ <b>Time Stop — Operação Encerrada</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n` +
    `💰 Preço: $${fmtP(price)}\n` +
    `📍 Entrada: $${fmtP(op.entry_price)}\n\n` +
    `<i>⌛ Prazo máximo sem atingir TP1 — CryptoRadar</i>`
  );
}

export async function notifyChopExit(op, price) {
  if (!(await shouldSend('chop_exit', op))) return;
  return send(
    `🌊 <b>Chop Exit — Operação Encerrada</b>\n\n` +
    `<b>${op.symbol?.replace('USDT', '/USDT')}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n` +
    `💰 Preço: $${fmtP(price)}\n` +
    `📍 Entrada: $${fmtP(op.entry_price)}\n\n` +
    `<i>📉 Mercado lateralizado (choppiness alto) — CryptoRadar</i>`
  );
}
