// Resposta de erro das rotas que falam com o Postgres (docs/known-risks.md
// item 282). Quando o Neon estoura a cota do plano gratuito ele recusa TODA
// consulta; antes disso virar `500 "Erro interno."`, indistinguível de um bug —
// o painel só ficava carregando. Agora vira 503 com `code: 'db_quota'`, que o
// navegador (src/lib/apiBackend.js) reconhece para avisar em vez de insistir.
//
// Extraído para fora de index.js/das rotas pelo mesmo motivo de readyCheck.js:
// testável sem as credenciais do firebase-admin. A detecção reaproveita
// src/lib/dbQuotaError.js (ESM, o mesmo usado pelo cron), via import()
// dinâmico — mesmo padrão de pgCoreLoader.js.
let cachedQuotaModule = null;
function getQuotaModule() {
  if (!cachedQuotaModule) cachedQuotaModule = import('../src/lib/dbQuotaError.js');
  return cachedQuotaModule;
}

/**
 * Responde o erro de uma rota de banco. Cota esgotada → 503 `db_quota`;
 * qualquer outro erro → `fallback` (o status/corpo que a rota já devolvia).
 * Nunca lança: falha ao detectar cai no `fallback`, como antes.
 * @param {import('express').Response} res
 * @param {{ message?: string } | null | undefined} err
 * @param {{ status: number, error: string }} fallback
 */
async function sendDbError(res, err, fallback) {
  try {
    const { isDatabaseQuotaExhausted, DB_QUOTA_CODE } = await getQuotaModule();
    if (isDatabaseQuotaExhausted(err?.message)) {
      return res.status(503).json({ error: 'Banco de dados sem cota.', code: DB_QUOTA_CODE });
    }
  } catch {
    // cai no fallback abaixo
  }
  return res.status(fallback.status).json({ error: fallback.error });
}

module.exports = { sendDbError };
