// Node/GitHub Actions counterpart to src/lib/telegram.js — same notify*()
// functions scanner.js calls, but the bot token and chat id come from
// GitHub Actions secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) instead of
// browser localStorage. Filters match telegram.js's own defaults (no UI to
// customize them here — this is the "don't miss anything" 24/7 channel),
// EXCEPT signal source, which the user CAN configure from the browser
// Settings screen — see loadTelegramSources below.
//
// Auditoria do Telegram, Fase 4 (2026-10-02) — o corpo de cada mensagem
// (os `build*Message`) mora em src/lib/notificationTemplates.js,
// compartilhado com src/lib/telegram.js — antes eram 10 funções + ~7
// helpers copiados à mão entre os dois arquivos. Este arquivo continua
// decidindo SE envia (shouldSend, lido de env/Firestore) e COMO envia
// (send, credencial via env var). Ver docs/known-risks.md item 250.
import { formatBackfillLag } from '../src/lib/backfillDetection.js';
import {
  buildSignalDetectedMessage, buildVerificationTaskMessage, buildSignalCanceledMessage,
  buildTradeCreatedMessage, buildTp1HitMessage, buildTp2HitMessage, buildStopHitMessage,
  buildInvalidatedMessage, buildTimeStopMessage, buildChopExitMessage,
  escaparHtml,
} from '../src/lib/notificationTemplates.js';
// Re-exportado — scripts/adminTelegramStepTimeout.test.js importa escaparHtml
// direto deste módulo; mantém a API pública inalterada após a extração.
export { escaparHtml };
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { withTimeout } from './scanTimeout.mjs';
import { describeStep, formatStepDuration } from './failureClassification.mjs';
// Postgres/Neon (Fase 10 do plano de migração Firestore→Neon) — telegramFilters
// (loadTelegramSources abaixo) e o fallback de log (logTelegramFailure) agora
// lêem/escrevem pelo backend AO VIVO do motor de trading
// (scripts/adminEntities.js), não mais Firestore direto. Seguro importar
// direto (sem o cuidado "preguiçoso" que ainda vale pra RTDB logo abaixo): o
// re-export Postgres não chama nada no carregamento do módulo, só quando um
// método é de fato invocado.
import { backend } from './adminEntities.js';
// O marcador de dedup de cota (readAlertMarker/writeAlertMarker abaixo)
// prefere RTDB e só cai pro Firestore como fallback — RTDB fica FORA desta
// migração (só sai na decomissão, fase 11), então continua acessado direto,
// preguiçoso de propósito: importar scripts/adminEntitiesFirestoreLegacy.js
// aqui puxaria o initializeApp() dele para o carregamento deste módulo,
// acoplando um módulo de notificação ao bootstrap inteiro do admin Firestore
// — e quebrando qualquer consumidor sem credencial, testes inclusive.
// `ensureFirebaseAppInitialized()` (perto de markerRef, abaixo) faz esse
// mesmo initializeApp(), só que TARDIO — chamado só quando o marcador é
// realmente usado, não no carregamento do módulo. Ficou necessário na Fase
// 10: antes, `adminEntities.js` (versão Firestore) chamava initializeApp()
// como efeito colateral de ser importado (linha 27 acima); virando o
// re-export do Postgres, parou de chamar — e este marcador ficou órfão,
// lançando "The default Firebase app does not exist" em toda chamada
// (docs/known-risks.md item 175 addendum).
import { getDatabase } from 'firebase-admin/database';

