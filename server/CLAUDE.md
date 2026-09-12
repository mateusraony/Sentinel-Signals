# server — Express + firebase-admin (deployado no Render)

Webhook só loga/notifica, nunca envia ordem. Superfície sensível (secrets, CORS,
auth).

`routes/{entities,tradeOps,locks,me}.js` — API própria da migração
Firestore→Neon (Fase 5, `/root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md`,
`db/CLAUDE.md`). Montadas em `index.js`; sem `DATABASE_URL` configurada elas
respondem 503 (`pgCoreLoader.js`'s `requireDatabaseUrl`) em vez de tentar
conectar. **A partir do cutover** (item 2/3 do runbook,
`docs/claude/postgres-cutover-runbook.md`) o browser passa a chamá-las de
verdade — `entities`/`locks`/`tradeOps` via `src/api/entities.js`, `me` via
`AuthContext.jsx`'s `loadOrCreateProfile`. Antes do cutover mesclar, elas
existem no código mas nada em produção as chama — confirme no runbook se o
cutover já aconteceu antes de assumir qual dos dois estados vale.
`tradeOpPatchGuard.js` bloqueia campos estruturais (`id`/`asset_id`/
`created_date`/`symbol`/`active_ops_anchor`) no `patch` de
`POST /api/trade-ops/:id/transition` — denylist, não allowlist, ver o
comentário no próprio arquivo pro porquê. Mesma disciplina de
`rateLimit.js`: lógica extraída para fora de `index.js` especificamente
pra ser testável sem as credenciais do firebase-admin que `index.js` exige
no carregamento do módulo.

`POST /webhook/tradingview` (`index.js`) grava o dedup em Postgres via
`insertWebhookEventIfNew` (`db/pgEntitiesCore.mjs`, item 4b do runbook) —
não em `tradingviewWebhookEvents` do Firestore como antes. Mesmo guard
inline de `DATABASE_URL` ausente (503), já que esta rota não é um `Router`
e não pode usar o middleware `requireDatabaseUrl` das rotas acima.
`requireAdmin` (gate de `/api/backtest/trigger`) **continua lendo o Firestore
direto** (`db.collection('users')`) — não migrado nesta rodada, ver
`docs/known-risks.md` item 170 addendum (2026-09-10) pro porquê e o risco
de divergência que isso deixa em aberto.

Seguir:

@../.claude/rules/security.md
@../.claude/rules/trading-safety.md
