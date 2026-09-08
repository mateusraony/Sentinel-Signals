# Runbook de cutover — Firestore → Postgres/Neon

Fase 9 do plano de migração Firestore→Neon
(`/root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md`) — mesmo
padrão de `docs/claude/external-cron-setup.md`: procedimento manual passo a
passo, não automatizado. **Este documento não executa nada sozinho** — é o
guia pra quando o cutover em si (fase 10 do plano) for decidido.

## Status desta rodada (2026-09-08)

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
  migration.mjs`) — testados contra Postgres local, **nunca rodados contra
  o Firestore de produção real** — PR #329.
- Backup diário do Postgres (`scripts/backup-postgres.mjs` +
  `.github/workflows/backup-postgres.yml`) — pré-requisito da fase 11
  satisfeito — PR #330.

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
4. **O webhook `POST /webhook/tradingview` (`server/index.js:159-203`)
   continua gravando o dedup de `signal_id` direto no Firestore**
   (`db.collection('tradingviewWebhookEvents')` + `runTransaction`) — não
   existe hoje nenhum caminho Postgres para isso. `db/schema.sql` já criou
   a tabela `tradingview_webhook_events`, mas `tradingview_webhook_events`
   foi **deliberadamente excluída** de `ENTITY_TABLES`
   (`db/pgEntitiesCore.mjs`, "server-only, nunca passa por
   `backend.entities`") — o cutover precisa de uma função dedicada (mesmo
   padrão de `createUnique`: `INSERT ... ON CONFLICT (id) DO NOTHING
   RETURNING id`, já citado no plano) chamada direto por
   `server/index.js`, não uma entidade genérica nova.
5. **`render.yaml`'s serviço `sentinel-signals-api` não declara
   `DATABASE_URL`** (nem como `sync: false`) — precisa da mesma entrada que
   os outros secrets (`FIREBASE_SERVICE_ACCOUNT_JSON`, etc.) antes do
   secret poder ser setado no dashboard do Render.
6. **`scripts/migrate-firestore-to-postgres.mjs`/`verify-postgres-
   migration.mjs` nunca rodaram contra o Firestore de produção real** —
   só contra Postgres local desta sandbox (a sessão do Claude Code não
   alcança nem o Firestore de produção com credenciais reais nem o Neon
   real, ver `db/CLAUDE.md`). **Rodar um "ensaio" completo (migrar +
   verificar) antes do dia do cutover, fora da janela de manutenção**, é
   como esses scripts vão ser validados contra dado real pela primeira
   vez — não deixe isso pra hora H.
7. **Não existe workflow pra rodar a migração/verificação a partir do
   GitHub Actions.** `db-migrate.yml` (aplicar `db/schema.sql`) já prova o
   padrão — um workflow `workflow_dispatch` com os secrets
   `FIREBASE_SERVICE_ACCOUNT_JSON` E `DATABASE_URL` juntos rodaria os
   scripts do item 6 sem precisar de máquina local. Se preferir rodar na
   sua própria máquina em vez de criar esse workflow, tudo bem — mas
   alguém precisa decidir qual caminho antes do dia do cutover.

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
2. **Backfill final**: rodar `scripts/migrate-firestore-to-postgres.mjs`
   contra o Firestore de produção real e o Neon de produção real — pela
   máquina local ou pelo workflow do item 7 acima. Isso vai upsertar
   qualquer dado criado desde o último ensaio (item 6).
3. **Verificar**: rodar `scripts/verify-postgres-migration.mjs` logo em
   seguida, mesmas credenciais. **Não prossiga se ele reportar qualquer
   divergência** (contagem, checksum, ou grupos de `TradeOperation`
   duplicados) — investigue a causa raiz primeiro.
4. **Deploy simultâneo**:
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
5. **Reativar o relógio de trading**: religar o disparo externo
   (cron-job.org) assim que os 3 deploys acima estiverem confirmados no
   ar.
6. **Smoke test manual**: abrir o painel, confirmar login (`/api/me`
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
