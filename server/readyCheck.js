// Extraído de server/index.js só para ser testável sem precisar das
// credenciais do firebase-admin (index.js faz JSON.parse(process.env.
// FIREBASE_SERVICE_ACCOUNT_JSON) e sai com process.exit(1) se faltar, no
// carregamento do módulo — mesmo motivo de rateLimit.js/requireOwner.js).
//
// Timeout PRÓPRIO (menor que o connectionTimeoutMillis do pool, 10s,
// db/pgEntitiesCore.mjs) — um /ready lento é pior que um /ready que falha
// rápido. `pool` é injetado (não lido de getPgCore() aqui) para o teste não
// precisar de um Postgres real nem do import() dinâmico do pgCoreLoader.
async function checkDatabaseReady(pool, timeoutMs) {
  const startedAt = Date.now();
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return { status: 'ok', database: 'ok', database_latency_ms: Date.now() - startedAt };
  } catch (e) {
    return { status: 'error', database: 'error', error: e.message };
  }
}

module.exports = { checkDatabaseReady };
