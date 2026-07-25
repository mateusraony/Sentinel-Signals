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
que o gatilho de entrada 5m nunca tenha confirmado. Esse campo fecha essa
lacuna: `structureEventsTotal` (quantas quebras de estrutura 1h aconteceram
— idêntico a `confirmedSignals` desde o item 38: toda quebra 1h sempre vira
`SignalEvent`, sem gate nenhum entre os dois), `confirmedSignals` (quantas
viraram `SignalEvent`), `rejectedByOteZone` (amostra — só a primeira
avaliação de cada sinal no gatilho 5m, não o volume exaustivo de retries;
ver item 38 para o porquê), `tradeOpsCreated` (quantas viraram
`TradeOperation` de verdade — pode ser menor que `confirmedSignals` se o
gatilho 5m nunca confirmar dentro da janela de retry, seja por falta de
sweep/estrutura 5m ou pela zona da perna ainda desfavorável). Se
`structureEventsTotal` for 0, é o `swingLen=50` sendo deliberadamente raro
(item 34); `rejectedByOteZone > 0` mostra que o novo gate de zona (item 38,
medido contra a perna do rompimento, não mais contra o candle de viés 1h)
está de fato filtrando algumas entradas — esperado por design, diferente do
item 35 (gate antigo rejeitava praticamente tudo por tautologia geométrica).

**`report.retest`** (Fase 2 rodada 1, `docs/known-risks.md` item 40) —
`{enabled, total, confirmed, pending, avgBarsToConfirm, byCascade}`. O
gatilho de reteste nasce **desligado** (`retestEnabled: false`); antes de
ativá-lo, compare dois runs do MESMO período/ativos:

```bash
echo '{"retestEnabled": false}' > /tmp/no-retest.json
npm run backtest -- --symbols BTCUSDT,ETHUSDT --from 2025-02-01T00:00:00Z \
  --to 2025-12-01T00:00:00Z --pine-config /tmp/no-retest.json \
  --out ./report-sem-reteste.json

echo '{"retestEnabled": true, "retestToleranceAtrMult": 0.3, "retestTouchMode": "close"}' > /tmp/with-retest.json
npm run backtest -- --symbols BTCUSDT,ETHUSDT --from 2025-02-01T00:00:00Z \
  --to 2025-12-01T00:00:00Z --pine-config /tmp/with-retest.json \
  --out ./report-com-reteste.json
```

Compare `report.retest` (com o flag ligado, `enabled:true`; desligado,
`enabled:false, total:0` — nada é avaliado) e principalmente as métricas de
`byCascade`/`overall` (win rate, profit factor, expectância em R) entre os
dois arquivos — essa comparação é o critério real para decidir ativar, não
uma suposição. `avgBarsToConfirm` (só sobre sinais que retestaram) é o dado a
olhar para calibrar `retestToleranceAtrMult`/o quanto vale a pena esperar,
antes de mudar os defaults.

**`report.displacement`** (Fase 2 rodada 2, `docs/known-risks.md` item 41) —
`{enabled, total, confirmed, pending, avgBodyRatio, byCascade}`, só cascata
SMC (`1h_5m`). Mesma receita de comparação do reteste acima:

```bash
echo '{"displacementEnabled": false}' > /tmp/no-displacement.json
npm run backtest -- --symbols BTCUSDT,ETHUSDT --smc BTCUSDT,ETHUSDT \
  --from 2025-02-01T00:00:00Z --to 2025-12-01T00:00:00Z \
  --pine-config /tmp/no-displacement.json --out ./report-sem-deslocamento.json

echo '{"displacementEnabled": true, "displacementBodyAtrMult": 1.5, "displacementMinVolumeRatio": null}' > /tmp/with-displacement.json
npm run backtest -- --symbols BTCUSDT,ETHUSDT --smc BTCUSDT,ETHUSDT \
  --from 2025-02-01T00:00:00Z --to 2025-12-01T00:00:00Z \
  --pine-config /tmp/with-displacement.json --out ./report-com-deslocamento.json
```

