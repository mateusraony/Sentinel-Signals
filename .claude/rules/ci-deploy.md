---
description: CI, deploy e o scan agendado. Carregue ao mexer em workflows, render.yaml ou scripts.
paths:
  - .github/workflows/**
  - render.yaml
  - scripts/**
  - firebase.json
---

# CI / Deploy / Scan agendado

## Workflows

- `ci.yml` — lint + `npm test` + build a cada push/PR. Alerta Telegram em falha.
  Desde a migração Firestore→Neon (plano em
  `/root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md`), o job
  sobe um `services: postgres:` (imagem oficial `postgres:16`, local ao
  runner, sem rede externa, sem custo) e passa `TEST_DATABASE_URL` pro
  `npm test` — é o que faz `db/schema.test.js`/`db/concurrency.test.js`
  rodarem de verdade em vez de pular (`describe.skipIf`). Nenhum outro
  arquivo de teste usa esse serviço.
- `scan.yml` — `npm run scan`. **Relógio de
  trading**: o cadenciamento real de
  ~15min (era 5 min até 2026-10-29, item 286: com 5 min o Neon nunca dorme e
  estoura as 100 h/mês) vem de disparo **externo** (cron-job.org via `workflow_dispatch`,
  configurado e confirmado — ver `docs/claude/external-cron-setup.md`,
  configuração fora do repo, PAT pessoal do usuário); o `schedule:` interno
  (`cron: "7 */6 * * *"`) é só um **fallback a cada 6 h** — GitHub desativa
  `schedule` após ~60 dias sem push, mitigado pelo watchdog externo
  `HEALTHCHECKS_PING_URL` (known-risks 12). Atraso sob carga do `schedule` do
  GitHub Actions em geral, e a medição real feita neste projeto antes do
  disparo externo: known-risks **item 18**. `scripts/run-scan.mjs` envolve as
  3 chamadas que tocam Firestore de verdade (`scanAllAssets`/
  `priceCheckActiveOps`/`checkAssetHealthchecks`) num timeout de aplicação
  de 90s + `process.exit()` forçado (`scripts/scanTimeout.mjs`) — sem isso,
  uma cota esgotada fazia o cliente admin do Firestore travar retry-ando por
  MINUTOS, colidindo com o próximo disparo de ~5min e cascateando em horas
  de execuções canceladas/falhas (known-risks item 142).
- `backfill.yml` — checagem retroativa ao adicionar/reativar um ativo
  (`npm run backfill-check`, `docs/known-risks.md` item 137). Workflow
  SEPARADO de `scan.yml` de propósito, com `concurrency: group:
  backfill-check` próprio e `timeout-minutes: 20` — até 2026-08-29 rodava
  dentro do mesmo job/grupo do scan ao vivo, e um replay de 60 dias/15min
  contra o Firestore real travou 11+min, atrasando o scan de todos os
  ativos (item 137 addendum). Religado em 2026-08-31 depois de achar e
  corrigir a causa raiz (2 pontos de I/O incondicional por tick em
  `persistScanResults`, resolvidos num cache em memória em
  `scripts/adminEntitiesBackfillCache.js`, sem tocar `scanner.js`) — ver o
  addendum de 2026-08-31 no item 137 para o relato completo. Cadência
  própria de 1x a cada 6 h (era de hora em hora até o item 286: cada execução
  acorda o Neon por ~6 min; `workflow_dispatch` também disponível) — ativo novo é
  raro. `scripts/run-backfill-check.mjs` envolve os 3 pontos que tocam
  Firestore de verdade (leitura de pendentes, `getPineConfig`,
  `checkOneAsset` por ativo) num timeout de 5min + `process.exit()`
  forçado — mesmo padrão do `scan.yml` acima (`scripts/scanTimeout.mjs`),
  fechando a lacuna que o item 142 tinha deixado fora de escopo por falta
  de dado real; sem isso, um ativo cujo replay trava (ex.: `RESOURCE_EXHAUSTED`)
  gastava os 20min INTEIROS de `timeout-minutes` contra o Firestore real a
  cada ciclo horário (`docs/known-risks.md` item 147). **A mensagem desse
  timeout diz só o que foi observado** (qual etapa, em quanto tempo): enquanto
  ela carregava a causa provável (`RESOURCE_EXHAUSTED`), os dois pontos de
  entrada classificavam a falha por regex e anunciavam TODO travamento como
  "cota esgotada" — quem classifica agora é
  `scripts/failureClassification.mjs`, único lugar autorizado a decidir isso
  (`docs/known-risks.md` item 162).
