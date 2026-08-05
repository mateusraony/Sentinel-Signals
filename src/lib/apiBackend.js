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
// (e.g. polling a job's status) just omit body.
export async function callBackend(path, body, { method } = {}) {
  if (!BASE_URL) {
    throw new Error('VITE_BACKEND_URL não configurado.');
  }
  if (!auth.currentUser) {
    throw new Error('Não autenticado.');
  }
  const idToken = await auth.currentUser.getIdToken();
  const httpMethod = method || (body !== undefined ? 'POST' : 'GET');
  const response = await fetch(`${BASE_URL}${path}`, {
    method: httpMethod,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    ...(httpMethod === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  return data;
}
