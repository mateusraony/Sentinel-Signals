/**
 * Auditoria do Telegram, Fase 4 (2026-10-02) — corpo das mensagens de
 * notificação, extraído de `src/lib/telegram.js`/`scripts/adminTelegram.js`
 * pra um módulo único. Antes desta fase, os dois arquivos mantinham as
 * mesmas 10 funções `notify*` e ~7 helpers copiados à mão, byte a byte — a
 * fonte de duplicação real confirmada por um conselho de revisão (5 papéis
 * independentes) antes de tocar este código; ver
 * `/root/.claude/plans/auditoria-do-telegram-sentinel-snug-zephyr.md`,
 * seção Fase 4, e `docs/known-risks.md` item 250.
 *
 * Regra travada pelo papel de Segurança do conselho: este módulo é TEXTO
 * PURO. Nunca lê, recebe nem referencia credencial (`botToken`/`chatId`/
 * env vars) — cada canal (`telegram.js` no navegador, `adminTelegram.js`
 * no cron) continua decidindo por conta própria COMO ler a credencial e
 * ENVIAR. Isto aqui só decide O QUE escrever.
 *
 * `shouldSend()`/`send()`/filtros de configuração NÃO foram movidos pra
 * cá de propósito — o canal navegador (localStorage, filtro configurável
 * pelo usuário) e o canal cron (env vars, filtro estático +
 * `loadTelegramSources()` assíncrono e PREGUIÇOSO, só lido quando o evento
 * realmente precisa) têm semântica de fonte de dado genuinamente
 * diferente; forçar os dois na mesma função removeria a leitura
 * preguiçosa do cron e geraria uma leitura extra do Firestore por
 * notificação — regressão de cota, não limpeza.
 */
import { closesFullyAtTp1, getEntryReferenceTime } from './opExitRules.js';
import { formatBackfillLag } from './backfillDetection.js';
import { explainOperationDecision } from './decisionExplanation.js';
import { shortSourceLabel } from './signalSourceLabels.js';
import { NOTIFICATION_STAGES, stageHeader } from './notificationVocabulary.js';
import { classifyOutcome, calcRealizedR, calcRealizedPnlPct, getExitPrice } from './tradeMetrics.js';
import { rejectionCopy, SIGNAL_PHASE } from './signalStatus.js';

