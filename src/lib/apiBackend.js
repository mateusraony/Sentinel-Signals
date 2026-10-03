/**
 * Client for the sentinel-signals-api backend (a small Render Web Service
 * that holds server-side secrets like the Telegram bot token). Requests are
 * authenticated with the caller's Firebase ID token — the backend verifies
 * it with firebase-admin before doing anything.
 */
import { auth } from '@/lib/firebaseClient';
import { getOwnerKey } from '@/lib/ownerKey';
import { fetchWithRetry } from '@/lib/httpRetry';

const BASE_URL = import.meta.env.VITE_BACKEND_URL;

// Orçamento de retry menor que o usado para Binance (docs/known-risks.md
// item 57, 5 tentativas / ~15,5s): essas são leituras INTERATIVAS do
// navegador (dashboard esperando a tela carregar), não um scan de cron a
// cada ~5min — 3 tentativas (~3,5s de espera entre elas) cobre o blip de
// rede transitório ("Failed to fetch" contra o backend, visto em produção
// em lock/StrategyConfig) sem deixar a UI travada por muito tempo numa
// falha persistente.
const GET_RETRY_OPTIONS = { maxRetries: 3 };

// method defaults to GET when no body is passed, POST otherwise — existing
// callers (all POST-with-body) keep working unchanged; new GET-only callers
// (e.g. polling a job's status) just omit body. `allow404` is opt-in (used by
// src/api/entitiesPostgres.js's `get(id)`, which — like the Firestore
// original in src/api/entities.js — returns `null` for a missing document
// instead of throwing); every existing caller keeps throwing on 404 as before.
/** @param {string} path @param {object} [body] @param {{ method?: string, allow404?: boolean }} [options] */
export async function callBackend(path, body, { method, allow404 } = {}) {
  if (!BASE_URL) {
    throw new Error('VITE_BACKEND_URL não configurado.');
  }
  if (!auth.currentUser) {
    throw new Error('Não autenticado.');
  }
  const httpMethod = method || (body !== undefined ? 'POST' : 'GET');
  const doFetch = async (forceRefresh) => {
    const idToken = await auth.currentUser.getIdToken(forceRefresh);
    const url = `${BASE_URL}${path}`;
    const fetchOptions = {
      method: httpMethod,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        // requireOwner (server/requireOwner.js) — ignorado por rotas que não
        // o exigem (ex.: /api/me), então é seguro mandar sempre.
        'X-Owner-Key': getOwnerKey(),
      },
      ...(httpMethod === 'GET' || httpMethod === 'DELETE' ? {} : { body: JSON.stringify(body || {}) }),
    };
    // Retry de rede só em GET (leitura) — POST/DELETE mutantes (criar
    // operação, adquirir/liberar lock, etc.) não têm garantia de idempotência
    // na camada HTTP genérica aqui, então continuam com uma única tentativa
    // (quem precisa de retry num caminho específico, como o lock em
    // scanner.js, implementa o próprio retry curto perto da semântica dele).
    if (httpMethod === 'GET') {
      return fetchWithRetry(url, { context: path, fetchOptions, ...GET_RETRY_OPTIONS });
    }
    return fetch(url, fetchOptions);
  };

  let response = await doFetch(false);
  // docs/known-risks.md item 177 — o SDK do Firebase pode devolver do cache
  // um ID token já expirado (aba em segundo plano/notebook em suspensão
  // atrasa o refresh proativo automático) — visto em produção como "Invalid
  // or expired token." em `useAutoScan.js`, vários ativos na mesma passada.
  // Uma única tentativa com refresh FORÇADO cobre esse caso sem mascarar uma
  // falha de auth real: se o 401 persistir mesmo com token novo, continua
  // propagando o erro normalmente.
  if (response.status === 401) {
    response = await doFetch(true);
  }
  if (allow404 && response.status === 404) {
    return null;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // `status` é aditivo (a mensagem não muda) — permite a classifyError
    // (src/lib/errorClass.js) distinguir 401/429/5xx sem parsear texto.
    throw Object.assign(new Error(data.error || `Request failed with status ${response.status}`), { status: response.status });
  }
  return data;
}
