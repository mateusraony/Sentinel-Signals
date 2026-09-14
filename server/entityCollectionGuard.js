// Extraído de server/routes/entities.js para ser testável sem Express nem
// o import() dinâmico de db/pgEntitiesCore.mjs — mesmo padrão de
// rateLimit.js/tradeOpPatchGuard.js.
//
// Achado do sentinel-security-review (Fase 5 da migração Firestore→Neon):
// `firestore.rules` hoje trata `users/{uid}` como "dono only" — qualquer
// sessão anônima autenticada só pode ler/escrever o PRÓPRIO doc, nunca o de
// outro uid (.claude/rules/firestore-concurrency.md). As demais coleções de
// negócio são `isSignedIn()` genérico, sem isolamento por dono. A 1ª versão
// desta rota só bloqueava mudar `role` no PATCH — deixava GET/PATCH/DELETE
// de QUALQUER uid passarem, e a rota de listagem/filtro devolvia a tabela
// `users` INTEIRA (email+role de todo mundo) pra qualquer chamador
// autenticado. Em vez de replicar isolamento por dono só pra esta rota
// genérica (nenhuma outra coleção precisa), `User` é bloqueada por completo
// aqui — `GET /api/me` (server/routes/me.js) já cobre 100% do uso legítimo
// hoje (ler/criar o PRÓPRIO perfil, sempre por `req.uid`, nunca por um id
// vindo do cliente).
//
// `TradeOperation` (achado P0 do mesmo review, 2026-09-14): tem rota CAS
// dedicada (server/routes/tradeOps.js — create-if-none-active/transition/
// clear-active) que protege a máquina de estados
// (.claude/rules/trading-engine.md) e o índice único parcial
// `active_ops_anchor`. Mas por estar em ENTITY_TABLES
// (db/pgEntitiesCore.mjs), a mesma coleção também passava pela rota CRUD
// genérica — um PATCH direto mudava `status`/`current_stop`/etc. sem passar
// pelo CAS nem pelo denylist de tradeOpPatchGuard.js (que só é aplicado na
// rota /transition). GET continua liberado (leitura não ameaça a máquina de
// estados); toda escrita é bloqueada aqui, forçando o caminho pelo CAS.
const TRADE_OPERATION_READONLY_METHODS = new Set(['GET']);

function checkCollectionAccess(ENTITY_TABLES, collection, method = 'GET') {
  if (!(collection in ENTITY_TABLES)) {
    return { allowed: false, status: 404, error: `Coleção "${collection}" não existe.` };
  }
  if (collection === 'User') {
    return { allowed: false, status: 403, error: 'A coleção "User" não é acessível por esta rota genérica — use GET /api/me para o próprio perfil.' };
  }
  if (collection === 'TradeOperation' && !TRADE_OPERATION_READONLY_METHODS.has(method)) {
    return { allowed: false, status: 403, error: 'A coleção "TradeOperation" só aceita leitura por esta rota genérica — use /api/trade-ops para criar/alterar operações.' };
  }
  return { allowed: true };
}

module.exports = { checkCollectionAccess };
