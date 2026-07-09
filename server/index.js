const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`sentinel-signals-api listening on :${port}`));
