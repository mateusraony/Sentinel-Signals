const express = require('express');
const cors = require('cors');
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

// Sends a Telegram message on behalf of the caller. The bot token is a single
// app-level secret (this app is single-tenant); each user only supplies
// their own destination chat_id (telegramConfig/{uid}), never the token.
app.post('/api/telegram-notify', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }

  try {
    const cfgSnap = await db.collection('telegramConfig').doc(req.uid).get();
    const chatId = cfgSnap.exists ? cfgSnap.data().chatId : null;
    if (!chatId) {
      return res.status(412).json({ error: 'Chat ID do Telegram não configurado.' });
    }

    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`sentinel-signals-api listening on :${port}`));
