# Motor de backtest histórico — como rodar

O Sentinel ganhou um motor de backtest (`src/lib/backtestEngine.js` +
adaptadores em `scripts/backtest*.js`) que roda o **mesmo** `scanAsset`/
`persistScanResults` de `src/lib/scanner.js` — sem modificação nenhuma —
contra candles históricos reais em vez da Binance ao vivo, com um relógio
simulado para que cooldowns/Time Stop/janelas de retry envelheçam
corretamente durante o replay. Serve para validar qualquer ajuste futuro de
qualidade de sinal (score mínimo, filtros de regime, alinhamento
multi-timeframe) com dado real, em vez de achismo — ver
`docs/known-risks.md` item 33 para o porquê disso ser a prioridade antes de
mexer em parâmetros.

Duas formas de rodar — mesmo motor, mesmo resultado:

- **Opção A — sua máquina** (passo a passo abaixo): dois comandos npm, você
  cola o resultado numa sessão do Claude pra analisar junto.
- **Opção B — GitHub Actions** (`.github/workflows/backtest.yml`, disparo
  manual): roda no runner do GitHub, que alcança a Binance — diferente das
  sessões do Claude Code, onde a rede bloqueia (mesma restrição de
  `scripts/fetch-golden-fixture.mjs`, ver `.claude/rules/pine-parity.md`).
  Não usa nenhum secret (backend fake em memória, Telegram no-op) e sobe o
  relatório como artifact do run — sem precisar de Node instalado, e o
  Claude consegue ler o resultado direto pelas ferramentas de GitHub.
  Actions → **"Backtest histórico (Sentinel Signals)"** → *Run workflow* →
  preencha símbolos/período (já vem com defaults) → depois de rodar, veja o
  resumo na aba **Summary** do run ou baixe o artifact `backtest-report`
  para o JSON completo.

## Passo 1 — baixar o histórico real (Opção A, sua máquina)

```bash
node scripts/fetch-backtest-data.mjs \
  --symbols BTCUSDT,ETHUSDT \
  --from 2025-01-01 --to 2026-01-01 \
  --timeframes 1h,4h,1d,15m
```

Baixa da Binance Spot (`data-api.binance.vision` — a mesma fonte do cron
24/7), pagina automaticamente (limite de 1000 candles por chamada da API) e
grava um JSON por símbolo/timeframe em `scripts/__fixtures__/backtest/`
(gitignored — é dado seu, não fixture congelada versionada). Pode demorar
alguns minutos dependendo do intervalo pedido; rode uma vez e reuse o
resultado em vários replays.

Timeframes: inclua sempre `15m` se algum ativo usar a cascata padrão
(4h→15m); inclua `5m` também se algum ativo tiver `smc_enabled` (cascata
1h→5m).

## Passo 2 — rodar o replay (Opção A, sua máquina)

```bash
npm run backtest -- \
  --symbols BTCUSDT,ETHUSDT \
  --from 2025-02-01T00:00:00Z --to 2025-12-01T00:00:00Z \
  --out ./backtest-report.json
```

Isso empacota `scripts/run-backtest.mjs` com esbuild (mesmo padrão de
`npm run scan`/`build-scan.mjs`) e roda o replay. Flags úteis:

- `--data-dir DIR` — se você baixou os dados em outro lugar (default:
  `scripts/__fixtures__/backtest`).
- `--smc BTCUSDT,ETHUSDT` e `--smc-confirm BTCUSDT,ETHUSDT` — **independentes**
  (mesma independência de `asset.smc_enabled`/`asset.smc_confirm_4h15m` no
  app real, ver `MonitoredAsset.jsonc`):
  - `--smc` liga a cascata **paralela** 1h→5m — nunca interfere na 4h/15m.
    Como o relatório já separa por cascata (`report.byCascade['4h_15m']` vs.
    `['1h_5m']`), um único run com `--smc` já compara RF puro contra SMC lado
    a lado, no mesmo período/ativos — não precisa de dois runs.
  - `--smc-confirm` torna a cascata 4h/15m **mais rígida** (exige a estrutura
    SMC do 4h concordar com o sinal) — não precisa de `--smc` junto, e
    `--smc` não liga isso sozinho.
  - Sem nenhuma das duas, todo ativo roda só com a cascata padrão 4h/15m
    Range Filter.
- `--rf-period`/`--rf-multiplier` — sobrescreve os defaults (20/3.5) para
  todos os ativos do replay.
- `--pine-config arquivo.json` — sobrescreve parâmetros do "Pine sincronizado"
  (`minScore`, `tp1R`, `useADX`, etc. — mesmas chaves de
  `scripts/backtestPineConfig.js`/`src/lib/pineParser.js`) sem editar código.
  Exemplo de arquivo: `{"minScore": 80, "useChop": false}`.
- `--step-ms N` — força a cadência do replay (por padrão: 5min se algum
  ativo tiver `smc_enabled`, senão 15min — o suficiente para nunca pular o
  fechamento do timeframe mais fino habilitado).

O console mostra progresso a cada 10% e, no final, o relatório agregado
(geral + por cascata: win rate, profit factor, expectância em R, drawdown —
os mesmos números de `src/lib/tradeMetrics.js` que o painel já usa). O JSON
completo (`--out`) inclui a curva de operações fechadas, para comparar
antes/depois de qualquer mudança de parâmetro.

**`smcDiagnostics`** (no relatório, `report.smcDiagnostics`): quando
`report.byCascade['1h_5m']` vem vazio/zero, isso sozinho não diz **por quê**
— pode ser que nenhuma quebra de estrutura 1h tenha ocorrido no período, ou
que tenha ocorrido e sido descartada pelo gate de zona Premium/Discount
(`docs/known-risks.md` item 35). Esse campo fecha essa lacuna:
`structureEventsTotal` (quantas quebras de estrutura 1h aconteceram no
total), `rejectedByZoneGate` (quantas o gate de zona descartou),
`confirmedSignals` (quantas viraram `SignalEvent`), `tradeOpsCreated`
(quantas viraram `TradeOperation` de verdade — pode ser menor que
`confirmedSignals` se a confirmação 5m não bater). Se `structureEventsTotal`
for 0, é o `swingLen=50` sendo deliberadamente raro (item 34); se for > 0
mas `confirmedSignals` for 0, é o gate de zona rejeitando tudo — dois
diagnósticos diferentes que pareciam a mesma coisa ("0 operações SMC")
antes desse campo existir.

## O que o replay NÃO cobre (por design, não é lacuna)

- **Preço em tempo real (`priceCheckActiveOps`)** — não há dado de tick num
  backtest só de candle. As saídas usam o high/low de cada candle fechado
  (`persistScanResults`), que é uma aproximação **conservadora** do preço ao
  vivo (pior caso do range da barra) — isso só pode fazer o win rate
  replayado parecer **pior** que ao vivo, nunca melhor/inflado.
- **Notificações Telegram** — desligadas (`scripts/backtestTelegram.js` é
  no-op) para não gerar spam/rate-limit reprocessando meses de sinais de
  uma vez.
- **Página nova no painel para o relatório** — os componentes existentes que
  consomem `summarizeOps` leem do Firestore real; reusá-los aqui exigiria
  poluir produção com dado de replay ou construir um segundo caminho
  local-só-pra-isso. Fica como pedido futuro separado se for necessário.
