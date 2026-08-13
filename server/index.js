const express = require('express');
const cors = require('cors');
const AdmZip = require('adm-zip');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

// Fail fast with a clear message instead of an opaque JSON.parse crash if
// this ever gets deployed without its secrets configured.
const REQUIRED_ENV = ['FIREBASE_SERVICE_ACCOUNT_JSON', 'TELEGRAM_BOT_TOKEN'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`Missing required env var(s): ${missingEnv.join(', ')}`);
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGIN) {
  console.warn('ALLOWED_ORIGIN is not set in production — CORS will allow any origin ("*").');
}
if (!process.env.WEBHOOK_SECRET) {
  console.warn('WEBHOOK_SECRET is not set — POST /webhook/tradingview will reject every request with 401.');
}
if (!process.env.GITHUB_ACTIONS_TOKEN) {
  console.warn('GITHUB_ACTIONS_TOKEN is not set — /api/backtest/* routes will reject every request with 503.');
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
initializeApp({ credential: cert(serviceAccount) });

const auth = getAuth();
const db = getFirestore();

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'sentinel-signals-api' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'Missing Authorization bearer token.' });
  }
  try {
    req.uid = (await auth.verifyIdToken(idToken)).uid;
    next();
  } catch (e) {
    console.error('verifyIdToken failed:', e.message);
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// Per-uid cooldown — same courtesy-brake pattern as the backtest trigger's
// lastTriggerAt/TRIGGER_COOLDOWN_MS below (no queue/DB, resets on redeploy),
// but keyed by uid so one authenticated visitor can't burn through the
// shared bot token's own rate limit for everyone else.
const telegramNotifyLastSentAt = new Map();
const TELEGRAM_NOTIFY_COOLDOWN_MS = 10_000;

function checkTelegramNotifyRateLimit(uid) {
  const now = Date.now();
  const last = telegramNotifyLastSentAt.get(uid) || 0;
  if (now - last < TELEGRAM_NOTIFY_COOLDOWN_MS) return false;
  telegramNotifyLastSentAt.set(uid, now);
  return true;
}

// Sends a Telegram message on behalf of the caller. The bot token is a single
// app-level secret (this app is single-tenant, see comment above) — the
// destination is always THIS deployment's own configured channel
// (TELEGRAM_CHAT_ID, the same env var the webhook handler below already
// trusts), never a value read from a per-uid Firestore doc. Reading chatId
// from telegramConfig/{uid} used to let any authenticated anonymous visitor
// (auth is anonymous-only, docs/known-risks.md item 1) write an arbitrary
// chat_id into their own doc and turn this endpoint into an open relay for
// the real bot token (docs/known-risks.md item 80, D-1).
app.post('/api/telegram-notify', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }
  if (text.length > 4000) {
    return res.status(400).json({ error: 'text muito longo (máx. 4000 caracteres).' });
  }
  if (!checkTelegramNotifyRateLimit(req.uid)) {
    return res.status(429).json({ error: 'Aguarde um pouco antes de enviar outra notificação.' });
  }
  if (!process.env.TELEGRAM_CHAT_ID) {
    return res.status(503).json({ error: 'TELEGRAM_CHAT_ID não configurado neste servidor.' });
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Telegram API error:', response.status, errText);
      return res.status(502).json({ error: 'Falha ao enviar mensagem no Telegram.' });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('telegram-notify failed:', e.message);
    res.status(500).json({ error: 'Erro interno ao enviar notificação.' });
  }
});