const DEFAULT_FILTERS = {
  timeframes: ['1h', '4h', '1d'],
  min_priority: 'low',
  signal_types: ['BUY', 'SELL'],
  events: ['signal_detected', 'entry_confirmed', 'tp1_hit', 'tp2_hit', 'stop_hit', 'invalidated', 'time_stop', 'chop_exit', 'verification_task_created', 'signal_canceled'],
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
        const doc = await backend.entities.TelegramFilters.get('current');
        const sources = Array.isArray(doc?.sources) ? doc.sources : null;
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

// @param {Object} [asset] MonitoredAsset, only used for signal_detected —
// see notify_sources/notify_signal_types (docs/known-risks.md item 47).
async function shouldSend(event, data, asset) {
  const f = DEFAULT_FILTERS;
  if (f.events && !f.events.includes(event)) return false;

  // Signal-source filter — mesmo guard de evento de src/lib/telegram.js: só
  // signal_detected/signal_canceled usam este vocabulário de `source`
  // (RF/SMC/MACD/EMA/RSI) — os demais eventos carregam uma TradeOperation,
  // cujo `source` é um enum não relacionado (scanner/scanner_smc/
  // tradingview_webhook/manual). signal_canceled (Fase 3, 2026-10-02)
  // compartilha o mesmo payload SignalEvent de signal_detected.
  //
  // asset.notify_sources, quando definido, SUBSTITUI o filtro global (não
  // combina) — mesma convenção de rsi_overbought/oversold. Só lê o
  // Firestore (loadTelegramSources) quando não há override por-ativo.
  if ((event === 'signal_detected' || event === 'signal_canceled') && KNOWN_SOURCES.includes(data.source)) {
    const sources = asset?.notify_sources ?? await loadTelegramSources();
    if (!sources.includes(data.source)) return false;
  }

  // See src/lib/telegram.js for why signal_timeframe takes priority here.
  const tf = data.signal_timeframe || data.timeframe;
  if (f.timeframes && tf && !f.timeframes.includes(tf)) return false;

  const side = data.signal_type || data.side;
  const signalTypes = ((event === 'signal_detected' || event === 'signal_canceled') && asset?.notify_signal_types) || f.signal_types;
  if (signalTypes && side && !signalTypes.includes(side)) return false;

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

// Fire-and-forget SystemLog write (item 166 Fase 2) — só console.warn deixava
// uma falha de envio invisível pro resto do sistema: nem o Debug Log do
// painel nem scripts/health-audit.mjs (que só lê SystemLog) saberiam que o
// canal de 24h parou. Nunca aguardado por send() e sempre com .catch próprio
// — mesmo espírito do mirror RTDB (src/lib/rtdbMirror.js): uma escrita de
// log não pode atrasar nem quebrar o envio que ela está registrando, nem
// travar run-scan.mjs se o Firestore estiver indisponível (o forceExit do
// scanTimeout.mjs mata qualquer promise pendente de qualquer forma).
// Aguardada por send() (não fire-and-forget) — Codex review, PR #318:
// run-scan.mjs/run-backfill-check.mjs chamam forceExit() (process.exit())
// logo depois de aguardar o alerta que dispara esta função; sem aguardar a
// escrita, forceExit podia matar a promise pendente antes dela chegar ao
// Firestore, perdendo exatamente o registro que este fix existe pra
// garantir. withTimeout (já usado no resto deste arquivo) limita a espera —
// sem ele, um Firestore preso em retry de RESOURCE_EXHAUSTED (o mesmo
// cenário que costuma coincidir com um alerta de cota) reintroduziria a
// travada de minutos que scanTimeout.mjs existe pra evitar. try/catch em
// volta da chamada inteira, não só .catch() na promise — um throw SÍNCRONO
// (ex.: cliente Firestore mal configurado) não pode escapar e virar uma
// exceção não tratada dentro do try/catch de send(), que converteria "falha
// ao notificar" em "o scan inteiro quebrou". Mesmo raciocínio de
// safeMirrorCall (src/lib/rtdbMirror.js).
async function logTelegramFailure(message, details) {
  try {
    await withTimeout(
      backend.entities.SystemLog.create({
        level: 'warn', module: 'telegram', message, details,
        created_date: new Date().toISOString(),
      }),
      5000,
      'telegramFailureLog',
    );
  } catch (e) {
    console.warn('[Telegram] log de falha no SystemLog também falhou, ignorado:', e.message);
  }
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
      const body = await res.text();
      console.warn('[Telegram] send failed:', res.status, body);
      await logTelegramFailure('Falha ao enviar mensagem ao Telegram', { status: res.status, body });
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[Telegram] send failed:', e.message);
    await logTelegramFailure('Falha ao enviar mensagem ao Telegram (exceção)', { error: e.message });
    return false;
  }
}

export async function notifyNewSignal(signal, asset) {
  if (!(await shouldSend('signal_detected', signal, asset))) return;
  return send(buildSignalDetectedMessage(signal));
}

// Mirrors src/lib/telegram.js's notifyVerificationTask — signal is the
// SignalEvent that triggered the VerificationTask (same shape notifyNewSignal
// receives above).
export async function notifyVerificationTask(signal, asset) {
  if (!(await shouldSend('verification_task_created', signal, asset))) return false;
  return send(buildVerificationTaskMessage(signal));
}

// Mirrors src/lib/telegram.js's notifySignalCanceled — Fase 3 da auditoria
// do Telegram (2026-10-02, docs/known-risks.md item 117).
export async function notifySignalCanceled(signal, asset) {
  if (!(await shouldSend('signal_canceled', signal, asset))) return;
  return send(buildSignalCanceledMessage(signal));
}

export async function notifyTradeCreated(op) {
  if (!(await shouldSend('entry_confirmed', op))) return;
  return send(buildTradeCreatedMessage(op));
}

export async function notifyTP1Hit(op, price) {
  if (!(await shouldSend('tp1_hit', op))) return;
  return send(buildTp1HitMessage(op, price));
}

export async function notifyTP2Hit(op, price) {
  if (!(await shouldSend('tp2_hit', op))) return;
  return send(buildTp2HitMessage(op, price));
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
      `<i>⚡ Sentinel Signals — verifique o ativo/Debug Log</i>`
    );
  }
  return send(
    `⚠️ <b>Ativo sem atualização</b>\n\n` +
    `<b>${label}</b>\n` +
    `🔇 Último scan: ${asset.last_scan_at || '—'}\n\n` +
    `<i>⚡ Sentinel Signals — verifique se o ativo segue ativo no painel</i>`
  );
}

