# Runbook de cutover — Firestore → Postgres/Neon

Fase 9 do plano de migração Firestore→Neon
(`/root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md`) — mesmo
padrão de `docs/claude/external-cron-setup.md`: procedimento manual passo a
passo, não automatizado. **Este documento não executa nada sozinho** — é o
guia pra quando o cutover em si (fase 10 do plano) for decidido.

## Status desta rodada (2026-09-09)

**Pronto** (Fases 1-8 do plano, todas mescladas):

- Schema Postgres aplicado no Neon real (`db/schema.sql`, PR #326/#328).
- CAS redesenhado (`db/pgEntitiesCore.mjs`'s `createTradeOpIfNoneActive`/
  `transitionTradeOp`, revisado por `sentinel-council-review` antes de
  existir) — testado com concorrência real, 25x repetido (PR #327).
- Rotas HTTP dark (`server/routes/{entities,tradeOps,locks,me}.js`,
  revisadas por `sentinel-security-review`, 2 achados reais corrigidos) —
  PR #327.
- Cliente HTTP do browser dark (`src/api/entitiesPostgres.js`) — PR #328.
- Scripts de migração/verificação de dados
  (`scripts/migrate-firestore-to-postgres.mjs`/`verify-postgres-
  migration.mjs`) — PR #329, e **já validados contra o Firestore de
  produção real** (ensaio, item 6 abaixo).
- Backup diário do Postgres (`scripts/backup-postgres.mjs` +
  `.github/workflows/backup-postgres.yml`) — pré-requisito da fase 11
  satisfeito — PR #330.
- **Fase 10 (execução) preparada, mas NÃO mesclada** — `scripts/
  adminEntities.js` vira re-export fino de `db/pgEntitiesCore.mjs`
  (item 1 abaixo), PR aberto a pedido explícito do usuário sem merge
  automático (mescla só o backend AO VIVO do cron — diferente de todas as
  fases anteriores, dark até aqui). Ver `docs/known-risks.md` item 170
  addendum.
- Workflow de migração/verificação real via GitHub Actions
  (`.github/workflows/migrate-postgres.yml`, item 7 abaixo) — fecha a
  lacuna que faltava pro item 6 (ensaio) poder rodar sem máquina local.
- Dedup do webhook em Postgres, dark (item 4 abaixo) — ainda não ligada em
  `server/index.js`.
- **Ensaio real rodado com sucesso** (item 6 abaixo, run #1 do
  `migrate-postgres.yml`) — 6.061 documentos, TODAS as 10 entidades com
  contagem+checksum batendo, 0 divergência na 1ª tentativa.

**Preparado, mas NÃO mesclado ainda** (PR aberto, propositalmente sem
merge automático — ver o addendum de 2026-09-08 em `docs/known-risks.md`
item 170 para o detalhe completo):

- Item 1 abaixo: `scripts/adminEntities.js` virou o re-export fino de
  `db/pgEntitiesCore.mjs`; a versão Firestore foi preservada como
  `scripts/adminEntitiesFirestoreLegacy.js` (ainda usada por
  `backup-firestore.mjs`/`backfill-rtdb.mjs`/`migrate-firestore-to-
  postgres.mjs`/`verify-postgres-migration.mjs`, que precisam continuar
  falando com o Firestore real). `scripts/adminPineConfig.js` e
  `scripts/adminTelegram.js` (achado NOVO, não estava na checklist
  original — item 8 abaixo) também migrados para o backend Postgres.
  `.github/workflows/{scan,backfill,count-signals,health-audit}.yml`
  ganharam `DATABASE_URL` no `env:`. **Merging isto sozinho já muda o
  comportamento AO VIVO do cron** (não é código dark como as Fases 1-9) —
  só mesclar depois de pausar o disparo externo (passo 1 do "Passo a
  passo" abaixo) e confirmar `DATABASE_URL` no secret do GitHub Actions
  aponta pro Neon de produção com o schema aplicado.

**Ainda NÃO pronto** — ver a checklist abaixo. Não tente executar o
cutover sem fechar esses itens primeiro; nenhum deles é opcional.

## Pré-requisitos de código ainda não implementados

Estes bloqueiam o cutover — nenhum é "ajuste de configuração", são mudanças
de código reais que faltam:

1. ~~`scripts/adminEntities.js` continua sendo a reimplementação Firestore
   completa~~ — **preparado** (ver acima), aguardando merge no dia do
   cutover.
2. **`src/api/entities.js` continua sendo o Firestore real** — o cutover
   exige trocar o CONTEÚDO deste arquivo pelo do cliente Postgres já
   pronto (`src/api/entitiesPostgres.js`), preservando o Firestore como
   `src/api/entitiesFirestoreLegacy.js` (referência de rollback, ver
   abaixo) — nenhum outro dos ~20 arquivos consumidores deve mudar, porque
   os dois adaptadores já têm a mesma forma externa.
3. **`AuthContext.jsx`'s `loadOrCreateProfile` continua lendo o Firestore
   direto** (`getDoc`/`setDoc` em `users/{uid}`) — precisa trocar para
   `fetch('/api/me', {headers:{Authorization:'Bearer '+idToken}})`, a rota
   que `server/routes/me.js` já expõe (dark).
4. ✅ **Metade feita** — `db/pgEntitiesCore.mjs` ganhou
   `insertWebhookEventIfNew(id, data)` (`INSERT ... ON CONFLICT (id) DO
   NOTHING RETURNING id`, testado com concorrência real, 25x), o
   equivalente Postgres da transação de dedup que `server/index.js`'s
   `POST /webhook/tradingview` (`server/index.js:159-203`) faz hoje contra
   o Firestore (`db.collection('tradingviewWebhookEvents')` +
   `runTransaction`). **Ainda NÃO chamada por `server/index.js`** — a
   troca de verdade (item 4b) é feita só durante a janela de cutover
   coordenada, junto com os outros itens, porque o webhook é um canal ao
   vivo (TradingView está esperando a resposta).
5. ✅ **Metade feita** — `render.yaml`'s serviço `sentinel-signals-api`
   agora declara `DATABASE_URL` (`sync: false`), mesma entrada dos outros
   secrets. **Ainda falta o passo manual**: setar o valor real (a mesma
   connection string 'pooled' já usada no secret `DATABASE_URL` do GitHub
   Actions) no dashboard do Render, serviço `sentinel-signals-api` →
   Environment. Sem isso, as rotas Postgres continuam respondendo 503
   (comportamento seguro, documentado em `server/pgCoreLoader.js`) — nada
   muda em produção só por essa declaração ter sido feita.
6. ✅ **Feito** — ensaio real rodado pelo usuário via `migrate-postgres.yml`
   (run #1, 2026-09-09T19:38-19:40 UTC, `conclusion: success`) —
   **primeira validação real dos scripts de migração/verificação contra o
   Firestore de produção e o Neon real**. 6.061 documentos migrados,
   TODAS as 10 entidades com contagem E checksum batendo
   (`MonitoredAsset` 11, `AssetState` 45, `SignalEvent` 3903,
   `TradeOperation` 16, `PriceAlert` 0, `SystemLog` 2000 — limitado aos
   mais recentes de propósito, `User` 3, `VerificationTask` 81,
   `StrategyConfig`/`TelegramFilters` 1 cada) — inclusive
   `TradeOperation` (o P0 mais crítico): 0 grupos duplicados dos dois
   lados. Zero divergência na primeira tentativa. Detalhe em
   `docs/known-risks.md` item 170 addendum.
7. ✅ **Feito** — `.github/workflows/migrate-postgres.yml`
   (`workflow_dispatch`) roda `npm run migrate-verify-postgres`
   (`scripts/migrate-and-verify-postgres.mjs`) com `FIREBASE_SERVICE_
   ACCOUNT_JSON` E `DATABASE_URL` juntos, mesmo padrão de `db-migrate.yml`.
   Serve tanto pro ensaio (item 6) quanto pra migração final do dia do
   cutover (passo 2-3 abaixo). **2 achados ao preparar este item**: (a)
   `migrate-firestore-to-postgres.mjs` lia `systemLogs` inteiro, sem
   limite — mesma classe de incidente do item 152 addendum
   (backfill-rtdb.mjs esgotou a cota lendo ~49.700 documentos numa chamada
   só) — corrigido com `LIST_LIMIT_OVERRIDES` (2000 mais recentes); (b)
   achado real por review externa (Codex, comentário no PR #334): rodar
   `migrate-firestore-to-postgres.mjs` e `verify-postgres-migration.mjs`
   como 2 processos separados faz cada um ler o Firestore DE NOVO — com o
   cron ao vivo escrevendo entre as duas leituras (o ensaio roda de
   propósito fora da janela de manutenção, cron ativo), a verificação
   podia acusar divergência falsa mesmo com a migração correta.
   Corrigido: `scripts/migrate-and-verify-postgres.mjs` lê cada coleção do
   Firestore **uma única vez**, escreve no Postgres e verifica contra o
   MESMO array em memória — a corrida deixa de existir por construção
   (100% reuso das funções dos 2 scripts originais, que continuam
   existindo/utilizáveis separadamente — o dia real do cutover já pausa o
   cron antes, então lá a corrida nunca existiu).
8. ~~`scripts/adminPineConfig.js`/`scripts/adminTelegram.js` liam
   Firestore direto (`getFirestore()`), sem passar por
   `scripts/adminEntities.js`~~ — **achado durante a implementação do item
   1, não estava na checklist original.** `adminPineConfig.js` lia
   `strategyConfig/current` direto; `adminTelegram.js` lia
   `telegramFilters/current` e gravava um fallback de log em `systemLogs`
   direto também. Sem portar os DOIS, o cron continuaria lendo config de
   estratégia/filtro de Telegram do Firestore MESMO DEPOIS do item 1 —
   drift silencioso entre o que o navegador escreve (Postgres, pós item 2)
   e o que o cron lê (Firestore, stale). **Preparado** junto com o item 1
   (ver acima) — o marcador de dedup de cota do Telegram
   (`systemAlerts/firestoreQuota`, RTDB com fallback Firestore) foi
   deixado INTOCADO de propósito, é específico do Firestore e fica fora
   desta migração.

## RTDB do painel pós-cutover — decisão já tomada (ver abaixo)

**Não era um item de código faltando — era uma decisão de produto**,
achada ao preparar o item 1, **já resolvida em 2026-09-10** (ver o
"Decidido" no fim desta seção). Contexto de como o problema apareceu: o
painel lê dados "ao vivo" via
RTDB (`src/api/rtdbEntities.js`, `docs/known-risks.md` item 152) — um
espelho de LEITURA que existe especificamente para não gastar a cota
diária do Firestore. Esse espelho é alimentado por `withRtdbMirror` dentro
de `src/api/entities.js`/`scripts/adminEntities.js` (a versão Firestore).
Os novos adaptadores Postgres (`src/api/entitiesPostgres.js`,
`scripts/adminEntities.js` pós-cutover) **não escrevem em RTDB — não
existe esse mecanismo no lado Postgres**. Duas opções, nenhuma implementada:

1. **O painel para de ler RTDB e passa a chamar a API HTTP Postgres
   direto** (`GET /api/entities/:collection`, já existe, dark) — faz
   sentido: Postgres não tem cota diária, então o motivo original do
   espelho RTDB desaparece. Mas troca "polling direto no banco" por
   "polling via API HTTP própria" — latência/carga diferentes, não
   medidas ainda.
2. **RTDB continua sendo escrito manualmente** (ex.: um mirror novo
   Postgres→RTDB) só até a decomissão do RTDB (fase 11) — mais trabalho
   pra algo que já está no caminho de saída.

**Decidido (2026-09-10, não nesta PR — ver PR #339/`docs/known-risks.md`
item 170 addendum): opção 1, abandonar o atalho.** Postgres/Neon não tem
teto diário de operações, motivo original do espelho — nenhum mirror novo
Postgres→RTDB foi construído. O painel voltou a ler `backend.entities`
direto (mesmo cliente HTTP do item 2) nos ~20 arquivos que liam via
`rtdbEntities.X`; `src/api/rtdbEntities.js`/`src/lib/rtdbMirror.js` ficam
como código morto até a Fase 11. Essa mudança está preparada no PR #339
(itens 2/3/4b), não nesta PR (item 1, cron) — as duas ficam sincronizadas
porque devem mesclar juntas na janela de cutover coordenada.

## Pré-requisitos operacionais

- [x] Secret `DATABASE_URL` cadastrado no GitHub Actions.
- [ ] Secret `DATABASE_URL` cadastrado no Render, serviço
      `sentinel-signals-api` (depende do item 5 acima primeiro).
- [x] Backup do Postgres rodando (`backup-postgres.yml`) — confirmar que
      pelo menos 1 run agendado real já aconteceu com sucesso (não só o
      teste local) antes do cutover.
- [ ] Backup do Firestore continua rodando (`backup.yml`) — não desativar
      até o fim do bake period (ver abaixo).
- [ ] Acesso confirmado ao repositório privado de backup
      (`mateusraony/sentinel-signals-backups`), branches `backups` E
      `backups-postgres`.

## Passo a passo do dia do cutover

**Antes de começar**: todos os itens das duas checklists acima fechados,
código revisado/mesclado, `npm run lint && npm test && npm run build`
verdes na `main`. Escolha um horário de baixo volume de sinal (não durante
um evento de mercado conhecido).

1. **Pausar o relógio de trading**: desativar o disparo externo
   (cron-job.org, ver `docs/claude/external-cron-setup.md`) e confirmar que
   nenhuma run de `scan.yml`/`backfill.yml`/`scan-shadow.yml` está em
   andamento (Actions → aguardar/cancelar).
2. **Backfill final + verificação**: rodar `scripts/migrate-and-verify-
   postgres.mjs` (`npm run migrate-verify-postgres`) contra o Firestore de
   produção real e o Neon de produção real — pela máquina local ou pelo
   workflow do item 7 acima. Isso vai upsertar qualquer dado criado desde
   o último ensaio (item 6) e verificar na mesma passada (mesmo snapshot,
   sem reler o Firestore — ver item 7 pro porquê). **Não prossiga se ele
   reportar qualquer divergência** (contagem, checksum, ou grupos de
   `TradeOperation` duplicados) — investigue a causa raiz primeiro.
3. **Deploy simultâneo**:
   - `sentinel-signals-api` (Render): confirmar `DATABASE_URL` setada no
     dashboard, deploy da versão com o webhook migrado (item 4) e as
     rotas HTTP já dark ativadas (nada muda pra elas — só passam a ser
     chamadas de verdade).
   - `sentinel-signals` (Render, frontend estático): deploy da versão com
     `src/api/entities.js` trocado (item 2) e `AuthContext.jsx` atualizado
     (item 3).
   - Próximo build do cron (`scripts/build-scan.mjs` via o workflow):
     confirmar que `scripts/adminEntities.js` (item 1) já é o re-export —
     o redirecionamento existente em `build-scan.mjs`/`build-backfill.mjs`
     continua funcionando sem mudança neles.
4. **Reativar o relógio de trading**: religar o disparo externo
   (cron-job.org) assim que os 3 deploys acima estiverem confirmados no
   ar.
5. **Smoke test manual**: abrir o painel, confirmar login (`/api/me`
   funcionando), confirmar que uma tela com dado real (Dashboard/Trades)
   carrega. Disparar `workflow_dispatch` manual de `scan.yml` uma vez e
   conferir no Job Summary/logs que ele rodou contra Postgres sem erro.

## Rollback

Enquanto o Firebase estiver vivo (ver "Manter o Firebase" abaixo), reverter
é rápido:

- **Frontend/`server/`**: usar o "Redeploy" do Render pro deploy anterior
  (mais rápido que reverter+re-buildar) — ou reverter o(s) commit(s) do
  cutover na `main` e deixar o auto-deploy normal cuidar do resto.
- **Cron**: reverter o commit que trocou `scripts/adminEntities.js` — o
  próximo `workflow_dispatch`/`schedule` do `scan.yml` já volta a rodar
  contra Firestore.
- Nenhum dado é perdido no rollback: o Firestore não foi tocado pelo
  cutover (só lido, pela migração) — qualquer operação criada em Postgres
  DURANTE a janela entre o cutover e um rollback precisaria de
  reconciliação manual (ver "Bake period" abaixo, é exatamente o que esse
  acompanhamento de perto substitui).

## Bake period

Dias (não semanas) de acompanhamento próximo logo após o cutover — mesmo
espírito de `scripts/health-audit.mjs`, adaptado: confirmar que nenhuma
métrica de cota do Firestore volta a aparecer nos logs (sinal de que algo
ainda aponta pro backend antigo por engano), acompanhar o dashboard do
Neon (compute-hours, não cota de operações), e qualquer `TradeOperation`
criada/transicionada nessa janela é o que ficaria pendente de
reconciliação manual num rollback tardio.

## Manter o Firebase vivo

Não desativar o projeto Firebase (Spark é gratuito, custo zero em deixá-lo
dormente) por 1-2 semanas após o cutover confirmado estável — é a rede de
segurança do rollback acima. A decisão de decomissionar de verdade
(remover `firebase`/`firebase-admin` das deps, RTDB, `firestore.rules`,
os workflows de backup/backfill do Firestore, etc.) é a fase 11 do plano —
**fora de escopo deste runbook**, só deve começar depois do bake period
confirmado.