// Receives the alert JSON the Pine Script (v13.2, Grupo 10) sends via
// TradingView's webhook alert mechanism. Logs/notifies only — no order is
// ever sent to Binance from here (see docs/known-risks.md). Each alert type
// the Pine script emits (OPEN, TP1, SL, RUNNER, RF_EXIT, CHOP_EXIT,
// TIME_STOP, INVALIDATION) already carries its own distinct signal_id
// (symbol_side_TIMEFRAME_reason_candleCloseISO-ish), so a plain
// create-if-absent by signal_id is sufficient dedup — no need to key on
// "action" separately.
app.post('/webhook/tradingview', async (req, res) => {
  const alert = req.body || {};

  if (!process.env.WEBHOOK_SECRET || alert.secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing secret.' });
  }

  const { signal_id: signalId, action } = alert;
  if (typeof signalId !== 'string' || !signalId || typeof action !== 'string' || !action) {
    return res.status(400).json({ error: 'signal_id and action are required.' });
  }

  try {
    const ref = db.collection('tradingviewWebhookEvents').doc(signalId);
    const created = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { ...alert, source: 'tradingview_webhook', received_at: new Date().toISOString() });
      return true;
    });

    if (created && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      const text = `📡 TradingView: ${alert.symbol || '?'} ${alert.side || ''} — ${action}`
        + (alert.reason ? ` (${alert.reason})` : '')
        + (alert.price ? `\nPreço: ${alert.price}` : '');
      // Fire-and-forget — a Telegram outage must not fail the webhook ack
      // TradingView is waiting on (it may retry/give up based on our response).
      fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
      }).catch((e) => console.error('webhook telegram notify failed:', e.message));
    }

    res.json({ ok: true, deduped: !created });
  } catch (e) {
    console.error('tradingview webhook failed:', e.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// --- Backtest dispatch (GitHub Actions) -------------------------------
// Deixa o painel disparar o workflow .github/workflows/backtest.yml (que já
// roda isolado — backend fake em memória, Telegram no-op, ver o próprio
// arquivo do workflow) em vez de exigir abrir o GitHub manualmente. Esta
// rota só DISPARA e lê esse workflow via API — nunca roda o motor aqui,
// nunca toca Firestore de produção nem manda Telegram real.
// GITHUB_ACTIONS_TOKEN deve ser um PAT fine-grained escopado só a este
// repositório, com permissão "Actions: Read and write" e nada mais.
const GITHUB_OWNER = 'mateusraony';
const GITHUB_REPO = 'Sentinel-Signals';
const WORKFLOW_FILE = 'backtest.yml';
const GITHUB_API = 'https://api.github.com';

// Únicas chaves repassadas para o workflow_dispatch — qualquer outro campo
// do corpo da requisição é ignorado, nunca encaminhado à API do GitHub.
const BACKTEST_INPUT_KEYS = [
  'symbols', 'from', 'to', 'timeframes', 'smc', 'smc_confirm',
  'pine_config', 'no_costs', 'fee_bps', 'slippage_bps', 'funding_bps',
  'min_trades', 'trial_label',
];

function githubHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_ACTIONS_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function requireGithubToken(req, res, next) {
  if (!process.env.GITHUB_ACTIONS_TOKEN) {
    return res.status(503).json({ error: 'GITHUB_ACTIONS_TOKEN não configurado neste servidor.' });
  }
  next();
}

// Sem fila/DB — só evita clique duplo/disparo repetido acidental. Reinicia a
// cada deploy do server; é um freio de cortesia, não uma garantia forte.
let lastTriggerAt = 0;
const TRIGGER_COOLDOWN_MS = 60_000;

app.post('/api/backtest/trigger', requireAuth, requireGithubToken, async (req, res) => {
  const now = Date.now();
  if (now - lastTriggerAt < TRIGGER_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Aguarde um pouco antes de disparar outro backtest.' });
  }

  const body = req.body || {};
  const trialLabel = typeof body.trial_label === 'string' ? body.trial_label.trim() : '';
  if (!trialLabel) {
    return res.status(400).json({ error: 'trial_label é obrigatório.' });
  }
  if (trialLabel.length > 200) {
    return res.status(400).json({ error: 'trial_label muito longo (máx. 200 caracteres).' });
  }

  // from/to e pine_config viram argumentos de scripts Node/valores lidos no
  // workflow (nunca interpolados direto num script — ver os comentários de
  // backtest.yml), então não há risco de injeção de comando aqui. Ainda
  // assim validamos formato: falhar cedo com erro claro é melhor do que
  // disparar um run que só vai falhar minutos depois no GitHub. Checagem
  // client-side existe (TriggerBacktestPanel.jsx), mas não é confiável — só
  // ela permitiria contornar validando direto na API.
  for (const dateField of ['from', 'to']) {
    const value = body[dateField];
    if (value && Number.isNaN(new Date(value).getTime())) {
      return res.status(400).json({ error: `Campo "${dateField}" não é uma data válida.` });
    }
  }
  if (body.pine_config) {
    try {
      JSON.parse(body.pine_config);
    } catch {
      return res.status(400).json({ error: 'pine_config precisa ser um JSON válido.' });
    }
  }

  // 4000, não 2000: um pine_config real (overrides de vários campos da
  // estratégia, não só um {"minScore":80} minúsculo) pode passar de 2000
  // caracteres com facilidade. Rejeitar com 400 em vez de truncar — um
  // corte silencioso depois do JSON.parse acima devolveria JSON quebrado
  // pro workflow, que falharia minutos depois no GitHub sem nenhuma pista
  // de que a causa foi um limite de tamanho aqui.
  const MAX_INPUT_LEN = 4000;
  const inputs = { trial_label: trialLabel };
  for (const key of BACKTEST_INPUT_KEYS) {
    if (key === 'trial_label') continue;
    const value = body[key];
    if (value === undefined || value === null || value === '') continue;
    // workflow_dispatch sempre recebe string no payload da API, mesmo pros
    // inputs `type: boolean` do YAML — a Actions API coage pelo nome do
    // input declarado, não pelo tipo JS enviado aqui.
    const str = String(value);
    if (str.length > MAX_INPUT_LEN) {
      return res.status(400).json({ error: `Campo "${key}" excede o tamanho máximo (${MAX_INPUT_LEN} caracteres).` });
    }
    inputs[key] = str;
  }

  try {
    const dispatchRes = await fetch(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs }),
      },
    );
    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text();
      console.error('backtest dispatch failed:', dispatchRes.status, errText);
      return res.status(502).json({ error: 'Falha ao disparar o workflow no GitHub.' });
    }
    lastTriggerAt = now;

    // O dispatch não devolve o run criado — localiza pelo mais recente
    // workflow_dispatch da lista, com pequenas tentativas (leva ~1-2s para
    // aparecer na listagem depois do 204 do dispatch).
    let matchedRun = null;
    for (let attempt = 0; attempt < 5 && !matchedRun; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const runsRes = await fetch(
        `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=5`,
        { headers: githubHeaders() },
      );
      if (!runsRes.ok) continue;
      const runsData = await runsRes.json();
      matchedRun = (runsData.workflow_runs || []).find((r) => new Date(r.created_at).getTime() >= now - 5000);
    }

    if (!matchedRun) {
      return res.json({ ok: true, runId: null, warning: 'Workflow disparado, mas não foi possível localizar o run automaticamente — confira em github.com.' });
    }
    res.json({ ok: true, runId: matchedRun.id, htmlUrl: matchedRun.html_url });
  } catch (e) {
    console.error('backtest trigger failed:', e.message);
    res.status(500).json({ error: 'Erro interno ao disparar o backtest.' });
  }
});