// System alert for genuine Firestore quota exhaustion (docs/known-risks.md
// item 138) — distinct from scanner.js's "projeted near limit" logWarn
// (SystemLog-only, never reaches Telegram). Bypasses shouldSend() like
// notifyAssetStale above: this isn't a trading signal, it's "the scan can't
// write to Firestore at all right now".
//
// The dedup marker below is ALSO a Firestore doc, which sounds circular —
// but it's deliberately fail-OPEN: reads/writes have separate daily quotas
// (item 106 — reads and writes have hit 80%+ independently of each other),
// so the marker read often still succeeds even while the write that
// triggered this alert failed, giving real cooldown. If the marker read
// itself fails too (both quotas exhausted, or transient network), this
// alerts on every pass instead of risking silence during the exact outage
// it exists to report — same fail-open spirit as loadTelegramSources above.
const QUOTA_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// docs/known-risks.md item 142 addendum — o get()/set() do dedup abaixo são
// chamadas Firestore reais no MESMO cliente admin que pode ficar preso em
// retry de RESOURCE_EXHAUSTED por minutos (item 142). Esta função só é
// chamada quando a cota JÁ deu match como esgotada (isFirestoreQuotaExhausted
// em run-scan.mjs) — ou seja, exatamente na janela de maior risco de travar.
// Sem timeout aqui, o alerta cujo propósito é avisar RÁPIDO vira o próprio
// travamento que scanTimeout.mjs foi criado para eliminar, e o forceExit()
// de run-scan.mjs nunca é alcançado. 15s é generoso pra um get/set de doc
// único (bem menor que os 90s do scan inteiro, que faz muito mais chamadas).
const QUOTA_DEDUP_TIMEOUT_MS = 15 * 1000;

// docs/known-risks.md item 158 — o marcador de dedup NÃO pode morar no
// Firestore. Ele existe para evitar spam do alerta de cota esgotada, mas o
// `get()` dele é uma leitura do Firestore: quando a cota estoura, ele falha,
// o `catch` mantinha `shouldAlert = true`, e o `set()` também falhava — então
// o marcador nunca era gravado. Resultado: um alerta a CADA passada do scan
// (~5min), exatamente na situação em que o dedup deveria funcionar. O
// cooldown de 1h existia e nunca era aplicado.
//
// O RTDB é o lugar certo: mesmo projeto Firebase, já configurado
// (FIREBASE_DATABASE_URL), e cobrado por banda/mês — sem teto diário de
// operações, então ele continua legível justamente durante a falta de cota
// do Firestore.
const ALERT_MARKER_COLLECTION = 'systemAlerts';
const QUOTA_MARKER_DOC = 'firestoreQuota';
// Marcador PRÓPRIO do alerta de etapa travada (item 162) — separado do de
// cota de propósito: são episódios diferentes, e misturar os dois faria uma
// etapa travada zerar o episódio de cota (e vice-versa), fazendo o aviso de
// "voltou ao normal" mentir.
const STEP_TIMEOUT_MARKER_DOC = 'stepTimeout';

