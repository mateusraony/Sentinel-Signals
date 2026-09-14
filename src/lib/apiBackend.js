/**
 * Client for the sentinel-signals-api backend (a small Render Web Service
 * that holds server-side secrets like the Telegram bot token). Requests are
 * authenticated with the caller's Firebase ID token — the backend verifies
 * it with firebase-admin before doing anything.
 */
import { auth } from '@/lib/firebaseClient';

const BASE_URL = import.meta.env.VITE_BACKEND_URL;

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
    return fetch(`${BASE_URL}${path}`, {
      method: httpMethod,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      ...(httpMethod === 'GET' || httpMethod === 'DELETE' ? {} : { body: JSON.stringify(body || {}) }),
    });
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
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  return data;
}