- `scan-shadow.yml` / `analyze-shadow.yml` — **PAUSADOS em 2026-09-21**
  (`docs/known-risks.md` item 185) — `schedule:` comentado nos dois
  (`workflow_dispatch` continua disponível pra rodar manualmente se
  precisar). Eram o braço decisório do modo sombra prospectivo (Fase 1, RF
  1h condicionado ao 4h, item 56): `scan-shadow.yml` rodava `npm run
  scan:shadow` escrevendo só em coleções Firestore isoladas
  (`experimentalRf1hShadow*`, nunca operação real nem Telegram);
  `analyze-shadow.yml` era o relatório só-leitura do acúmulo (`npm run
  analyze-shadow-rf1h`, Job Summary + JSON no log). Pausados porque, na
  taxa real de acúmulo medida em 7 semanas (~0,72 op/mês na cascata
  experimental), o piso de amostra decisória (n=30) levaria ~3,5 anos e o
  alvo (n=100) ~11,6 anos — não compensa o custo de cota Firestore
  compartilhada com produção nem a atenção recorrente de sessão.
  Reversível — descomentar o `schedule:` nos dois arquivos religa; nenhuma
  coleção nem código foi apagado.
- `keep-warm.yml` — ping `/health` a cada 10 min (Render free não hibernar).
- `backup.yml` — backup diário das coleções de negócio → branch `backups`.
- `deploy-firestore.yml` — deploy **manual** de rules/índices.
- `db-migrate.yml` — disparo **manual** (`workflow_dispatch` só): aplica
  `db/schema.sql` (via `db/migrate.mjs`, idempotente) no projeto Neon real,
  usando o secret `DATABASE_URL`. Existe porque a sessão remota do Claude
  Code não alcança `*.neon.tech` (política de rede do ambiente — ver
  `db/CLAUDE.md`), então este é o único jeito automatizado de aplicar o
  schema sem o usuário rodar um comando na própria máquina. Parte do plano
  de migração Firestore→Neon
  (`/root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md`), ainda
  não conectado a nenhum código de produção.
