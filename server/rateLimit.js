// Extraído de server/index.js só para ser testável sem precisar das
// credenciais do firebase-admin (index.js faz JSON.parse(process.env.
// FIREBASE_SERVICE_ACCOUNT_JSON) e sai com process.exit(1) se faltar, no
// carregamento do módulo — ver docs/known-risks.md item 145).
//
// Mesmo padrão de freio de cortesia do lastTriggerAt/TRIGGER_COOLDOWN_MS em
// index.js: sem fila/DB, reinicia a cada deploy. Chaveado por req.ip (não
// req.uid) DE PROPÓSITO — ver docs/known-risks.md item 145: a auth aqui é só
// anônima (item 1), então qualquer cliente ganha um uid NOVO de graça
// chamando signInAnonymously() de novo, zerando qualquer cooldown chaveado
// por uid sem custo nenhum. IP é bem mais caro de trocar em massa e é o que
// de fato limita o custo que este freio existe para conter (o rate limit do
// próprio bot do Telegram, a cota de requisições do GITHUB_ACTIONS_TOKEN
// compartilhado). index.js precisa de `app.set('trust proxy', 1)` para
// req.ip refletir o IP real do cliente atrás do proxy reverso do Render, em
// vez do endereço interno do proxy.
function createCooldown(ms, keyOf = (req) => req.ip) {
  const lastAt = new Map();
  return function checkCooldown(req) {
    const key = keyOf(req);
    const now = Date.now();
    const last = lastAt.get(key) || 0;
    if (now - last < ms) return false;
    lastAt.set(key, now);
    return true;
  };
}

module.exports = { createCooldown };
