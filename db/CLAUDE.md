# db — schema Postgres/Neon (migração em andamento)

Plano completo em `/root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md`
— este diretório cobre só a Fase 2 (schema + migração de dados), ainda
**não conectado a nenhum código de produção**. `src/api/entities.js`/
`scripts/adminEntities.js` continuam 100% Firestore até o cutover.

`schema.sql` é a fonte única do schema (padrão híbrido: colunas tipadas só
pros campos filtrados/ordenados hoje + coluna `data JSONB` com o documento
completo — ver o cabeçalho do arquivo). `migrate.mjs` aplica esse arquivo
(idempotente via `IF NOT EXISTS` em tudo — sem `db/migrations/` versionado
ainda, não há 2ª mudança de schema pra justificar isso hoje).

`trade_operations.active_ops_anchor` + o índice único parcial
`trade_operations_active_anchor_uq` são o mecanismo do CAS redesenhado
(substitui `assetActiveOps` do Firestore) — revisado por
`sentinel-council-review` antes de existir. **Não remova/enfraqueça esse
índice sem entender `db/concurrency.test.js`** — ele existe especificamente
porque um `SELECT ... FOR UPDATE` sozinho NÃO fecha a corrida de criar a
primeira operação de um ativo (linhas que ainda não existem não têm o que
travar); o índice único é o que fecha.

## Testes contra Postgres real (não fake, não mock)

`schema.test.js`/`concurrency.test.js` são gated por `TEST_DATABASE_URL`
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
