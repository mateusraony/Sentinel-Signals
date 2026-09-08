# server — Express + firebase-admin (deployado no Render)

Webhook só loga/notifica, nunca envia ordem. Superfície sensível (secrets, CORS,
auth).

`routes/{entities,tradeOps,locks,me}.js` — API própria da migração
Firestore→Neon (Fase 5, `/root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md`,
`db/CLAUDE.md`). **Dark**: monta em `index.js` mas nada no browser chama
essas rotas ainda; sem `DATABASE_URL` configurada elas respondem 503
(`pgCoreLoader.js`'s `requireDatabaseUrl`) em vez de tentar conectar.
`tradeOpPatchGuard.js` bloqueia campos estruturais (`id`/`asset_id`/
`created_date`/`symbol`/`active_ops_anchor`) no `patch` de
`POST /api/trade-ops/:id/transition` — denylist, não allowlist, ver o
comentário no próprio arquivo pro porquê. Mesma disciplina de
`rateLimit.js`: lógica extraída para fora de `index.js` especificamente
pra ser testável sem as credenciais do firebase-admin que `index.js` exige
no carregamento do módulo.

Seguir:

@../.claude/rules/security.md
@../.claude/rules/trading-safety.md
