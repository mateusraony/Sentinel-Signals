# db — schema + adaptador Postgres/Neon (migração em andamento)

Plano completo em `/root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md`
— este diretório cobre as Fases 2-4 (schema, migração de dados, adaptador),
ainda **não conectado a nenhum código de produção**. `src/api/entities.js`/
`scripts/adminEntities.js` continuam 100% Firestore até o cutover;
`server/routes/*.js` chamam `pgEntitiesCore.mjs` mas nada no browser chama
essas rotas ainda (ver `server/CLAUDE.md`).

`schema.sql` é a fonte única do schema (padrão híbrido: colunas tipadas só
pros campos filtrados/ordenados hoje + coluna `data JSONB` com o documento
completo — ver o cabeçalho do arquivo). `migrate.mjs` aplica esse arquivo
(idempotente via `IF NOT EXISTS` em tudo — sem `db/migrations/` versionado
ainda, não há 2ª mudança de schema pra justificar isso hoje).
`.github/workflows/db-migrate.yml` (`workflow_dispatch` manual, secret
`DATABASE_URL`) roda `migrate.mjs` contra o Neon real — o único jeito
automatizado de aplicar o schema, já que esta sessão não alcança o Neon
diretamente (ver abaixo).

`pgEntitiesCore.mjs` é o adaptador — mesma forma de chamada de
`backend` em `src/api/entities.js` (`entities.<Nome>.{list,filter,get,set,
create,createUnique,update,delete,bulkCreate,deleteMany}`, `locks`,
`tradeOps`). **ESM de propósito** (não CJS): depende de `src/lib/
opTransition.js`/`assertNoUndefinedFields.js`/`deepMergeFirestore.js`, que
só existem como ESM. `server/index.js` (CommonJS) consome via `import()`
dinâmico cacheado em `server/pgCoreLoader.js`. `ENTITY_TABLES` (exportado
daqui) é o único registro de "nome lógico → tabela" — a rota genérica de
entidades (`server/routes/entities.js`) importa ele direto em vez de manter
um 2º registro separado.

**`db/package.json` próprio** (com `pg` como dependência, `package-lock.json`
gerado): existe só porque `render.yaml`'s `sentinel-signals-api` builda com
`rootDir: server` — um `npm ci` escopado a `server/` nunca instalaria as
dependências de `db/`, já que a resolução de módulo do Node sobe a árvore
de diretórios a partir de QUEM importa (`pgEntitiesCore.mjs`, em `db/`), não
de quem chama por cima. O `buildCommand` desse serviço no `render.yaml` roda
`npm ci && npm --prefix ../db ci`. Sem isso, o boot do servidor funcionaria
localmente (onde `db/node_modules` resolve pra cima até a raiz do repo, que
tem `pg`) mas quebraria em produção assim que uma rota Postgres fosse
chamada de verdade — achado só porque o boot real foi testado ponta a ponta
antes de mesclar (ver `docs/known-risks.md` item 170).

`trade_operations.active_ops_anchor` + o índice único parcial
`trade_operations_active_anchor_uq` são o mecanismo do CAS redesenhado
(substitui `assetActiveOps` do Firestore) — revisado por
`sentinel-council-review` antes de existir. **Não remova/enfraqueça esse
índice sem entender `db/concurrency.test.js`** — ele existe especificamente
porque um `SELECT ... FOR UPDATE` sozinho NÃO fecha a corrida de criar a
primeira operação de um ativo (linhas que ainda não existem não têm o que
travar); o índice único é o que fecha.

## Testes contra Postgres real (não fake, não mock)

`schema.test.js`/`concurrency.test.js`/`pgEntitiesCore.test.js` são gated
por `TEST_DATABASE_URL`
(`describe.skipIf`) — `npm test` sem essa var pula os dois de forma limpa.
Rodar localmente contra um Postgres qualquer (não precisa ser Neon — é só
Postgres padrão):

```
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/dbname npx vitest run db/
```

No CI, `ci.yml` sobe um `services: postgres:` (container local ao runner,
sem rede externa, sem custo) e passa essa var automaticamente — ver
`.claude/rules/ci-deploy.md`.

**A sessão remota do Claude Code não alcança Neon** (nem TCP direto nem a
API HTTP do driver serverless — bloqueado pela política de rede do
ambiente, mesma classe de restrição que já bloqueia a Binance aqui). Isso
não é specific a nenhuma credencial — é por isso que a validação deste
diretório é feita contra Postgres local (nesta sessão, quando disponível,
ou no CI), nunca direto contra o Neon real a partir daqui. A aplicação
final do schema contra o projeto Neon de produção é um passo manual do
usuário (ou de um `workflow_dispatch` que rode no runner do GitHub, que
tem rede irrestrita).

## Regras ao mexer aqui

- Nunca commitar uma `DATABASE_URL`/connection string real — só o nome da
  variável (`.env.example`), nunca o valor.
- Toda mudança que toque `trade_operations`/o mecanismo de âncora exige os
  mesmos testes de concorrência REAIS (2+ conexões distintas, não um mock)
  — mesma disciplina de `.claude/rules/trading-engine.md`.
