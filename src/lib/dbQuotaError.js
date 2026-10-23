// Cota do BANCO (Postgres/Neon) esgotada — docs/known-risks.md item 282.
//
// O Neon recusa TODA consulta (SQLSTATE 53000) quando o projeto estoura uma
// cota do plano gratuito (computação, transferência de rede ou armazenamento),
// e a mensagem é a mesma nos três casos:
//   "Your account or project has exceeded the quota. Upgrade your plan to
//    increase limits."
// Variantes com o nome da cota existem ("...exceeded the compute time quota").
// O texto NÃO diz qual cota foi — só o painel do Neon diz. Por isso o alerta
// pede para olhar o painel em vez de chutar a causa.
//
// Distinto da cota do Firestore (scripts/failureClassification.mjs,
// `isFirestoreQuotaExhausted`): aquela traz "Quota exceeded"/RESOURCE_EXHAUSTED,
// a ordem das palavras é outra e as duas não se confundem.
//
// Módulo puro: só lê uma string. Usado pelo cron (alerta + classificação) e
// por src/lib/scanner.js (o alerta de lock não deve repetir o mesmo sintoma).

/**
 * Código que a API devolve no corpo do 503 quando o banco está sem cota
 * (server/dbErrorResponse.js) e que o navegador lê (src/lib/apiBackend.js).
 * Uma só constante para os dois lados não divergirem.
 */
export const DB_QUOTA_CODE = 'db_quota';

const DB_QUOTA_RE = /exceeded the (?:[a-z ]{0,30})?quota/i;

/**
 * A mensagem de erro é a de cota esgotada do Neon?
 * @param {unknown} message
 */
export function isDatabaseQuotaExhausted(message) {
  return DB_QUOTA_RE.test(String(message ?? ''));
}
