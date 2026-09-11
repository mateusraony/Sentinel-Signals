# scripts — scan agendado, build e admin

`run-scan.mjs`/`build-scan.mjs` empacotam `src/lib/scanner.js` sem modificação
(4 imports redirecionados). `adminPineConfig.js` espelha `pineParser.js`.
`run-backtest.mjs`/`build-backtest.mjs` fazem o mesmo redirecionamento (5º
alvo) para rodar o motor de backtest histórico local — ver
`docs/claude/backtest-usage.md` e `docs/known-risks.md` item 33.
`run-backfill-check.mjs`/`build-backfill.mjs` fazem o mesmo (6º alvo), mas
contra o backend AO VIVO (`adminEntitiesBackfillCache.js` — 4º mirror do
adaptador, envolve `adminEntities.js` com cache em memória só para
`AssetState`/`MonitoredAsset`, ver `docs/known-risks.md` item 137 addendum
2026-08-31) e janela recente ao vivo (`backfillMarketDataProvider.js`) —
checagem retroativa ao adicionar/reativar um ativo, roda em
`.github/workflows/backfill.yml` (workflow separado do scan ao vivo).
`failureClassification.mjs` é o ÚNICO lugar que decide se uma falha é cota
esgotada do Firestore ou apenas uma etapa travada — nunca classifique isso por
regex no ponto de entrada (`docs/known-risks.md` item 162); a mensagem de
`scanTimeout.mjs` diz só o que foi observado, sem chutar a causa.
`health-audit.mjs` (diária às 04:40 UTC + manual, `health-audit.yml`) é a
auditoria de saúde read-only dos itens 164/165 — teto de leitura explícito, o
job falha se ela escrever, e ela avisa no Telegram só quando acha algo.
**Nenhuma consulta dela pode exigir índice composto**: use
`list('-created_date', N)` e filtre em memória, nunca `filter(...)` junto com
`sort` (item 165 — 3 de 5 checagens falharam assim na primeira execução real,
e o erro só aparece contra o banco de verdade). Travado por
`healthAuditQueryTripwire.test.js`. A parte pura mora em
`healthAuditFormat.mjs` **de propósito**: quem importa
`adminEntitiesFirestoreLegacy.js` (ver abaixo) herda o `initializeApp()`
dele no carregamento e quebra sem credencial (foi o que derrubou 17 testes
no item 158) — `adminEntities.js` (Postgres, pós-Fase 10) não tem esse
problema, mas a separação continua valendo pra quem ainda importa o lado
Firestore.

**Fase 10 do plano de migração Firestore→Neon (preparada, PR aberto, ainda
sem merge automático — ver `docs/known-risks.md` item 170 addendum)**:
`scripts/adminEntities.js` deixou de ser a reimplementação Firestore
completa (~330 linhas) e virou um re-export fino de
`db/pgEntitiesCore.mjs` — `build-scan.mjs`/`build-backfill.mjs` continuam
redirecionando `@/api/entities` pra ele SEM NENHUMA mudança nesses dois
arquivos (o nome do arquivo não mudou, só o conteúdo). A versão Firestore
original foi renomeada para `scripts/adminEntitiesFirestoreLegacy.js` —
**não é código morto**: `scripts/backup-firestore.mjs`/`backfill-rtdb.mjs`
(rodam até a decomissão do Firestore, fase 11 do plano) e
`scripts/migrate-firestore-to-postgres.mjs`/`verify-postgres-
migration.mjs` (cujo trabalho É ler Firestore) continuam importando dela.
É esse arquivo renomeado (não mais `adminEntities.js`) que embute o
espelho de leitura RTDB pro dashboard — as 6 entidades de negócio inteiras
(`AssetState`/`MonitoredAsset`/`SignalEvent`/`SystemLog`/`TradeOperation`/
`VerificationTask`, `src/lib/rtdbMirror.js`, ver `docs/known-risks.md`
item 152/169) — ativo só quando `FIREBASE_DATABASE_URL` está setada; sem
ela, é no-op. `scripts/adminPineConfig.js`/`scripts/adminTelegram.js`
também migraram pro `adminEntities.js` Postgres (achado durante a
implementação, não previsto no plano original — liam Firestore direto,
sem passar pelo adaptador). **Pergunta em aberto, não resolvida**: o
mirror RTDB acima não tem equivalente nos novos adaptadores Postgres —
ver a seção própria em `docs/claude/postgres-cutover-runbook.md` antes de
mesclar o item que troca `src/api/entities.js` (browser).
`scripts/backfill-rtdb.mjs` (rodado só manualmente via `backfill-rtdb.yml`,
nunca no cron) faz a cópia inicial Firestore→RTDB que o mirror ao vivo não
cobre sozinho — ver item 152 addendum; continua Firestore-only, importa de
`adminEntitiesFirestoreLegacy.js`.

