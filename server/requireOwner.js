// Extraído de server/index.js's estilo (entityCollectionGuard.js/
// rateLimit.js/tradeOpPatchGuard.js) só para ser testável sem as
// credenciais do firebase-admin que index.js exige no carregamento.
//
// Fecha o achado P0 de autorização (sentinel-security-review, 2026-09-14):
// requireAuth (index.js) só prova "este é um token Firebase válido" — com
// auth anônima automática (AuthContext.jsx's signInAnonymously, decisão
// intencional #1 do CLAUDE.md: "qualquer URL entra sem senha"), qualquer
// sessão com a URL da API ganha um token válido de graça e passava a
// acessar /api/entities, /api/trade-ops e /api/locks inteiros. Uma chave
// compartilhada fecha isso sem reintroduzir tela de login — mesmo padrão já
// aceito no projeto para o token do Telegram (src/lib/telegram.js, decisão
// intencional #2: secret em localStorage, enviado direto do browser).
//
// Comparação em tempo constante — mesmo raciocínio de safeCompareSecret em
// index.js (WEBHOOK_SECRET): um `!==` simples vaza a chave byte a byte via
// timing. Buffer.from em algo que não é string lança, então o typeof guard
// roda primeiro.
const crypto = require('crypto');

function checkOwnerKey(providedKey, expectedKey) {
  if (typeof providedKey !== 'string' || !providedKey) return false;
  if (typeof expectedKey !== 'string' || !expectedKey) return false;
  const a = Buffer.from(providedKey);
  const b = Buffer.from(expectedKey);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireOwner(req, res, next) {
  const providedKey = req.headers['x-owner-key'];
  if (!checkOwnerKey(providedKey, process.env.OWNER_ACCESS_KEY)) {
    return res.status(403).json({ error: 'Chave de acesso ausente ou inválida.' });
  }
  next();
}

module.exports = { checkOwnerKey, requireOwner };
