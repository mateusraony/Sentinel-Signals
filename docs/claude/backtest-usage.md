# Motor de backtest histórico — como rodar (só na sua máquina)

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

**Só roda na sua máquina.** A rede das sessões deste projeto bloqueia a
Binance (mesma restrição de `scripts/fetch-golden-fixture.mjs`, ver
`.claude/rules/pine-parity.md`) — nenhum passo abaixo funciona dentro de uma
sessão do Claude.

## Passo 1 — baixar o histórico real

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

## Passo 2 — rodar o replay

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
- `--smc BTCUSDT,ETHUSDT` — ativa a cascata SMC (`smc_enabled` +
  `smc_confirm_4h15m`) para os símbolos listados; sem essa flag, todo ativo
  roda só com a cascata padrão 4h/15m Range Filter.
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