- `migrate-postgres.yml` — disparo **manual** (`workflow_dispatch` só):
  roda `npm run migrate-verify-postgres` (`scripts/migrate-and-verify-
  postgres.mjs`) contra o Firestore de produção real E o Neon real, usando
  `FIREBASE_SERVICE_ACCOUNT_JSON` E `DATABASE_URL` juntos — mesma restrição
  de rede do `db-migrate.yml` acima (a sessão do Claude Code não alcança
  nenhum dos dois com credencial real). Fecha o item 7 do runbook de
  cutover (`docs/claude/postgres-cutover-runbook.md`) — usado tanto pro
  "ensaio" pré-cutover (item 6) quanto pela migração final do dia do
  cutover; idempotente (upsert), seguro rodar mais de uma vez. **NÃO** roda
  `migrate-firestore-to-postgres.mjs`/`verify-postgres-migration.mjs` como
  2 processos separados — achado real (Codex review, PR #334): 2 leituras
  independentes do Firestore, uma pra migrar e outra pra verificar, corre o
  risco do cron ao vivo escrever entre as duas (o ensaio roda de propósito
  com o cron ativo) e a verificação acusar divergência falsa. `migrate-and-
  verify-postgres.mjs` lê cada coleção do Firestore uma única vez e
  verifica contra o MESMO array em memória, sem reler — corrida eliminada
  por construção. Falha o job (não silencioso) se achar qualquer
  divergência de verdade de contagem/checksum/duplicata de
  `TradeOperation`. Ainda não conectado a nenhum código de produção — só lê
  Firestore e escreve no Postgres, que nada em produção lê até o cutover
  (item 2) acontecer.
- `backup-postgres.yml` — backup diário do Postgres/Neon via `pg_dump`
  (Fase 8 do plano de migração Firestore→Neon,
  `/root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md`) —
  **pré-requisito obrigatório antes de qualquer decomissão** do backup do
  Firestore (`backup.yml` acima continua rodando em paralelo até o cutover
  real). `scripts/backup-postgres.mjs` gera um dump `--format=custom`
  (exclui `users`/`scanner_locks` — ver o cabeçalho do script) e publica na
  branch `backups-postgres` do MESMO repositório privado
  `mateusraony/sentinel-signals-backups`, mas numa branch **separada** da
  `backups` de `backup.yml` — evita os dois workflows fazendo `git push` na
  mesma branch em janelas próximas (risco de non-fast-forward). Mesma deploy
  key SSH reaproveitada (`BACKUP_DEPLOY_KEY`, escopo já é o repositório
  inteiro). `schedule` deslocado 14min do `backup.yml` (`cron: "37 3 * * *"`
  vs. `"23 3 * * *"`), mesmo motivo. Restauração via `pg_restore` puro (sem
  script próprio, ao contrário do Firestore) — ver
  `docs/restore-postgres.md`.
- `backfill-rtdb.yml` — disparo **manual** (`workflow_dispatch` só) de
  `scripts/backfill-rtdb.mjs` (`docs/known-risks.md` item 152 addendum):
  copia `assetStates`/`signalEvents`/`tradeOperations` do Firestore pro RTDB
  uma única vez (itera `RTDB_MIRRORED_ENTITIES`, então uma coleção nova
  entra automaticamente ao ser adicionada lá — nenhuma mudança neste script),
  fechando o "cold start" do mirror ao vivo (uma `TradeOperation` fechada
  nunca mais é escrita, então nunca convergiria sozinha sem isto). Não faz
  parte de nenhum agendamento — rodar antes de religar qualquer leitura do
  painel pro RTDB de novo.
- `count-signals.yml` — diagnóstico **manual** (só `workflow_dispatch`):
  `scripts/count-1h-signals.mjs` conta `SignalEvent` RF por timeframe contra o
  Firestore real, publica no Job Summary. Apoia uma decisão de produto (vale a
  pena destravar o 1h como cascata de entrada? — `docs/known-risks.md` item
  56, "Retomada 2026-08-03"), não é diagnóstico de rotina nem toca nenhuma
  operação.
- `health-audit.yml` — auditoria de saúde: **duas vezes por dia, 04:40 UTC
  (01:40 BRT) e 00:07 UTC (21:07 BRT, item 254)** (`schedule`) +
  `workflow_dispatch`. O relatório e o aviso do Telegram mostram a **origem**
  do erro (`executor` cron/browser + `error_class`), quando o log tem os
  campos. `scripts/health-audit.mjs` responde "o
  que está falhando e ninguém viu?" (`docs/known-risks.md` itens 164/165) —
  erros/avisos agrupados, operações presas, funil de entrada e o estado do
  episódio de cota, tudo no Job Summary. **Avisa no Telegram só quando acha
  algo**; passada limpa é silenciosa, de propósito (um "está tudo bem" diário
  treina o hábito de ignorar o aviso). **Read-only por contrato**: o job FALHA
  se o script escrever no Firestore. Teto explícito de 570 documentos lidos
  (~1% da cota diária).
  **⏰ [Histórico — vale só para a era Firestore; ver item 254] O horário
  04:40 UTC não é arbitrário** — é quando as duas falhas reais
  de cota aconteceram (04/09 04:43 e 05/09 04:36 UTC), ~21h30 dentro do ciclo
  diário que zera às ~07:00 UTC. Rodar de manhã diria "tudo bem" mesmo num dia
  em que a cota estourou de madrugada, que foi como isso passou dois dias
  despercebido.
  **Nenhuma consulta dela pode exigir índice composto** (itens 165/167):
  ordenação SEM filtro (`list('-created_date', N)`) ou igualdade SEM ordenação
  (`filter({campo}, undefined, N)`) — nunca as duas juntas. Ela lê os erros
  **duas vezes de propósito**: a janela recente responde "o que acontece
  agora", e a amostra por nível impede que um erro da madrugada seja expulso
  por log rotineiro (~2.000 `info`/dia contra uma janela de 300). Travado por
  `scripts/healthAuditQueryTripwire.test.js`.
  **Read-only real desde o item 179**: `DATABASE_URL_READONLY` (secret
  opcional, role Postgres com só `GRANT SELECT`, criação manual no Neon) —
  quando presente, o script troca `DATABASE_URL` por ela antes de qualquer
  leitura; sem ela, cai de volta pra `DATABASE_URL` (read-write) e avisa alto
  em todo relatório. Uma tentativa de escrita com a role read-only ativa
  propaga `permission denied` (42501) e derruba o job — o contador
  `reads`/`writes` no rodapé do relatório é só informativo (Postgres não tem
  cota pra contar), a garantia real é o `GRANT` + o re-throw de `42501`.
- `golden-fixture.yml` — congela candles reais da Binance Spot como fixture
  dos golden tests de paridade (`src/lib/indicators/goldenParity.test.js`,
  `.claude/rules/pine-parity.md`) — roda no runner do GitHub porque a rede das
  sessões do Claude Code bloqueia a Binance. Disparo **manual**
  (`workflow_dispatch`, símbolo/timeframes/quantidade configuráveis); o job
  commita os JSONs numa branch própria e **abre um PR sozinho** — os golden
  tests do CI validam os candles reais antes do merge. Fixture é congelada de
  propósito (teste determinístico e offline); não regravar sem motivo.
- `backtest.yml` — disparo **manual** do motor de backtest histórico
  (`src/lib/backtestEngine.js`, ver `docs/claude/backtest-usage.md`) no
  runner do GitHub (alcança a Binance, diferente das sessões do Claude
  Code). Não usa nenhum secret — backend fake em memória, Telegram no-op —
  só baixa candles públicos e sobe o relatório como artifact. Input
  `futures_data` (default `false`) troca a fonte de Spot
  (`data-api.binance.vision`, mesma do cron ao vivo) para Futures USDⓈ-M
  real (`data.binance.vision`, arquivo em lote — `docs/known-risks.md`
  itens 86/122) — só afeta a MEDIÇÃO do backtest, o scan ao vivo continua
  em Spot (item 4, sem solução gratuita). Input `real_funding` (default
  `false`, **exige `futures_data`** — o workflow falha se pedirem só um)
  cobra funding pela taxa REAL publicada, com sinal e por lado, em vez da
  constante `funding_bps` (`scripts/fetch-backtest-funding.mjs`,
  `docs/known-risks.md` item 131). **A janela precisa terminar no fim de um
  mês FECHADO**: a Binance só publica o arquivo mensal de funding depois que
  o mês vira, então pedir até o mês corrente trunca a série — o run recusa em
  vez de medir uma mistura.

- `backtest-random-baseline.yml` — disparo **manual** da referência
  "mesmas saídas, entradas aleatórias" (`docs/known-risks.md` item 264).
  - **Etapas:** um job baixa os candles uma vez; a matriz roda R0 + N seeds
    (`max-parallel` 20); o último job agrega com
    `scripts/random-baseline-summary.mjs`.
  - **Mesma natureza do `backtest.yml`:** sem secret, backend fake e
    Telegram no-op.
  - **Campos:** as datas são obrigatórias, sem padrão vazio (lição do desvio
    do item 263). São no mínimo 39 seeds.
  - **Caixa "Fibonacci 15m"** (`fib_entry`, item 267): liga `fibEntryEnabled` em
    TODOS os braços, R0 incluído. Desmarcada, o comportamento é o do item 264.
  - **Comparação pareada:** `scripts/compare-random-baselines.mjs` compara
    os resumos com e sem a caixa marcada.
  - **Caixa "Tamanho pela volatilidade"** (`vol_sizing`, item 269): não muda
    nenhum braço. Só acrescenta, no job de resumo, `scripts/vol-sizing.mjs`
    sobre os mesmos relatórios, e publica `resumo-vol-sizing-<família>`. Não pode
    ser marcada junto com a Fibonacci.
  - **Caixa "Filtro de tendência diária"** (`daily_filter`, item 273): também não
    muda nenhum braço. Só acrescenta `scripts/daily-filter.mjs` no job de resumo e
    publica `resumo-daily-filter-<família>`. Não pode ser marcada junto com a
    Fibonacci.

- `pattern-lab.yml` — disparo **manual**, sem campos: laboratório de padrões
  (`docs/known-risks.md` item 266).
  - **Download:** baixa de `data.binance.vision` só até o fim pré-registrado
    (`docs/experiments/pattern-lab-prereg.json`).
  - **Análise:** roda `scripts/pattern-lab.mjs` e publica `resumo-pattern-lab`
    (~30 KB).
  - **Sem secret.** O período final fica lacrado, e o dado dele nem é baixado.

- `weekly-trend.yml` — disparo **manual**, sem campos: teste de tendência
  semanal (`docs/known-risks.md` item 268).
  - **Download:** velas diárias Spot até o fim pré-registrado
    (`docs/experiments/weekly-trend-prereg.json`).
  - **Análise:** roda `scripts/weekly-trend.mjs` e publica `resumo-weekly-trend`
    (~6 KB).
  - **Sem secret.**

- `daily-ema-supertrend.yml` — disparo **manual**, sem campos: teste de
  tendência diária EMA 10/21 + Supertrend(10,3) (`docs/known-risks.md` item 271).
  - **Download:** velas diárias Spot até o fim pré-registrado
    (`docs/experiments/daily-ema-supertrend-prereg.json`).
  - **Análise:** roda `scripts/daily-ema-supertrend.mjs` e publica
    `resumo-daily-ema-supertrend`.
  - **Sem secret.** Mesmo molde do `weekly-trend.yml`.

- `daily-ema-supertrend-replication.yml` — disparo **manual**, sem campos:
  replicação pré-registrada do item 271 em 13 moedas novas (`docs/known-risks.md`
  item 272; `docs/experiments/daily-ema-supertrend-replication-prereg.json`).
  - **Depois da replicação:** reexecuta o item 271 só para o descritivo (curva
    composta, trocas e custo de 10/20 bps).
  - **Artifact:** `resumo-daily-ema-supertrend-replicacao`, com os dois JSONs.
  - **Sem secret.**

- `daily-ema-supertrend-forward.yml` — disparo **manual**, sem campos, só a partir de
  **2028-10-17**: a regra diária em tempo novo (`docs/known-risks.md` item 274).
  - **Testes:** compra (acompanhamento) e venda espelhada (teste próprio), cada um com o
    seu pré-registro (`docs/experiments/daily-ema-supertrend-forward*-prereg.json`).
  - **Recusa** rodar antes do fim pré-registrado, de propósito.
  - **Artifact:** `resumo-daily-ema-supertrend-tempo-novo`, com os dois JSONs.
  - **Sem secret.**

- `targets-test.yml` — disparo **manual**, sem campos: teste pré-registrado "só os alvos mudam"
  (`docs/known-risks.md` item 281; `docs/experiments/targets-prereg.json`).
  - **Plano:** lê o pré-registro e monta 3 janelas × (controle + 6 braços) = 21 rodadas.
  - **Download:** uma vez por janela (Spot); a matriz de replays usa esses candles.
  - **Resumo:** `scripts/targets-summary.mjs` aplica o critério (controle reproduzindo o item 270,
    procedência `--target-arm`, Bonferroni m=6) e publica `resumo-targets-test`.
  - **Sem secret.**

- `restore-postgres.yml` — disparo **manual** (`workflow_dispatch`, sem campos): restaura o backup diário
  mais recente (branch `backups-postgres` do repo privado de backups, via `BACKUP_DEPLOY_KEY`) num banco NOVO
  (`docs/known-risks.md` itens 282/283).
  - **Destino:** sempre o secret `RESTORE_DATABASE_URL`, nunca o `DATABASE_URL` vivo; recusa rodar se
    forem iguais **e exige o destino vazio (nenhuma tabela com linha, `users`/`scanner_locks` incluídas) antes de
    qualquer escrita**. Não existe opção de apagar nada
    (achado do Codex no PR #513) — refazer é num projeto novo.
  - **Como restaura:** só os dados (`pg_restore --data-only --single-transaction`), com o schema de
    `db/schema.sql`. Termina com linhas por tabela e tamanho do banco no Job Summary.
  - **TLS:** CA **própria** no secret `RESTORE_DATABASE_SSL_CA` (mapeada para a env `DATABASE_SSL_CA` só
    dentro deste job) — nunca o secret `DATABASE_SSL_CA`, que é do banco vivo (com uma CA setada o driver
    confia só nela). Para o `pg_restore` (libpq, que não lê essa env) a URL é refeita com
    `sslmode=verify-full` + a CA em arquivo (`scripts/restore-postgres-report.mjs --libpq-env`).
  - **Todo workflow que conecta no banco repassa `DATABASE_SSL_CA`** — travado por
    `db/workflowsDatabaseCa.test.js` (exceções explícitas e comentadas lá).
  - **Procedimento completo:** `docs/restore-postgres.md`.

- `daily-rule-report.yml` — relatório diário da regra EMA 10/21 + Supertrend no Telegram
  (`docs/known-risks.md` item 275). Roda às **00:23 UTC** (`schedule`) e também por
  `workflow_dispatch`.
  - **Download:** velas diárias Spot das 19 moedas, uma por vez. Uma falha vira "sem dado" no
    relatório, sem derrubar as outras.
  - **Análise:** `scripts/daily-rule-report.mjs --send` mostra comprado/fora, as trocas do dia e
    o andamento desde 2026-10-17. Só acompanha, não decide.
  - **Fonte única:** regra e moedas vêm do pré-registro de compra do item 274.
  - **Secrets:** só `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`. Nenhuma ordem, nenhum banco,
    `contents: read`.

- `context-probe.yml` — disparo **manual** (`workflow_dispatch` só), sem campos: sonda das fontes do
  Contexto de Mercado (`docs/known-risks.md` itens 284/285, Fase 1).
  - **O que faz:** `scripts/context-probe.mjs` faz 1 requisição por fonte (BLS, Medo e Ganância, RSS do Fed,
    Binance Spot, CORS do `raw.githubusercontent.com` + opcionais) e imprime a tabela no Job Summary. Job
    vermelho = alguma fonte **obrigatória** reprovou o portão da fase.
  - **Regra da fase:** 3 execuções em horários diferentes, 5/5 obrigatórias OK.
  - **Isolamento (travado por `scripts/contextIsolationTripwire.test.js`):** `contents: read`, **sem**
    `DATABASE_URL` (não pode acordar o Neon), sem Telegram, sem Firebase, sem scanner. O motor não importa
    nada de `context*`. Segredo opcional `COINGECKO_API_KEY` (sem ele o `/global` é pulado).
    Segredo opcional `CONTEXT_CONTACT_EMAIL`: vai só no `User-Agent` (o BLS dá 403 sem contato do
    robô); nunca impresso. O calendário dos EUA é o grupo `us-calendar` (BLS `.ics` ou páginas do CPI /
    Employment Situation — qualquer uma serve).
    **Desde 29/10 o BLS segue 403 mesmo com contato** (bloqueia o IP do GitHub): o grupo `us-calendar` também
    aceita a linha `calendario-fixo` (`scripts/contextCalendar.mjs`: `oficial` = BLS/FRED, `confirmada` = 2+ fontes de
    terceiros, senão `a_confirmar` sem alerta). A lista envelhece — a sonda avisa com <60 dias e reprova quando vence
    (item 285, addendum 2).
    Opcionais fora do portão (addendum 3): `financecalendar-*` (sem chave) e `fred-*` (segredo opcional
    `FRED_API_KEY`, sem ele "PULADO"). A chave vai **só na URL da requisição** — resultado/tabela/JSON mostram o
    molde `<FRED_API_KEY>` (travado por teste em `scripts/contextProbe.test.js`).
    Desde a run 5 (addendum 4) o FRED confirmou 4 datas, que viraram `oficial` na lista fixa (`oficial` exige
    URL do BLS ou do FRED). O financecalendar é lido só de `events[]` (limite 2.000/dia sem chave).

- **Orçamento de computação do Neon (item 286, travado por
  `scripts/neonComputeBudget.test.js`):** todo workflow com `schedule:` que
  cita `DATABASE_URL` é descoberto sozinho e somado ao disparo externo
  (`SCAN_CADENCE_MIN`). O modelo (compute dorme após 5 min; 0,25 CU) reproduz o
  estouro real de 5 min (~180 h) e hoje dá ~79 h/mês com 15 min; o teste
  **reprova acima de 85 h**. Ao criar/alterar um agendamento que toca o banco,
  rode `npm test` e confira — cada disparo custa ~6 min de banco acordado.

## Deploy

- **Frontend**: Render Static Site (`render.yaml` `sentinel-signals`), automático
  a cada push em `main`. Não migrar para Vercel/Netlify (decisão do usuário).
- **`server/`**: Render `sentinel-signals-api` (Node). Secrets `sync: false` são
  setados no dashboard do Render, nunca no repo.
- **Firestore rules/índices**: passo **manual** —
  `firebase deploy --only firestore:rules,firestore:indexes` (ou o workflow).
  Plano Spark gratuito, **sem Blaze/Cloud Functions**.

## Regras

- O scan roda `src/lib/scanner.js` sem modificação via esbuild
  (`build-scan.mjs`). Ao mudar imports do scanner, verifique os 4 redirecionamentos
  Node (`adminEntities`/`adminTelegram`/`adminPineConfig`/`adminMarketDataProvider`).
  `scripts/dist/` é gitignored — não commitar.
- Não adicione custo (nada que exija Blaze/cartão) sem pedido explícito.
