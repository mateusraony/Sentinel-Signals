/**
 * Chave de acesso ao backend (server/) — achado P0 do sentinel-security-
 * review (2026-09-14): requireAuth (server/index.js) só prova "token
 * Firebase válido", não "é o dono". Com auth anônima automática (decisão
 * intencional #1 do CLAUDE.md), qualquer sessão com a URL da API acessava
 * /api/entities, /api/trade-ops e /api/locks inteiros. Esta chave (header
 * X-Owner-Key, comparada contra OWNER_ACCESS_KEY no server via
 * server/requireOwner.js) fecha isso.
 *
 * Mesmo padrão já aceito no projeto para o token do Telegram
 * (src/lib/telegram.js, decisão intencional #2): secret salvo em
 * localStorage, enviado direto do browser — não é Cloud Functions/Blaze,
 * não muda a política "sem tela de login".
 */
const STORAGE_KEY = 'sentinel_owner_key';

export function getOwnerKey() {
  try { return localStorage.getItem(STORAGE_KEY) || ''; }
  catch { return ''; }
}

export function setOwnerKey(key) {
  try { localStorage.setItem(STORAGE_KEY, key || ''); }
  catch { /* localStorage indisponível (modo privado/quota) — sem-op, mesma tolerância de telegram.js */ }
}

export function isOwnerKeyConfigured() {
  return getOwnerKey().length > 0;
}
