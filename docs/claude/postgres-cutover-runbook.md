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
- **Decisão do RTDB tomada (2026-09-10): abandonar o atalho**, não
  construir um espelho novo Postgres→RTDB — Postgres/Neon não tem teto
  diário de operações, motivo original do mirror, então ele deixa de fazer
  sentido no dia do cutover. Ver `docs/known-risks.md` item 170 addendum
  (2026-09-10).
- **Itens 2 (browser), 3 (`AuthContext.jsx`) e 4b (webhook) preparados
  numa única PR, mas NÃO mesclados** — mesmo padrão do item 1: mudam o
  backend AO VIVO no momento em que mesclam+deployam, então ficam
  esperando o dia do cutover coordenado, não merge automático. Detalhe
  completo em `docs/known-risks.md` item 170 addendum (2026-09-10).
- Workflow de migração/verificação real via GitHub Actions
  (`.github/workflows/migrate-postgres.yml`, item 7 abaixo) — fecha a
  lacuna que faltava pro item 6 (ensaio) poder rodar sem máquina local.
- Dedup do webhook em Postgres, dark (item 4 abaixo) — ainda não ligada em
  `server/index.js`.
- **Ensaio real rodado com sucesso** (item 6 abaixo, run #1 do
  `migrate-postgres.yml`) — 6.061 documentos, TODAS as 10 entidades com
  contagem+checksum batendo, 0 divergência na 1ª tentativa.

**Ainda NÃO pronto** — ver a checklist abaixo. Não tente executar o
cutover sem fechar esses itens primeiro; nenhum deles é opcional.

## Pré-requisitos de código ainda não implementados

Estes bloqueiam o cutover — nenhum é "ajuste de configuração", são mudanças
de código reais que faltam:

1. **`scripts/adminEntities.js` continua sendo a reimplementação Firestore
   completa** (~330 linhas), não o re-export fino de
   `db/pgEntitiesCore.mjs` que o plano prevê ("Nova API própria", `db/
   CLAUDE.md`). O cron (`scripts/run-scan.mjs`/`build-scan.mjs`) importa
   esse arquivo — sem trocar, o cutover do browser/server não move o
   scanner junto.
2. ✅ **Feito, PR aberto sem merge automático** — `src/api/entities.js`
   trocou de conteúdo para o cliente Postgres (o antigo `src/api/
   entitiesPostgres.js`); o Firestore original foi preservado como
   `src/api/entitiesFirestoreLegacy.js` (referência de rollback). Os
   ~20 arquivos consumidores não mudaram por causa dessa troca — mudaram
   por causa da decisão do RTDB abaixo (item 2 do runbook e item 170
   addendum de 2026-09-10 continuam a mesma PR).
   **Consequência da decisão de abandonar o atalho RTDB** (ver acima): os
   20 arquivos que liam via `rtdbEntities.X` foram revertidos para
   `backend.entities.X` na MESMA PR — depois do cutover nada mais escreve
   no RTDB, então deixá-los como estavam congelaria a leitura deles sem
   erro visível. Detalhe completo em `docs/known-risks.md` item 170
   addendum (2026-09-10).
3. ✅ **Feito, mesma PR** — `AuthContext.jsx`'s `loadOrCreateProfile` trocou
   a leitura direta do Firestore (`getDoc`/`setDoc` em `users/{uid}`) por
   `callBackend('/api/me')`, a rota que `server/routes/me.js` já expõe
   (antes dark, agora chamada de verdade nesta PR).
4. ✅ **Feito, mesma PR** — `db/pgEntitiesCore.mjs`'s
   `insertWebhookEventIfNew(id, data)` (`INSERT ... ON CONFLICT (id) DO
   NOTHING RETURNING id`, testado com concorrência real, 25x) agora É
   chamada por `server/index.js`'s `POST /webhook/tradingview`, no lugar
   da transação Firestore (`db.collection('tradingviewWebhookEvents')` +
   `runTransaction`) que fazia isso antes. Guardada por um 503 explícito
   se `DATABASE_URL` não estiver configurada (mesmo comportamento do
   middleware `requireDatabaseUrl` das outras rotas Postgres, replicado
   inline porque esta rota não é um `Router`).
