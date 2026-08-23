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
- `scan.yml` — `npm run scan`. **Relógio de trading**: o cadenciamento real de
  ~5min vem de disparo **externo** (cron-job.org via `workflow_dispatch`,
  configurado e confirmado — ver `docs/claude/external-cron-setup.md`,
  configuração fora do repo, PAT pessoal do usuário); o `schedule:` interno
  (`cron: "7 * * * *"`) é só um **fallback horário** — GitHub desativa
  `schedule` após ~60 dias sem push, mitigado pelo watchdog externo
  `HEALTHCHECKS_PING_URL` (known-risks 12). Atraso sob carga do `schedule` do
  GitHub Actions em geral, e a medição real feita neste projeto antes do
  disparo externo: known-risks **item 18**.
- `scan-shadow.yml` — braço decisório do modo sombra prospectivo (Fase 1, RF
  1h condicionado ao 4h, `docs/known-risks.md` item 56): roda `npm run
  scan:shadow` a cada 30min (reduzido de 15min — item 106/107, folga de cota
  do Firestore compartilhado com a produção), escreve só em coleções
  Firestore isoladas (`experimentalRf1hShadow*`), nunca abre operação real
  nem notifica Telegram.
- `analyze-shadow.yml` — relatório **só leitura** do acúmulo do modo sombra
  acima: `npm run analyze-shadow-rf1h` 1x/dia (+ `workflow_dispatch` manual),
  publica no Job Summary (humano) e em JSON no log do job (leitura
  programática). Mesmo secret de `scan-shadow.yml`, nunca escreve nada.
- `keep-warm.yml` — ping `/health` a cada 10 min (Render free não hibernar).
- `backup.yml` — backup diário das coleções de negócio → branch `backups`.
- `deploy-firestore.yml` — deploy **manual** de rules/índices.
- `backtest.yml` — disparo **manual** do motor de backtest histórico
  (`src/lib/backtestEngine.js`, ver `docs/claude/backtest-usage.md`) no
  runner do GitHub (alcança a Binance, diferente das sessões do Claude
  Code). Não usa nenhum secret — backend fake em memória, Telegram no-op —
  só baixa candles públicos e sobe o relatório como artifact. Input
  `futures_data` (default `false`) troca a fonte de Spot
  (`data-api.binance.vision`, mesma do cron ao vivo) para Futures USDⓈ-M
  real (`data.binance.vision`, arquivo em lote — `docs/known-risks.md`
  itens 86/122) — só afeta a MEDIÇÃO do backtest, o scan ao vivo continua
  em Spot (item 4, sem solução gratuita).

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