export function fmtP(p) {
  if (!p && p !== 0) return '—';
  if (p >= 10000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

// Real-event-time line, BRT (UTC-3, same convention already used in
// TradeHistory.jsx's candle display) — distinguishes the moment the
// market actually crossed the level from the moment this alert was
// generated (which can lag by up to a scan cadence, or much more after a
// cron gap/outage — docs/known-risks.md item 106).
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
export function realTimeLine(iso, isBound = false) {
  const formatted = fmtBRT(iso);
  if (!formatted) return '';
  return isBound ? `🕐 Vela (candle): ${formatted}\n` : `🕐 Horário real: ${formatted}\n`;
}

// Auditoria do Telegram (2026-09-29), item 1.3 — parse_mode:'HTML' trata
// `<`/`>`/`&` como marcação. Campos que vêm de fora do template (reason do
// sinal, texto de explicação da operação) precisam ser escapados antes de
// entrar na mensagem — nunca as tags de template (`<b>`, `<i>`), que são
// string literal do próprio código, nunca passam por aqui.
export function escaparHtml(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Auditoria do Telegram (2026-09-29), Fase 2 item 2.5 — link real pro
// painel, fechando a última seção da anatomia fixa de mensagem. URL
// pública do site estático (render.yaml `ALLOWED_ORIGIN`/serviço
// `sentinel-signals`) — não é secret, já está commitada no repo.
const PANEL_URL = 'https://sentinel-signals.onrender.com';

// Fase 5 da auditoria do Telegram (2026-10-02, item 5.4) — `id` opcional
// vira `?id=` na URL, deep link pro item exato em vez de só a lista
// genérica. As páginas-alvo (Alerts.jsx/Trades.jsx/Verification.jsx) leem
// esse parâmetro e abrem/realçam o item correspondente; sem `id`,
// comportamento idêntico ao de antes desta fase.
export function panelLink(path, id) {
  const query = id ? `?id=${encodeURIComponent(id)}` : '';
  return `<a href="${PANEL_URL}${path}${query}">Abrir no Sentinel</a>`;
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

// Auditoria do Telegram (2026-09-29), Fase 2 item 2.5/2.6 — "resultado final
// legível em encerramentos": entrada, saída, resultado já CALCULADO por
// tradeMetrics.js (nunca recomputado aqui — regra inegociável do plano),
// duração (reusa formatBackfillLag) e checklist do que foi atingido.
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

// Pedido do usuário (2026-09-01): quando um candle fecha tocando stop E TP no
// mesmo intervalo, o motor já decide sozinho e imediatamente ("stop vence",
// TradeOperation.exit_ambiguous — .claude/rules/trading-engine.md, seção
// "Ambiguidade stop/TP no mesmo candle") — a operação já está encerrada
// quando isso é detectado, então não existe "continuar ou sair" real pra
// perguntar. O que falta é só deixar isso visível em linguagem simples.
const AMBIGUOUS_EXIT_NOTE =
  `\nℹ️ <b>Nessa vela, o preço tocou o stop e o take ao mesmo tempo</b> — o gráfico não mostra qual foi primeiro de verdade. Por segurança, o sistema sempre considera que o stop aconteceu primeiro nesses casos raros. Essa operação já foi encerrada com esse resultado.\n`;

// Auditoria do Telegram (2026-09-29), Fase 2 item 2.3 — achado: TradeCard.jsx
// (STOP_HIT_BANNER) e TradeHistory.jsx (isBE) JÁ tratam breakeven como
// categoria visual própria, usando classifyOutcome (tradeMetrics.js).
// Reusa a MESMA função de classificação do resto do app.
const STOP_HIT_STAGE = {
  WIN: NOTIFICATION_STAGES.STOP_LOCKED_PROFIT,
  BE: NOTIFICATION_STAGES.STOP_BREAKEVEN,
};

export function buildSignalDetectedMessage(signal) {
  const dir = signal.signal_type === 'BUY' ? '📈 COMPRA' : '📉 VENDA';
  const strength = { strong: '💪 Forte', medium: '📊 Médio', moderate: '📊 Moderado', weak: '🔹 Fraco' }[signal.strength] || '';
  const sourceLabel = shortSourceLabel(signal.source);
  const scoreLine = Number.isFinite(signal.context?.score)
    ? `📊 Score: ${signal.context.score}/100 ${strength}\n`
    : (strength ? `📊 Força: ${strength}\n` : '');
  return (
    `${stageHeader('SIGNAL_DETECTED')} — ${sourceLabel}\n\n` +
    `<b>${escaparHtml(signal.symbol?.replace('USDT', '/USDT'))}</b> | ${signal.timeframe?.toUpperCase()} | ${dir}\n\n` +
    `${NOTIFICATION_STAGES.AWAITING_ENTRY.emoji} Situação: aguardando confirmação de entrada — nenhuma operação foi aberta ainda.\n\n` +
    `📝 Por quê: ${escaparHtml(signal.reason) || 'não informado'}\n\n` +
    `💰 Preço no sinal: $${fmtP(signal.price_at_signal)}\n` +
    scoreLine + '\n' +
    `➡️ Próximo passo: aguardar a confirmação de entrada pelo motor.\n` +
    `📡 Fonte: ${sourceLabel}\n\n` +
    `${panelLink('/alerts', signal.id)}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

// signal here is the SignalEvent that triggered the VerificationTask (same
// shape buildSignalDetectedMessage receives) — used both on automatic
// creation (scanner.js) and on manual resend from the Verification page.
// `signal.id` is the SignalEvent id, not the VerificationTask's own id —
// Verification.jsx matches it against `task.signal_event_id` (the field
// that already links the two), not `task.id`.
export function buildVerificationTaskMessage(signal) {
  const emoji = signal.signal_type === 'BUY' ? '🟢' : '🔴';
  const dir = signal.signal_type === 'BUY' ? '📈 COMPRA' : '📉 VENDA';
  const sourceLabel = shortSourceLabel(signal.source);
  const scoreLine = Number.isFinite(signal.context?.score)
    ? `📊 Score: ${signal.context.score}/100\n`
    : '';
  return (
    `${stageHeader('VERIFICATION_NEEDED')} — ${sourceLabel}\n\n` +
    `<b>${escaparHtml(signal.symbol?.replace('USDT', '/USDT'))}</b> | ${signal.timeframe?.toUpperCase()} | ${dir}\n\n` +
    `${emoji} Situação: sinal de alta prioridade aguardando sua revisão manual antes de virar operação.\n\n` +
    `⭐ Prioridade: ALTA\n` +
    scoreLine +
    `📝 Por quê: ${escaparHtml(signal.reason) || 'não informado'}\n\n` +
    `➡️ Próximo passo: revisar e marcar OK/Pular no painel.\n` +
    `📡 Fonte: ${sourceLabel}\n\n` +
    `${panelLink('/verification', signal.id)}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

// Fase 3 da auditoria do Telegram (2026-10-02, docs/known-risks.md item
// 117) — sinal que expirou sem NUNCA confirmar entrada (nenhuma
// TradeOperation foi criada). Categoria diferente de invalidated/time_stop/
// chop_exit, que fecham uma operação já ABERTA — aqui não existe operação,
// então não há linha de Resultado/R.
//
// "Por quê" reusa rejectionCopy() (src/lib/signalStatus.js, item 163) — a
// MESMA tradução de last_rejection_reason/last_rejection_detail que já
// aparece no Dashboard (Trades.jsx/SignalChecklist.jsx).
export function buildSignalCanceledMessage(signal) {
  const dir = signal.signal_type === 'BUY' ? '📈 COMPRA' : '📉 VENDA';
  const sourceLabel = shortSourceLabel(signal.source);
  const scoreLine = Number.isFinite(signal.context?.score)
    ? `📊 Score no sinal: ${signal.context.score}/100\n`
    : '';
  const { detail } = rejectionCopy(signal, SIGNAL_PHASE.EXPIRED);
  const createdMs = new Date(signal.created_date).getTime();
  const durationMs = Number.isFinite(createdMs) ? Date.now() - createdMs : null;
  const durationLine = Number.isFinite(durationMs) && durationMs >= 0
    ? `⏳ Esperou: ${formatBackfillLag(durationMs)}\n`
    : '';
  return (
    `${stageHeader('SIGNAL_CANCELED')} — ${sourceLabel}\n\n` +
    `<b>${escaparHtml(signal.symbol?.replace('USDT', '/USDT'))}</b> | ${signal.timeframe?.toUpperCase()} | ${dir}\n\n` +
    `🚫 Situação: este aviso expirou sem nunca confirmar entrada — nenhuma operação foi aberta.\n\n` +
    `📝 Por quê: ${escaparHtml(detail)}\n\n` +
    `💰 Preço no sinal: $${fmtP(signal.price_at_signal)}\n` +
    scoreLine +
    durationLine + '\n' +
    `➡️ Próximo passo: nenhum — este aviso não abriu operação.\n` +
    `📡 Fonte: ${sourceLabel}\n\n` +
    `${panelLink('/alerts', signal.id)}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

export function buildTradeCreatedMessage(op) {
  const emoji = op.side === 'BUY' ? '✅🟢' : '✅🔴';
  const dir = op.side === 'BUY' ? 'COMPRA' : 'VENDA';
  const tfLabel = op.timeframe === '15m' ? '15m (entrada 4h)' : op.timeframe?.toUpperCase();
  return (
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
    `${panelLink('/trades', op.id)}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

export function buildTp1HitMessage(op, price) {
  // op.decision_snapshot chega aqui em um de 3 reason_code possíveis
  // (tp1_hit_stop_to_breakeven/tp1_hit_stop_unchanged da Fase 3,
  // tp1_full_close da Fase 4 do motor) — explainOperationDecision resolve
  // o texto certo em qualquer um dos três, agnóstica de qual fase o criou.
  const { why, evidence } = explainOperationDecision(op);
  const fullClose = closesFullyAtTp1(op);
  return (
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
    `${panelLink('/trades', op.id)}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

export function buildTp2HitMessage(op, price) {
  const { why, evidence } = explainOperationDecision(op);
  return (
    `${stageHeader('TP2_HIT')}!\n\n` +
    `<b>${escaparHtml(op.symbol?.replace('USDT', '/USDT'))}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n\n` +
    `🏁 Situação: operação encerrada — alvo final atingido.\n\n` +
    `📝 Por quê: ${escaparHtml(why)}\n` +
    (evidence ? `📐 ${escaparHtml(evidence)}\n` : '') + '\n' +
    realTimeLine(op.tp2_hit_real_time, true) +
    `📍 Entrada: $${fmtP(op.entry_price)} → Saída: $${fmtP(getExitPrice(op) ?? price)}\n` +
    closureSummary(op) + '\n' +
    `➡️ Próximo passo: nenhum — operação encerrada.\n\n` +
    `${panelLink('/trades', op.id)}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

export function buildStopHitMessage(op, price) {
  const outcome = classifyOutcome(op);
  const stage = STOP_HIT_STAGE[outcome] ?? NOTIFICATION_STAGES.STOP_LOSS;
  const { why, evidence } = explainOperationDecision(op);
  return (
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
    `${panelLink('/trades', op.id)}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

export function buildInvalidatedMessage(op, price) {
  const stageMsg = op.tp1_hit ? '(após TP1 — parcial já realizada)' : '(pré-TP1)';
  const { why, evidence } = explainOperationDecision(op);
  return (
    `${stageHeader('INVALIDATED')} ${stageMsg}\n\n` +
    `<b>${escaparHtml(op.symbol?.replace('USDT', '/USDT'))}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n\n` +
    `⚠️ Situação: operação encerrada — a condição que sustentava a entrada deixou de ser válida.\n\n` +
    `📝 Por quê: ${escaparHtml(why)}\n` +
    (evidence ? `📐 ${escaparHtml(evidence)}\n` : '') + '\n' +
    realTimeLine(op.closed_at_real_time) +
    `📍 Entrada: $${fmtP(op.entry_price)} → Saída: $${fmtP(getExitPrice(op) ?? price)}\n` +
    closureSummary(op) + '\n' +
    `➡️ Próximo passo: nenhum — operação encerrada.\n\n` +
    `${panelLink('/trades', op.id)}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

export function buildTimeStopMessage(op, price) {
  const { why, evidence } = explainOperationDecision(op);
  return (
    `${stageHeader('TIME_STOP')}\n\n` +
    `<b>${escaparHtml(op.symbol?.replace('USDT', '/USDT'))}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n\n` +
    `⏱️ Situação: operação encerrada — prazo máximo sem atingir TP1 expirou.\n\n` +
    `📝 Por quê: ${escaparHtml(why)}\n` +
    (evidence ? `📐 ${escaparHtml(evidence)}\n` : '') + '\n' +
    realTimeLine(op.closed_at_real_time) +
    `📍 Entrada: $${fmtP(op.entry_price)} → Saída: $${fmtP(getExitPrice(op) ?? price)}\n` +
    closureSummary(op) + '\n' +
    `➡️ Próximo passo: nenhum — operação encerrada.\n\n` +
    `${panelLink('/trades', op.id)}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}

export function buildChopExitMessage(op, price) {
  const { why, evidence } = explainOperationDecision(op);
  return (
    `${stageHeader('CHOP_EXIT')}\n\n` +
    `<b>${escaparHtml(op.symbol?.replace('USDT', '/USDT'))}</b> | ${op.side} | ${op.timeframe?.toUpperCase()}\n\n` +
    `🌊 Situação: operação encerrada — mercado ficou lateralizado (choppiness alto).\n\n` +
    `📝 Por quê: ${escaparHtml(why)}\n` +
    (evidence ? `📐 ${escaparHtml(evidence)}\n` : '') + '\n' +
    realTimeLine(op.closed_at_real_time) +
    `📍 Entrada: $${fmtP(op.entry_price)} → Saída: $${fmtP(getExitPrice(op) ?? price)}\n` +
    closureSummary(op) + '\n' +
    `➡️ Próximo passo: nenhum — operação encerrada.\n\n` +
    `${panelLink('/trades', op.id)}\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
}