/**
 * Item 175 addendum (2026-09-13) — desde a Fase 10 (`adminEntities.js` virou
 * o re-export do Postgres), NADA no processo do cron/backfill chama
 * `initializeApp()` do firebase-admin mais — antes, isso acontecia de graça
 * como efeito colateral de importar a versão Firestore de `adminEntities.js`
 * (que este módulo evita importar de propósito, ver o comentário acima de
 * `getDatabase` mais abaixo). O marcador de dedup abaixo
 * (`readAlertMarker`/`writeAlertMarker`) ficou órfão: toda chamada lançava
 * "The default Firebase app does not exist" — quebrando o cooldown de 1h dos
 * DOIS alertas que o usam (etapa travada e cota do Firestore esgotada),
 * confirmado em produção (LDOUSDT preso, `docs/known-risks.md` item 174).
 *
 * Preguiçoso e tolerante a falha, mesmo espírito do resto deste bloco: só
 * tenta inicializar quando o marcador é de fato usado, nunca no carregamento
 * do módulo (o comentário de `getDatabase` explica por que isso importa —
 * acoplaria qualquer consumidor sem credencial, testes inclusive, ao
 * bootstrap inteiro do Firebase Admin).
 */
function ensureFirebaseAppInitialized() {
  if (getApps().length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return;
  try {
    initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
      ...(process.env.FIREBASE_DATABASE_URL ? { databaseURL: process.env.FIREBASE_DATABASE_URL } : {}),
    });
  } catch {
    // Ignorado de propósito — os try/catch dos chamadores (markerRef,
    // readAlertMarker, writeAlertMarker) já tratam a ausência/falha do app
    // com o mesmo fallback que tratavam a ausência de RTDB antes disto.
  }
}

/**
 * Handle do marcador no RTDB, ou `null` se o RTDB não estiver configurado
 * neste ambiente — mesmo guard de scripts/adminEntities.js.
 */
function markerRef(doc) {
  if (!process.env.FIREBASE_DATABASE_URL) return null;
  ensureFirebaseAppInitialized();
  try {
    return getDatabase().ref(`${ALERT_MARKER_COLLECTION}/${doc}`);
  } catch {
    return null;
  }
}

/**
 * Lê o marcador inteiro. `{}` = nunca alertou OU não deu para ler.
 *
 * Formato (docs/known-risks.md item 160):
 *   last_alert_at     — controle do cooldown de 1h
 *   alert_active      — há um episódio de queda ABERTO
 *   alert_started_at  — quando esse episódio começou (para medir a duração)
 */
async function readAlertMarker(doc) {
  const rtdbRef = markerRef(doc);
  if (rtdbRef) {
    const snap = await withTimeout(rtdbRef.get(), QUOTA_DEDUP_TIMEOUT_MS, `readAlertMarker(${doc}): rtdb.get()`);
    return snap.exists() ? (snap.val() ?? {}) : {};
  }
  // Sem RTDB configurado: cai no Firestore, o comportamento anterior.
  ensureFirebaseAppInitialized();
  const ref = getFirestore().collection(ALERT_MARKER_COLLECTION).doc(doc);
  const snap = await withTimeout(ref.get(), QUOTA_DEDUP_TIMEOUT_MS, `readAlertMarker(${doc}): firestore.get()`);
  return snap.exists ? (snap.data() ?? {}) : {};
}

async function writeAlertMarker(doc, marker) {
  const rtdbRef = markerRef(doc);
  if (rtdbRef) {
    return withTimeout(rtdbRef.set(marker), QUOTA_DEDUP_TIMEOUT_MS, `writeAlertMarker(${doc}): rtdb.set()`);
  }
  ensureFirebaseAppInitialized();
  const ref = getFirestore().collection(ALERT_MARKER_COLLECTION).doc(doc);
  return withTimeout(ref.set(marker), QUOTA_DEDUP_TIMEOUT_MS, `writeAlertMarker(${doc}): firestore.set()`);
}