app.get('/api/backtest/status/:runId', requireAuth, requireGithubToken, async (req, res) => {
  const { runId } = req.params;
  if (!/^\d+$/.test(runId)) {
    return res.status(400).json({ error: 'runId inválido.' });
  }
  try {
    const runRes = await fetch(`${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`, { headers: githubHeaders() });
    if (!runRes.ok) {
      return res.status(runRes.status === 404 ? 404 : 502).json({ error: 'Falha ao consultar o status do run.' });
    }
    const run = await runRes.json();
    res.json({ status: run.status, conclusion: run.conclusion, htmlUrl: run.html_url });
  } catch (e) {
    console.error('backtest status failed:', e.message);
    res.status(500).json({ error: 'Erro interno ao consultar status.' });
  }
});

app.get('/api/backtest/artifact/:runId', requireAuth, requireGithubToken, async (req, res) => {
  const { runId } = req.params;
  if (!/^\d+$/.test(runId)) {
    return res.status(400).json({ error: 'runId inválido.' });
  }
  try {
    const listRes = await fetch(`${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}/artifacts`, { headers: githubHeaders() });
    if (!listRes.ok) {
      return res.status(502).json({ error: 'Falha ao listar artifacts do run.' });
    }
    const { artifacts } = await listRes.json();
    const artifact = (artifacts || []).find((a) => a.name === 'backtest-report');
    if (!artifact) {
      return res.status(404).json({ error: 'Artifact "backtest-report" não encontrado neste run — ele só existe depois que o job termina.' });
    }

    // GitHub responde com um 302 para uma URL assinada — o header
    // Authorization NÃO deve ir no 2º request (a URL já carrega sua própria
    // autenticação via query string; alguns storages rejeitam um
    // Authorization extra).
    const downloadRes = await fetch(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/artifacts/${artifact.id}/zip`,
      { headers: githubHeaders(), redirect: 'manual' },
    );
    const redirectUrl = downloadRes.headers.get('location');
    if (downloadRes.status !== 302 || !redirectUrl) {
      return res.status(502).json({ error: 'Falha ao obter link de download do artifact.' });
    }
    const zipRes = await fetch(redirectUrl);
    if (!zipRes.ok) {
      return res.status(502).json({ error: 'Falha ao baixar o artifact.' });
    }
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());

    const zip = new AdmZip(zipBuffer);
    const entry = zip.getEntry('backtest-report.json');
    if (!entry) {
      return res.status(502).json({ error: 'backtest-report.json não encontrado dentro do artifact.' });
    }
    const reportJson = JSON.parse(entry.getData().toString('utf-8'));
    res.json(reportJson);
  } catch (e) {
    console.error('backtest artifact failed:', e.message);
    res.status(500).json({ error: 'Erro interno ao buscar o relatório.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`sentinel-signals-api listening on :${port}`));
