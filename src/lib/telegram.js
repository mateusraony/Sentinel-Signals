/**
 * Telegram Notification Service
 * Config + filters stored in localStorage. Uses Telegram Bot API directly from browser.
 * Filters (timeframes, min_priority, signal_types, events, min_score) are checked
 * before sending — ensuring only configured signals reach Telegram.
 */
import { logWarn } from './logger';
import { closesFullyAtTp1, getEntryReferenceTime } from './opExitRules';
import { formatBackfillLag } from './backfillDetection';
import { explainOperationDecision } from './decisionExplanation';
import { shortSourceLabel } from './signalSourceLabels';
import { NOTIFICATION_STAGES, stageHeader } from './notificationVocabulary';
import { classifyOutcome, calcRealizedR, calcRealizedPnlPct, getExitPrice } from './tradeMetrics';

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

function fmtP(p) {
  if (!p && p !== 0) return '—';
  if (p >= 10000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

// Real-event-time line, BRT (UTC-3, same convention already used in
// TradeHistory.jsx's candle display) — distinguishes the moment the
// market actually crossed the level from the moment this alert was
// generated (which can lag by up to a scan cadence, or much more after a
// cron gap/outage — docs/known-risks.md item 106). No moment import here
// on purpose: telegram.js/adminTelegram.js are lean, dependency-free
// mirrors, matching their existing style.
function fmtBRT(iso) {
  if (!iso) return null;
  const d = new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} BRT`;
}

// realTime line for a notify* message — only rendered when we actually have
// a real-market-time value (candle-based exits, or entries via
// getEntryReferenceTime); silently omitted for tick-based price-check exits,
// where the wall-clock *_at IS already the real time at that loop's
// resolution.
//
// Codex review (PR #213): stop_hit_real_time/tp1_hit_real_time/
// tp2_hit_real_time are the CLOSE of the candle whose high/low confirmed
// the exit — an UPPER BOUND on the real cross, not the exact intrabar
// instant (no tick data within the candle). Pass isBound=true for those so
// the label says "vela" instead of implying tick-level precision.
// closed_at_real_time varies by reason (see TradeOperation.jsonc) — callers
// below pass isBound only where it applies.
function realTimeLine(iso, isBound = false) {
  const formatted = fmtBRT(iso);
  if (!formatted) return '';
  return isBound ? `🕐 Vela (candle): ${formatted}\n` : `🕐 Horário real: ${formatted}\n`;
}

// Auditoria do Telegram (2026-09-29), item 1.3 — parse_mode:'HTML' (ver
// `send()` abaixo) trata `<`/`>`/`&` como marcação. Campos que vêm de fora do
// template (reason do sinal, texto de explicação da operação) nunca eram
// escapados aqui, ao contrário do canal cron (`scripts/adminTelegram.js`, que
// já tinha `escaparHtml()` mas só a aplicava nas mensagens de auditoria de
// saúde). Mesma implementação nos dois arquivos, de propósito — são
// espelhados manualmente. Escapa só os três caracteres que o Telegram trata
// como marcação; as tags de template (`<b>`, `<i>`) continuam cruas porque
// são string literal do próprio código, nunca passam por aqui.
function escaparHtml(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Auditoria do Telegram (2026-09-29), Fase 2 item 2.5 — link real pro
// painel, fechando a última seção da anatomia fixa de mensagem (item 14 da
// proposta original: "O que → Onde → Situação → Por quê → Números →
// Próximo passo → Quando/Fonte → Link"). URL pública do site estático
// (render.yaml `ALLOWED_ORIGIN`/serviço `sentinel-signals`) — não é secret,
// já está commitada no repo. Só a página geral (ex. `/trades`), não um
// deep link pra uma operação específica — isso é a Fase 5 do plano
// ("Deep link exato pro contexto"), não implementada aqui.
const PANEL_URL = 'https://sentinel-signals.onrender.com';

function panelLink(path) {
  return `<a href="${PANEL_URL}${path}">Abrir no Sentinel</a>`;
}

export async function notifyNewSignal(signal, asset) {
  if (!shouldSend('signal_detected', signal, asset)) return;
  const emoji = signal.signal_type === 'BUY' ? '🟢' : '🔴';
  const dir = signal.signal_type === 'BUY' ? '📈 COMPRA' : '📉 VENDA';
  const strength = { strong: '💪 Forte', medium: '📊 Médio', moderate: '📊 Moderado', weak: '🔹 Fraco' }[signal.strength] || '';
  const sourceLabel = shortSourceLabel(signal.source);
  const scoreLine = Number.isFinite(signal.context?.score)
    ? `📊 Score: ${signal.context.score}/100 ${strength}\n`
    : (strength ? `📊 Força: ${strength}\n` : '');
  return send(
    `${stageHeader('SIGNAL_DETECTED')} — ${sourceLabel}\n\n` +
    `<b>${escaparHtml(signal.symbol?.replace('USDT', '/USDT'))}</b> | ${signal.timeframe?.toUpperCase()} | ${dir}\n\n` +
    `${NOTIFICATION_STAGES.AWAITING_ENTRY.emoji} Situação: aguardando confirmação de entrada — nenhuma operação foi aberta ainda.\n\n` +
    `📝 Por quê: ${escaparHtml(signal.reason) || 'não informado'}\n\n` +
    `💰 Preço no sinal: $${fmtP(signal.price_at_signal)}\n` +
    scoreLine + '\n' +
    `➡️ Próximo passo: aguardar a confirmação de entrada pelo motor.\n` +
    `📡 Fonte: ${sourceLabel}\n\n` +
    `${panelLink('/alerts')}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

// signal here is the SignalEvent that triggered the VerificationTask (same
// shape notifyNewSignal receives) — used both on automatic creation
// (scanner.js) and on manual resend from the dedicated Verification page.
export async function notifyVerificationTask(signal, asset) {
  if (!shouldSend('verification_task_created', signal, asset)) return false;
  const emoji = signal.signal_type === 'BUY' ? '🟢' : '🔴';
  const dir = signal.signal_type === 'BUY' ? '📈 COMPRA' : '📉 VENDA';
  const sourceLabel = shortSourceLabel(signal.source);
  const scoreLine = Number.isFinite(signal.context?.score)
    ? `📊 Score: ${signal.context.score}/100\n`
    : '';
  return send(
    `${stageHeader('VERIFICATION_NEEDED')} — ${sourceLabel}\n\n` +
    `<b>${escaparHtml(signal.symbol?.replace('USDT', '/USDT'))}</b> | ${signal.timeframe?.toUpperCase()} | ${dir}\n\n` +
    `${emoji} Situação: sinal de alta prioridade aguardando sua revisão manual antes de virar operação.\n\n` +
    `⭐ Prioridade: ALTA\n` +
    scoreLine +
    `📝 Por quê: ${escaparHtml(signal.reason) || 'não informado'}\n\n` +
    `➡️ Próximo passo: revisar e marcar OK/Pular no painel.\n` +
    `📡 Fonte: ${sourceLabel}\n\n` +
    `${panelLink('/verification')}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

// docs/known-risks.md item 137 — pedido explícito do usuário: uma operação
// criada pela checagem retroativa (scripts/run-backfill-check.mjs, tag
// source:'backfill') precisa deixar isso claro NA notificação também, não só
// no painel — senão a mensagem lê como se o Sentinel tivesse acabado de
// pegar a entrada ao vivo, quando na verdade ela já aconteceu no passado.
function backfillPrefix(op) {
  if (op.source !== 'backfill') return '';
  const lag = formatBackfillLag(op.backfill_entry_lag_ms);
  return `⏱ <b>Detectada retroativamente</b> — entrada real foi há ${lag ?? 'algum tempo'}, o Sentinel só a encontrou agora ao adicionar/atualizar o ativo (não foi pega ao vivo).\n\n`;
}

export async function notifyTradeCreated(op) {
  if (!shouldSend('entry_confirmed', op)) return;
  const emoji = op.side === 'BUY' ? '✅🟢' : '✅🔴';
  const dir = op.side === 'BUY' ? 'COMPRA' : 'VENDA';
  const tfLabel = op.timeframe === '15m' ? '15m (entrada 4h)' : op.timeframe?.toUpperCase();
  return send(
    backfillPrefix(op) +
    `${stageHeader('ENTRY_CONFIRMED')} — ${dir}\n\n` +
    `<b>${escaparHtml(op.symbol?.replace('USDT', '/USDT'))}</b> | ${tfLabel}\n\n` +
    `${emoji} Situação: operação aberta, gerenciada automaticamente pelo Sentinel.\n\n` +
    realTimeLine(getEntryReferenceTime(op)) +
    `📍 Entrada: $${fmtP(op.entry_price)}\n` +
    `🛑 Stop: $${fmtP(op.initial_stop)}\n` +
    `🎯 TP1: $${fmtP(op.tp1)}  |  TP2: $${fmtP(op.tp2)}\n` +
    `📊 Score: ${op.score}/100\n\n` +
    `➡️ Próximo passo: aguardar o preço avançar para o TP1.\n` +
    `🔒 Gestão: ${op.partial_percent ?? 50}% no TP1, runner ${op.runner_percent ?? 50}%\n\n` +
    `${panelLink('/trades')}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

// Auditoria do Telegram (2026-09-29), Fase 2 item 2.5/2.6 — "resultado final
// legível em encerramentos": entrada, saída, resultado já CALCULADO por
// tradeMetrics.js (nunca recomputado aqui — regra inegociável do plano),
// duração (reusa formatBackfillLag, que já formata ms→"3d 14h", pro mesmo
// propósito de "quanto tempo passou" que ele já resolve pro backfill) e
// checklist do que foi atingido.
function closureSummary(op) {
  const r = calcRealizedR(op);
  const pct = calcRealizedPnlPct(op);
  const resultLine = r !== null
    ? `📐 Resultado: ${r >= 0 ? '+' : ''}${r.toFixed(2)}R` + (pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)` : '') + '\n'
    : '';
  const entryRef = getEntryReferenceTime(op);
  const closedAt = op.closed_at_real_time || op.stop_hit_real_time || op.tp2_hit_real_time || op.closed_at;
  const durationMs = entryRef && closedAt ? new Date(closedAt).getTime() - new Date(entryRef).getTime() : null;
  const durationLine = Number.isFinite(durationMs) && durationMs >= 0 ? `⏳ Duração: ${formatBackfillLag(durationMs)}\n` : '';
  const checklist = [op.tp1_hit ? '✅ TP1' : null, op.status === 'TP2_HIT' ? '✅ TP2' : null].filter(Boolean).join('  ');
  return resultLine + durationLine + (checklist ? `${checklist}\n` : '');
}

export async function notifyTP1Hit(op, price) {
  if (!shouldSend('tp1_hit', op)) return;
  // op.decision_snapshot chega aqui em um de 3 reason_code possíveis
  // (tp1_hit_stop_to_breakeven/tp1_hit_stop_unchanged da Fase 3,
  // tp1_full_close da Fase 4) — explainOperationDecision resolve o texto
  // certo em qualquer um dos três, agnóstica de qual fase o criou.
  const { why, evidence } = explainOperationDecision(op);
  const fullClose = closesFullyAtTp1(op);
  return send(
    `${stageHeader('TP1_HIT')}!\n\n` +
    `<b>${escaparHtml(op.symbol?.replace('USDT', '/USDT'))}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n\n` +
    // Sem runner (known-risks item 46) o TP1 é saída TERMINAL — anunciar
    // "runner ativo, aguardando TP2" seria mentira no canal.
    (fullClose
      ? `${NOTIFICATION_STAGES.TP1_HIT.emoji} Situação: posição encerrada 100% no TP1.\n\n`
      : `${NOTIFICATION_STAGES.RUNNER_ACTIVE.emoji} Situação: ${op.partial_percent ?? 50}% da posição realizada, runner ${op.runner_percent ?? 50}% segue aberto.\n\n`) +
    `📝 Por quê: ${escaparHtml(why)}\n` +
    (evidence ? `📐 ${escaparHtml(evidence)}\n` : '') + '\n' +
    realTimeLine(op.tp1_hit_real_time, true) +
    `💰 Preço atual: $${fmtP(price)}\n` +
    (fullClose ? closureSummary(op) : `🔄 Stop movido para breakeven: $${fmtP(op.entry_price)}\n`) + '\n' +
    `➡️ Próximo passo: ${fullClose ? 'nenhum — operação encerrada.' : `aguardar o preço avançar para o TP2: $${fmtP(op.tp2)}.`}\n\n` +
    `${panelLink('/trades')}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

export async function notifyTP2Hit(op, price) {
  if (!shouldSend('tp2_hit', op)) return;
  const { why, evidence } = explainOperationDecision(op);
  return send(
    `${stageHeader('TP2_HIT')}!\n\n` +
    `<b>${escaparHtml(op.symbol?.replace('USDT', '/USDT'))}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n\n` +
    `🏁 Situação: operação encerrada — alvo final atingido.\n\n` +
    `📝 Por quê: ${escaparHtml(why)}\n` +
    (evidence ? `📐 ${escaparHtml(evidence)}\n` : '') + '\n' +
    realTimeLine(op.tp2_hit_real_time, true) +
    `📍 Entrada: $${fmtP(op.entry_price)} → Saída: $${fmtP(getExitPrice(op) ?? price)}\n` +
    closureSummary(op) + '\n' +
    `➡️ Próximo passo: nenhum — operação encerrada.\n\n` +
    `${panelLink('/trades')}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

// Pedido do usuário (2026-09-01): quando um candle fecha tocando stop E TP no
// mesmo intervalo, o motor já decide sozinho e imediatamente ("stop vence",
// TradeOperation.exit_ambiguous — .claude/rules/trading-engine.md, seção
// "Ambiguidade stop/TP no mesmo candle") — a operação já está encerrada
// quando isso é detectado, então não existe "continuar ou sair" real pra
// perguntar (ver docs/known-risks.md, conselho de revisão 2026-08-31). O que
// falta é só deixar isso visível em linguagem simples, sem jargão — este
// texto é acrescentado à notificação de stop já existente (mesmo texto do
// espelho scripts/adminTelegram.js), nunca muda a decisão nem atrasa o envio.
const AMBIGUOUS_EXIT_NOTE =
  `\nℹ️ <b>Nessa vela, o preço tocou o stop e o take ao mesmo tempo</b> — o gráfico não mostra qual foi primeiro de verdade. Por segurança, o sistema sempre considera que o stop aconteceu primeiro nesses casos raros. Essa operação já foi encerrada com esse resultado.\n`;

// Auditoria do Telegram (2026-09-29), Fase 2 item 2.3 — achado: TradeCard.jsx
// (STOP_HIT_BANNER) e TradeHistory.jsx (isBE) JÁ tratam breakeven como
// categoria visual própria, usando classifyOutcome (tradeMetrics.js) — o
// Telegram era o único canal ainda anunciando os 3 casos (perda/breakeven/
// lucro travado no stop) sob o MESMO cabeçalho "🛑 Stop Atingido". Reusa a
// MESMA função de classificação do resto do app, em vez de inventar um
// critério novo (o `op.tp1_hit` isolado que havia antes não distinguia
// lucro travado de perda real pós-TP1).
const STOP_HIT_STAGE = {
  WIN: NOTIFICATION_STAGES.STOP_LOCKED_PROFIT,
  BE: NOTIFICATION_STAGES.STOP_BREAKEVEN,
};

export async function notifyStopHit(op, price) {
  if (!shouldSend('stop_hit', op)) return;
  const outcome = classifyOutcome(op);
  const stage = STOP_HIT_STAGE[outcome] ?? NOTIFICATION_STAGES.STOP_LOSS;
  const { why, evidence } = explainOperationDecision(op);
  return send(
    `${stage.emoji} <b>${stage.label}</b>\n\n` +
    `<b>${escaparHtml(op.symbol?.replace('USDT', '/USDT'))}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n\n` +
    `${stage.emoji} Situação: operação encerrada pelo stop` + (outcome === 'BE' ? ', sem prejuízo.' : outcome === 'WIN' ? ', com lucro já travado.' : '.') + '\n\n' +
    `📝 Por quê: ${escaparHtml(why)}\n` +
    (evidence ? `📐 ${escaparHtml(evidence)}\n` : '') + '\n' +
    realTimeLine(op.stop_hit_real_time, true) +
    `📍 Entrada: $${fmtP(op.entry_price)} → Saída: $${fmtP(getExitPrice(op) ?? price)} (stop em $${fmtP(op.current_stop)})\n` +
    closureSummary(op) +
    (op.exit_ambiguous ? AMBIGUOUS_EXIT_NOTE : '') + '\n' +
    `➡️ Próximo passo: nenhum — operação encerrada.\n\n` +
    `${panelLink('/trades')}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

export async function notifyInvalidated(op, price) {
  if (!shouldSend('invalidated', op)) return;
  const stageMsg = op.tp1_hit ? '(após TP1 — parcial já realizada)' : '(pré-TP1)';
  const { why, evidence } = explainOperationDecision(op);
  return send(
    `${stageHeader('INVALIDATED')} ${stageMsg}\n\n` +
    `<b>${escaparHtml(op.symbol?.replace('USDT', '/USDT'))}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n\n` +
    `⚠️ Situação: operação encerrada — a condição que sustentava a entrada deixou de ser válida.\n\n` +
    `📝 Por quê: ${escaparHtml(why)}\n` +
    (evidence ? `📐 ${escaparHtml(evidence)}\n` : '') + '\n' +
    realTimeLine(op.closed_at_real_time) +
    `📍 Entrada: $${fmtP(op.entry_price)} → Saída: $${fmtP(getExitPrice(op) ?? price)}\n` +
    closureSummary(op) + '\n' +
    `➡️ Próximo passo: nenhum — operação encerrada.\n\n` +
    `${panelLink('/trades')}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

export async function notifyTimeStop(op, price) {
  if (!shouldSend('time_stop', op)) return;
  const { why, evidence } = explainOperationDecision(op);
  return send(
    `${stageHeader('TIME_STOP')}\n\n` +
    `<b>${escaparHtml(op.symbol?.replace('USDT', '/USDT'))}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n\n` +
    `⏱️ Situação: operação encerrada — prazo máximo sem atingir TP1 expirou.\n\n` +
    `📝 Por quê: ${escaparHtml(why)}\n` +
    (evidence ? `📐 ${escaparHtml(evidence)}\n` : '') + '\n' +
    realTimeLine(op.closed_at_real_time) +
    `📍 Entrada: $${fmtP(op.entry_price)} → Saída: $${fmtP(getExitPrice(op) ?? price)}\n` +
    closureSummary(op) + '\n' +
    `➡️ Próximo passo: nenhum — operação encerrada.\n\n` +
    `${panelLink('/trades')}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

export async function notifyChopExit(op, price) {
  if (!shouldSend('chop_exit', op)) return;
  const { why, evidence } = explainOperationDecision(op);
  return send(
    `${stageHeader('CHOP_EXIT')}\n\n` +
    `<b>${escaparHtml(op.symbol?.replace('USDT', '/USDT'))}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n\n` +
    `🌊 Situação: operação encerrada — mercado ficou lateralizado (choppiness alto).\n\n` +
    `📝 Por quê: ${escaparHtml(why)}\n` +
    (evidence ? `📐 ${escaparHtml(evidence)}\n` : '') + '\n' +
    realTimeLine(op.closed_at_real_time) +
    `📍 Entrada: $${fmtP(op.entry_price)} → Saída: $${fmtP(getExitPrice(op) ?? price)}\n` +
    closureSummary(op) + '\n' +
    `➡️ Próximo passo: nenhum — operação encerrada.\n\n` +
    `${panelLink('/trades')}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}