// Classificação enxuta de falhas para os logs (docs/known-risks.md item 253).
// Função PURA: só devolve uma etiqueta estável a partir de um Error, nunca
// muda o fluxo de quem chama — a mensagem original continua sendo gravada
// como sempre (o dedup de SystemLog é chaveado pela mensagem, não por isto).
// Existe porque "Failed to fetch" sozinho não distingue rede, timeout, backend
// 5xx, auth ou banco — mesma string, causas diferentes.

export const ERROR_CLASS = Object.freeze({
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  HTTP_5XX: 'HTTP_5XX',
  HTTP_4XX: 'HTTP_4XX',
  DATABASE: 'DATABASE',
  UNKNOWN: 'UNKNOWN',
});

const NETWORK_MESSAGE = /failed to fetch|fetch failed|networkerror|load failed|network request failed/i;
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
// Erros do driver pg: classe SQLSTATE 08 (conexão), 53 (recursos), 57 (operador).
const PG_CODE = /^(08|53|57)/;
const DATABASE_MESSAGE = /connection terminated|timeout exceeded when trying to connect|connection refused|too many clients/i;

/** Status HTTP vindo de `err.status` (callBackend) ou do texto "status 503". */
function statusOf(err) {
  if (Number.isInteger(err?.status)) return err.status;
  const match = /status (\d{3})/i.exec(err?.message ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * Aceita qualquer coisa que tenha sido lançada (Error, objeto do driver pg,
 * string solta, null) — por isso o tipo é estrutural e tudo é opcional.
 * @typedef {{ name?: string, message?: string, code?: string, status?: number, cause?: { code?: string } }} ErrorLike
 * @param {ErrorLike | string | null | undefined} input
 * @returns {string} um valor de ERROR_CLASS
 */
export function classifyError(input) {
  if (input == null || typeof input !== 'object') return ERROR_CLASS.UNKNOWN;
  const err = /** @type {ErrorLike} */ (input);

  const status = statusOf(err);
  if (status != null) {
    if (status === 401 || status === 403) return ERROR_CLASS.AUTH;
    if (status === 429) return ERROR_CLASS.RATE_LIMIT;
    if (status === 408 || status === 504) return ERROR_CLASS.TIMEOUT;
    if (status >= 500) return ERROR_CLASS.HTTP_5XX;
    if (status >= 400) return ERROR_CLASS.HTTP_4XX;
  }

  const code = err.code ?? err.cause?.code;
  // AbortError: httpRetry.js aborta via AbortController quando estoura o
  // timeout por tentativa — é o único abort que o app faz hoje.
  if (err.name === 'AbortError' || err.name === 'TimeoutError' || TIMEOUT_CODES.has(code)) {
    return ERROR_CLASS.TIMEOUT;
  }
  // Firebase Auth (auth.currentUser.getIdToken() em callBackend rejeita ANTES
  // de qualquer HTTP, então não há err.status): code "auth/...".
  if (typeof code === 'string' && code.startsWith('auth/')) {
    if (code === 'auth/network-request-failed') return ERROR_CLASS.NETWORK;
    if (code === 'auth/timeout') return ERROR_CLASS.TIMEOUT;
    if (code === 'auth/too-many-requests') return ERROR_CLASS.RATE_LIMIT;
    return ERROR_CLASS.AUTH; // user-token-expired, id-token-expired, invalid-user-token, user-disabled...
  }
  if (typeof code === 'string' && PG_CODE.test(code)) return ERROR_CLASS.DATABASE;
  if (DATABASE_MESSAGE.test(err.message ?? '')) return ERROR_CLASS.DATABASE;
  if (NETWORK_CODES.has(code) || NETWORK_MESSAGE.test(err.message ?? '')) return ERROR_CLASS.NETWORK;
  return ERROR_CLASS.UNKNOWN;
}