const readQuotaMarker = () => readAlertMarker(QUOTA_MARKER_DOC);
const writeQuotaMarker = (marker) => writeAlertMarker(QUOTA_MARKER_DOC, marker);

/**
 * Decisão pura de alertar, separada do I/O para ser testável.
 *
 * `lastAt` ausente cobre dois casos diferentes de propósito: nunca alertou
 * (deve alertar) e não deu para ler o marcador (alerta mesmo assim — perder
 * o primeiro aviso de uma queda real é pior que um alerta a mais). O que
 * conserta o spam não é fechar essa porta, é o marcador passar a ser legível
 * durante a queda.
 */
export function shouldAlertQuota(lastAt, now = Date.now(), cooldownMs = QUOTA_ALERT_COOLDOWN_MS) {
  if (!lastAt) return true;
  const parsed = new Date(lastAt).getTime();
  if (!Number.isFinite(parsed)) return true;
  return now - parsed > cooldownMs;
}

export async function notifyFirestoreQuotaExhausted(errMessage) {
  let marker = {};
  try {
    marker = await readQuotaMarker();
  } catch (e) {
    console.warn('[adminTelegram] Falha ao checar dedup de cota, alertando mesmo assim:', e.message);
  }
  if (!shouldAlertQuota(marker.last_alert_at)) return false;

  const delivered = await send(
    `🚨 <b>Cota do Firestore esgotada</b>\n\n` +
    `O scan ao vivo está falhando com <code>RESOURCE_EXHAUSTED</code> — nenhuma ` +
    `operação nova pode ser aberta/atualizada enquanto isso durar.\n\n` +
    `📝 ${errMessage || 'Quota exceeded.'}\n\n` +
    `<i>⚡ Sentinel Signals — aviso o momento em que voltar ao normal. Cota reseta ~meia-noite Pacific (~07:00 UTC)</i>`
  );
  if (delivered) {
    const nowIso = new Date().toISOString();
    try {
      await writeQuotaMarker({
        last_alert_at: nowIso,
        alert_active: true,
        // Só reabre a contagem se não havia episódio em curso — assim a
        // duração informada na recuperação é a da queda inteira, não a do
        // último alerta.
        alert_started_at: marker.alert_active && marker.alert_started_at ? marker.alert_started_at : nowIso,
      });
    } catch (e) {
      console.warn('[adminTelegram] Falha ao gravar dedup de cota (não crítico):', e.message);
    }
  }
  return delivered;
}

/**
 * Avisa que a cota normalizou — o "tudo certo" que faltava (item 160).
 *
 * Sem isto, o usuário ficava olhando um alarme antigo sem nenhuma forma de
 * saber que ele já não valia: a mensagem dizia "está falhando" e nada nunca
 * dizia que voltou. Foi exatamente o que aconteceu em 2026-09-05.
 *
 * Chamada em TODA passada bem-sucedida do scan, mas só envia quando havia um
 * episódio aberto — no caso normal é uma leitura minúscula no RTDB e nada
 * mais. Nunca lança: a recuperação nunca pode derrubar um scan que deu certo.
 */
export async function notifyFirestoreQuotaRecovered() {
  let marker;
  try {
    marker = await readQuotaMarker();
  } catch (e) {
    // Marcador ilegível: não dá para saber se havia episódio aberto. Ficar
    // calado é o certo aqui — o oposto do caso do alerta, onde o silêncio
    // esconderia uma queda real.
    console.warn('[adminTelegram] Falha ao checar recuperação de cota (não crítico):', e.message);
    return false;
  }
  if (!marker.alert_active) return false;

  const startedAt = marker.alert_started_at ? new Date(marker.alert_started_at).getTime() : null;
  const duracao = Number.isFinite(startedAt) ? formatBackfillLag(Date.now() - startedAt) : null;

  const delivered = await send(
    `✅ <b>Cota do Firestore normalizada</b>\n\n` +
    `O scan voltou a rodar${duracao ? ` — ficou ${duracao} sem conseguir` : ''}. ` +
    `Operações voltam a ser abertas e atualizadas normalmente.\n\n` +
    `<i>⚡ Sentinel Signals</i>`
  );
  if (delivered) {
    try {
      await writeQuotaMarker({ ...marker, alert_active: false });
    } catch (e) {
      console.warn('[adminTelegram] Falha ao limpar marcador de cota (não crítico):', e.message);
    }
  }
  return delivered;
}