`--smc` é obrigatório nos dois runs (o gate só existe na cascata SMC — sem
ela ligada, `report.byCascade['1h_5m']` já vem vazio e a comparação não diz
nada). Compare `report.displacement` e `report.byCascade['1h_5m']` (win
rate/profit factor/expectância) entre os dois arquivos. `avgBodyRatio` (só
sobre entradas confirmadas) é o dado para calibrar
`displacementBodyAtrMult`; para testar a exigência opcional de volume, rode
uma terceira vez com `displacementMinVolumeRatio` definido (ex.: `1.2`) e
compare contra a rodada sem volume.

**`report.smcRegime`** (Fase 3, `docs/known-risks.md` item 42) —
`{enabled, total, passed, rejected, byReason}`, só cascata SMC (`1h_5m`).
Mesma receita de comparação das duas rodadas de Fase 2 acima:

```bash
echo '{"smcTierEnabled": false}' > /tmp/no-smc-tier.json
npm run backtest -- --symbols BTCUSDT,ETHUSDT --smc BTCUSDT,ETHUSDT \
  --from 2025-02-01T00:00:00Z --to 2025-12-01T00:00:00Z \
  --pine-config /tmp/no-smc-tier.json --out ./report-sem-tier-smc.json

echo '{"smcTierEnabled": true}' > /tmp/with-smc-tier.json
npm run backtest -- --symbols BTCUSDT,ETHUSDT --smc BTCUSDT,ETHUSDT \
  --from 2025-02-01T00:00:00Z --to 2025-12-01T00:00:00Z \
  --pine-config /tmp/with-smc-tier.json --out ./report-com-tier-smc.json
```

`--smc` é obrigatório nos dois runs, mesma razão do displacement acima.
Compare `report.smcRegime` e `report.byCascade['1h_5m']` (win rate/profit
factor/expectância) entre os dois arquivos. `byReason` (`adx_weak`/`choppy`/
`adx_and_chop`) mostra qual sub-gate está de fato rejeitando entradas — útil
pra decidir se vale a pena também desligar `useADX`/`useChop` (toggles
globais, afetam as duas cascatas) em vez de `smcTierEnabled` inteiro. Se
`useChopExit` também estiver ligado, observe `report.byCascade['1h_5m']`
por `closed_reason` — o Chop Exit passa a valer pra operações SMC junto
(efeito colateral documentado no item 42, não um bug).

**`report.smcObFvg`** (Fase 4, `docs/known-risks.md` item 43) —
`{enabled, total, obActive, fvgActive, both, neither}`, só cascata SMC
(`1h_5m`), medido no momento da EMISSÃO do sinal. **Este relatório é o único
efeito observável de ligar `smcObFvgEnabled`** — com os pesos de score no
default (0), o score sai numericamente idêntico ao de antes da Fase 4, de
propósito (ativação em dois estágios, ver item 43).

```bash
echo '{"smcObFvgEnabled": true}' > /tmp/with-obfvg.json
npm run backtest -- --symbols BTCUSDT,ETHUSDT --smc BTCUSDT,ETHUSDT \
  --from 2025-02-01T00:00:00Z --to 2025-12-01T00:00:00Z \
  --pine-config /tmp/with-obfvg.json --out ./report-obfvg.json
```

Uma rodada só já responde a pergunta do estágio 1: **de quantos sinais SMC o
OB/FVG estava a favor?** Se `obActive`/`fvgActive` forem ~0% ou ~100% do
`total`, o componente não discrimina nada e não vale peso. Se ficar num meio
termo, aí sim compensa o estágio 2 — rodar de novo com
`smcScoreObWeight`/`smcScoreFvgWeight` > 0 (redistribuindo os outros pesos pra
continuar somando 100) e comparar win rate/profit factor/expectância de
`report.byCascade['1h_5m']` contra a rodada de peso 0.

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