`scripts/migrate-firestore-to-postgres.mjs` + `scripts/verify-postgres-
migration.mjs` (Fase 7 do plano de migração Firestore→Neon,
`/root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md`) — scripts
operacionais, **agora com workflow** (`.github/workflows/migrate-
postgres.yml`, `workflow_dispatch`, roda `npm run migrate-verify-postgres`
— `scripts/migrate-and-verify-postgres.mjs` — com `FIREBASE_SERVICE_
ACCOUNT_JSON` E `DATABASE_URL` juntos — fecha o item 7 do runbook de
cutover, `docs/claude/postgres-cutover-runbook.md`). **O workflow NÃO chama
os dois scripts abaixo separadamente** — achado real (Codex review, PR
#334): rodar `migrate-firestore-to-postgres.mjs` e depois `verify-postgres-
migration.mjs` como 2 processos faz cada um ler o Firestore DE NOVO; se o
cron ao vivo escrever entre as duas leituras (roda a cada ~5min, e o
"ensaio" do item 6 roda de propósito com o cron ativo), a verificação acusa
divergência falsa mesmo com a migração correta — pior ainda pra coleções
ATUALIZADAS em vez de criadas (`AssetState`/`TradeOperation` não ganham
`created_date` novo a cada scan). `scripts/migrate-and-verify-postgres.mjs`
resolve lendo cada coleção do Firestore **uma única vez**, escrevendo no
Postgres e comparando contra o MESMO array em memória (100% reuso das
funções abaixo — nenhuma lógica de leitura/comparação nova). Os dois
scripts originais continuam existindo e utilizáveis separadamente (o dia
real do cutover já pausa o cron antes de migrar/verificar, então a corrida
não existe lá). O primeiro lê cada coleção de
negócio direto do `firebase-admin/firestore` (paginação real por cursor de
documento, `FieldPath.documentId()` — mesma lição de escala do item 152:
paginar em vez de um único `list()` gigante) e upserta em Postgres via
`db/pgEntitiesCore.mjs`'s `bulkImportEntity` (preserva o id do documento
Firestore, ao contrário de `bulkCreate`/`create`, que sempre geram um id
novo — necessário pra não remapear referências cruzadas como `asset_id`).
**`systemLogs` é limitado aos 2000 mais recentes** (`LIST_LIMIT_OVERRIDES`,
`migrateRecentCollection` em vez de `migrateCollection`) — achado ao
preparar o workflow: migrar o histórico inteiro repetiria o incidente do
item 152 addendum (`backfill-rtdb.mjs` esgotou a cota lendo ~49.700
documentos numa chamada só); paginar evita um request gigante mas não
reduz a CONTAGEM de leituras cobrada pela cota. O segundo lê os DOIS lados
(Firestore direto + `backend.entities.*` do Postgres) e compara contagem +
checksum determinístico por coleção (mesmo limite espelhado via
`readFirestoreCollectionRecent`/`LIST_LIMIT_OVERRIDES`, importado do
primeiro script, pra comparar a MESMA fatia dos dois lados), e,
especificamente para `TradeOperation`, roda `groupActiveOpsByAsset`
(inalterada) contra os dois datasets para confirmar que a migração não
introduziu/removeu uma duplicata de operação ativa por ativo. Escopo: as 10
entidades de `ENTITY_TABLES` — `tradingviewWebhookEvents`/`scannerLocks`
ficam de fora de propósito (mesmo raciocínio de `db/pgEntitiesCore.mjs`:
log de auditoria sem consumidor do histórico / estado de execução
efêmero), assim como `agentConversations`/`experimentalRf1hShadow*`
(decisão de escopo do plano). `scripts/firestorePlainValue.mjs` é o helper
puro compartilhado pelos dois (conversão de `Timestamp` do Firestore —
único tipo exótico em uso, `users/{uid}.created_at` — para string ISO, e o
JSON canônico usado no checksum) — módulo próprio de propósito, sem
`firebase-admin` no carregamento, pra ficar testável sem credencial (mesma
lição de `failureClassification.mjs`/`healthAuditFormat.mjs`, item 166).
`scripts/adminEntitiesFirestoreLegacy.js` exporta `db` (a conexão
Firestore já inicializada) especificamente para esses 2 scripts +
`backfill-rtdb.mjs` reusarem em vez de cada um chamar `initializeApp()` de
novo.

`scripts/backup-postgres.mjs` (Fase 8, `backup-postgres.yml`) — diferente
dos scripts acima, é um wrapper FINO em volta do `pg_dump` nativo (não uma
reimplementação como `backup-firestore.mjs` precisou ser, já que Postgres
tem ferramenta de backup/restore madura e o Firestore não, sem o plano
pago Blaze). Exclui `users`/`scanner_locks` do dump — ver o cabeçalho do
arquivo pro porquê de cada um. Testado com `buildPgDumpArgs` (puro) +
round-trip real `pg_dump`→`pg_restore` contra Postgres de verdade
(`scripts/backup-postgres.test.js`, gated por `TEST_DATABASE_URL`, **num
banco descartável próprio** — `pg_restore --clean` rodando contra a
`TEST_DATABASE_URL` compartilhada corrompia arquivos vizinhos que rodam em
paralelo, ver `db/CLAUDE.md`).
Restauração via `pg_restore` puro, sem script próprio — ver
`docs/restore-postgres.md`. Seguir:

@../.claude/rules/ci-deploy.md
@../.claude/rules/trading-engine.md
@../.claude/rules/pine-parity.md