/**
 * Uma ETAPA travou — alerta próprio, item 162.
 *
 * Antes deste alerta existir, todo travamento era anunciado como "Cota do
 * Firestore esgotada", porque a mensagem de timeout carregava a palavra
 * `RESOURCE_EXHAUSTED` como hipótese e o detector casava com ela. O usuário
 * recebia um diagnóstico ERRADO — em 2026-09-05 recebeu alerta de cota
 * esgotada enquanto o scan ao vivo rodava verde a cada 5 minutos.
 *
 * Este alerta diz só o que foi observado: QUE etapa não respondeu e em quanto
 * tempo. Sem chutar a causa.
 *
 * Dedup próprio (`systemAlerts/stepTimeout`), nunca o de cota: são episódios
 * diferentes, e o aviso de "cota normalizada" não pode ser disparado nem
 * silenciado por um travamento que não tem nada a ver com cota.
 */
export async function notifyStepTimeout(step, ms) {
  let marker = {};
  try {
    marker = await readAlertMarker(STEP_TIMEOUT_MARKER_DOC);
  } catch (e) {
    console.warn('[adminTelegram] Falha ao checar dedup de etapa travada, alertando mesmo assim:', e.message);
  }
  // Etapa DIFERENTE da última avisada é informação nova — não fica presa no
  // cooldown de uma etapa que já não é a que está travando.
  if (marker.step === step && !shouldAlertQuota(marker.last_alert_at)) return false;

  const duracao = formatStepDuration(ms);
  const delivered = await send(
    `⏱️ <b>Uma etapa travou</b>\n\n`
    + `O sistema parou de esperar por ${describeStep(step)}`
    + `${duracao ? ` — não respondeu em ${duracao}` : ''}. `
    + `Ele tenta de novo sozinho no próximo ciclo.\n\n`
    + `<i>⚡ Sentinel Signals — quando a causa for falta de cota, o aviso é outro e diz isso.</i>`
  );
  if (delivered) {
    try {
      await writeAlertMarker(STEP_TIMEOUT_MARKER_DOC, { last_alert_at: new Date().toISOString(), step });
    } catch (e) {
      console.warn('[adminTelegram] Falha ao gravar dedup de etapa travada (não crítico):', e.message);
    }
  }
  return delivered;
}

/**
 * Resultado da auditoria de saúde (item 165) — só quando há o que dizer.
 *
 * Sem dedup nem cooldown de propósito: a auditoria roda 1×/dia e já decide
 * sozinha se cala. Um segundo mecanismo de silêncio em cima disso é como se
 * perde um aviso real — foi o que aconteceu no item 158, onde o dedup vivia
 * no lugar que caía junto com o problema.
 *
 * Nunca lança: a auditoria não pode falhar por causa do aviso sobre ela.
 */
export async function notifyHealthAudit(titulo, linhas, url) {
  const corpo = linhas.map((l) => `• ${escaparHtml(l)}`).join('\n');
  return send(
    `🩺 <b>${escaparHtml(titulo)}</b>\n\n${corpo}\n\n`
    + (url ? `<a href="${escaparHtml(url)}">Ver o relatório completo</a>\n\n` : '')
    + `<i>⚡ Sentinel Signals — auditoria diária. Silêncio aqui significa que ela rodou e não achou nada.</i>`
  ).catch((e) => {
    console.warn('[adminTelegram] Falha ao notificar auditoria (não crítico):', e.message);
    return false;
  });
}

export async function notifyStopHit(op, price) {
  if (!(await shouldSend('stop_hit', op))) return;
  return send(buildStopHitMessage(op, price));
}

export async function notifyInvalidated(op, price) {
  if (!(await shouldSend('invalidated', op))) return;
  return send(buildInvalidatedMessage(op, price));
}

export async function notifyTimeStop(op, price) {
  if (!(await shouldSend('time_stop', op))) return;
  return send(buildTimeStopMessage(op, price));
}

export async function notifyChopExit(op, price) {
  if (!(await shouldSend('chop_exit', op))) return;
  return send(buildChopExitMessage(op, price));
}
