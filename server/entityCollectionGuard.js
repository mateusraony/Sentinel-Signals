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
function checkCollectionAccess(ENTITY_TABLES, collection) {
  if (!(collection in ENTITY_TABLES)) {
    return { allowed: false, status: 404, error: `Coleção "${collection}" não existe.` };
  }
  if (collection === 'User') {
    return { allowed: false, status: 403, error: 'A coleção "User" não é acessível por esta rota genérica — use GET /api/me para o próprio perfil.' };
  }
  return { allowed: true };
}

module.exports = { checkCollectionAccess };