5. ✅ **Feito** (2026-09-12) — `render.yaml`'s serviço `sentinel-signals-api`
   declara `DATABASE_URL` (`sync: false`); o usuário setou o valor real (a
   mesma connection string 'pooled' já usada no secret `DATABASE_URL` do
   GitHub Actions) no dashboard do Render, serviço `sentinel-signals-api` →
   Environment. Ainda não muda nada em produção sozinho — as rotas
   Postgres só passam a ser chamadas de verdade no deploy do dia do
   cutover (passo 3 abaixo).
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

## Pré-requisitos operacionais

- [x] Secret `DATABASE_URL` cadastrado no GitHub Actions.
- [x] Secret `DATABASE_URL` cadastrado no Render, serviço
      `sentinel-signals-api` (2026-09-12).
- [x] Backup do Postgres rodando (`backup-postgres.yml`) — confirmado com
      pelo menos 1 run real bem-sucedido (run #6, 2026-09-12, depois de 3
      correções sucessivas de ambiente — ver `docs/known-risks.md` item
      171). Agendamento diário segue ativo para confirmar recorrência.
- [ ] Backup do Firestore continua rodando (`backup.yml`) — não desativar
      até o fim do bake period (ver abaixo). Verificar a última execução
      agendada antes do dia do cutover (não confirmado nesta rodada).
- [ ] Acesso confirmado ao repositório privado de backup
      (`mateusraony/sentinel-signals-backups`), branches `backups` E
      `backups-postgres` — a branch `backups-postgres` já confirmada
      (push real do run #6 acima); `backups` (Firestore) não reconfirmada
      nesta rodada.

## Passo a passo do dia do cutover

**Antes de começar**: todos os itens das duas checklists acima fechados,
código revisado/mesclado, `npm run lint && npm test && npm run build`
verdes na `main`. Escolha um horário de baixo volume de sinal (não durante
um evento de mercado conhecido).

1. **Pausar o relógio de trading E fechar toda aba aberta do painel**:
   desativar o disparo externo (cron-job.org, ver `docs/claude/
   external-cron-setup.md`) e confirmar que nenhuma run de `scan.yml`/
   `backfill.yml`/`scan-shadow.yml` está em andamento (Actions → aguardar/
   cancelar). **Fechar (ou recarregar) toda aba do painel aberta em
   qualquer dispositivo antes de seguir para o passo 2** — achado real do
   Codex review no PR #339: o painel roda `useAutoScan` no browser
   (`scanAllAssets`/`priceCheckActiveOps`, o mesmo motor do cron), então
   uma aba já carregada continua com o bundle Firestore ANTIGO em memória
   mesmo depois do deploy do passo 3 — ela seguiria criando/transicionando
   `TradeOperation` real no Firestore, e essa escrita nunca chegaria ao
   Postgres, silenciosamente. Fechar as abas ANTES do backfill final (passo
   2) fecha essa corrida pela mesma raiz que o resto deste plano usa
   (snapshot único, sem escritor concorrente por trás) — reabra o painel só
   depois do passo 4 confirmado, pegando o bundle novo. Detalhe em
   `docs/known-risks.md` item 170 addendum (2026-09-10).
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

**Risco menor aceito, não corrigido** (achado do Codex review, PR #339):
`tradingviewWebhookEvents` fica de fora da migração de dados de propósito
(log de auditoria, `db/CLAUDE.md`) — se o TradingView reenviar (retry) um
webhook cujo `signal_id` já tinha sido gravado no Firestore ANTES do
cutover, o Postgres não tem esse id, então `insertWebhookEventIfNew`
devolve `created: true` e manda a notificação do Telegram de novo. Janela
estreita (só ids gravados pouco antes do corte, e só se o TradingView
reenviar depois) e blast radius baixo (o webhook só loga/notifica — nunca
envia ordem, `.claude/rules/trading-safety.md` — o pior caso é uma
mensagem duplicada no Telegram). Aceito sem correção nesta rodada; se
incomodar na prática, a correção seria semear os ids recentes do Firestore
no Postgres como parte do passo 2 acima.

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
