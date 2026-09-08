// server/index.js e as rotas em server/routes/ são CommonJS, mas
// db/pgEntitiesCore.mjs é ESM de propósito (ver o cabeçalho desse arquivo —
// depende de src/lib/opTransition.js, que só existe como ESM). Node permite
// `import()` dinâmico dentro de CJS; cacheado aqui uma única vez, todo
// handler assíncrono paga o custo do import só na 1ª chamada.
let cached = null;
function getPgCore() {
  if (!cached) {
    cached = import('../db/pgEntitiesCore.mjs');
  }
  return cached;
}

// Mesmo padrão de `requireGithubToken` em index.js: as rotas Postgres
// existem no código (Fase 5 do plano de migração) mas ninguém em produção
// as chama ainda — sem DATABASE_URL configurada, responder 503 com uma
// mensagem clara é melhor do que deixar a 1ª query real falhar com um erro
// de conexão menos óbvio.
function requireDatabaseUrl(req, res, next) {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'DATABASE_URL não configurado neste servidor.' });
  }
  next();
}

module.exports = { getPgCore, requireDatabaseUrl };
