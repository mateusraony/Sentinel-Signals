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
- `scan.yml` — `npm run scan`. **Relógio de
  trading**: o cadenciamento real de
  ~5min vem de disparo **externo** (cron-job.org via `workflow_dispatch`,
  configurado e confirmado — ver `docs/claude/external-cron-setup.md`,
  configuração fora do repo, PAT pessoal do usuário); o `schedule:` interno
  (`cron: "7 * * * *"`) é só um **fallback horário** — GitHub desativa
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
  própria de 1x/hora (`workflow_dispatch` também disponível) — ativo novo é
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
- `scan-shadow.yml` — braço decisório do modo sombra prospectivo (Fase 1, RF
  1h condicionado ao 4h, `docs/known-risks.md` item 56): roda `npm run
  scan:shadow`, declarado a cada hora (`cron: "41 * * * *"`, reduzido de
  15min→30min — item 106/107 — e depois de 30min→60min — item 148, achado
  2 — sempre por folga de cota do Firestore compartilhado com a produção).
  **A cadência REAL diverge da declarada** — GitHub despriorizando o
  `schedule:` interno deste workflow sob a carga do `scan.yml` (item 134,
  confirmado de novo no item 148: ~5,6 passadas/dia reais em vez das ~48
  que 30min prometia) — então o ganho do aperto 30min→60min é incerto, não
  garantido. Escreve só em coleções Firestore isoladas
  (`experimentalRf1hShadow*`), nunca abre operação real nem notifica
  Telegram.
- `analyze-shadow.yml` — relatório **só leitura** do acúmulo do modo sombra
  acima: `npm run analyze-shadow-rf1h` 1x/dia (+ `workflow_dispatch` manual),
  publica no Job Summary (humano) e em JSON no log do job (leitura
  programática). Mesmo secret de `scan-shadow.yml`, nunca escreve nada.
- `keep-warm.yml` — ping `/health` a cada 10 min (Render free não hibernar).
- `backup.yml` — backup diário das coleções de negócio → branch `backups`.
- `deploy-firestore.yml` — deploy **manual** de rules/índices.
- `backfill-rtdb.yml` — disparo **manual** (`workflow_dispatch` só) de
  `scripts/backfill-rtdb.mjs` (`docs/known-risks.md` item 152 addendum):
  copia `assetStates`/`tradeOperations` do Firestore pro RTDB uma única vez,
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
- `health-audit.yml` — diagnóstico **manual** (só `workflow_dispatch`):
  `scripts/health-audit.mjs` responde "o que está falhando e ninguém viu?"
  (`docs/known-risks.md` item 164) — erros/avisos agrupados, operações presas,
  funil de entrada e o estado do episódio de cota, tudo no Job Summary.
  **Read-only por contrato**: o job FALHA se o script escrever qualquer coisa.
  Teto explícito de 520 documentos lidos (~1% da cota diária) — uma auditoria
  que varresse coleções para diagnosticar falta de cota seria o remédio
  virando a doença. **⏰ Rode entre 03:00 e 06:00 UTC**: a cota zera ~07:00
  UTC, então um relatório logo após o reset dirá "tudo bem" mesmo num dia em
  que ela estourou de madrugada — foi assim que as falhas reais de 04/09 e
  05/09 passaram dois dias despercebidas.
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
