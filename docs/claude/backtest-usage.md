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

**`report.runner`** (`docs/known-risks.md` item 46) —
`{enabled, opsWithRunner, opsFullyClosedAtTp1, closedByTp1Full}`. Diferente das
seções acima, registra **qual gestão de saída o run usou**, não um gate de
entrada — e é inferido das próprias operações (`partial_percent`), não do
`pineConfig`, então reflete a gestão de fato aplicada mesmo se o flag mudou no
meio. Serve para impedir o erro de comparar dois relatórios sem notar que a
SAÍDA mudou entre eles, o que atribuiria à estratégia uma diferença que veio da
gestão.

**Quanto o runner rendeu não está aqui, de propósito** — está no diagnóstico,
que roda sobre qualquer relatório **sem backtest novo**:

```bash
npm run analyze-backtest -- --report ./report.json
# seção "O RUNNER PAGOU? — resultado real vs. fechar 100% no TP1"
```

Ele compara a expectância bruta real contra a que teria saído fechando 100% no
TP1, **bruto contra bruto** (o cenário TP1 não tem custo calculável, então
descontar de um lado só enviesaria em ~0,045 R). Sem look-ahead: só entram
operações que comprovadamente atingiram o TP1.

Para testar o flag em si (default é `true` = comportamento de sempre):

```bash
echo '{"runnerEnabled": false}' > /tmp/no-runner.json
npm run backtest -- --symbols BTCUSDT,ETHUSDT \
  --from 2025-02-01T00:00:00Z --to 2025-12-01T00:00:00Z \
  --pine-config /tmp/no-runner.json --out ./report-no-runner.json
```

A expectância líquida deve subir aproximadamente o valor que o diagnóstico
atribuiu ao runner na rodada com ele ligado. Muito mais que isso indica erro no
gate, não vantagem descoberta.

**`report.costs`** (Fase 5, `docs/known-risks.md` item 44) —
`{model, avgCostR, totalCostPct, grossExpectancyR, netExpectancyR, conclusive,
inconclusiveReason, expectancyRCI95, countedTrades, minTrades}`. **Taxa,
slippage e funding são descontados POR PADRÃO** (diferente de todas as outras
seções, que são opt-in): esta fase não adicionou um mecanismo, corrigiu uma
medição que estava otimista.

**A linha que decide é `avgCostR`** — o custo expresso em múltiplos do risco,
comparável direto com `netExpectancyR`. Exemplo concreto: taxa taker de 0,05%
por lado dá 10 bps de ida e volta; com stop a 0,5% do preço de entrada isso é
**0,20 R por operação**. Uma configuração com expectância de +0,15 R é, na
prática, negativa. Se `avgCostR` for da mesma ordem que `netExpectancyR`, a
"vantagem" era só ausência de custo.

Para medir quanto o custo comeu, rode o A/B:

```bash
npm run backtest -- --symbols BTCUSDT --from 2025-02-01T00:00:00Z \
  --to 2025-12-01T00:00:00Z --out ./report-com-custo.json

npm run backtest -- --symbols BTCUSDT --from 2025-02-01T00:00:00Z \
  --to 2025-12-01T00:00:00Z --no-costs --out ./report-sem-custo.json
```

`--no-costs` reproduz **exatamente** os números de antes da Fase 5 — é a
referência para ver o delta. Outras flags: `--fee-bps N` (default 5 = 0,05%
taker), `--slippage-bps N` (default 1), `--funding-bps N` (default 1, por
janela de 8h), `--min-trades N` (default 30), `--trial-label TXT` (gravado no
JSON — serve para você contar quantas configurações já testou).

As mesmas seis flags existem como campos do formulário na **Opção B**
(`backtest.yml` → *Run workflow*), com os mesmos defaults: deixar em branco usa
o default, e o `no_costs` é uma caixa de seleção. O resumo do run imprime o
veredito (INCONCLUSIVO ou "amostra suficiente") **antes** de qualquer win rate,
pelo mesmo motivo do aviso abaixo.

**⚠️ `conclusive: false` significa que o relatório não sustenta conclusão
nenhuma** — o CLI imprime **RESULTADO INCONCLUSIVO** em destaque. Isso conserta
o problema real do processo: um backtest com 3 operações produz win rate e
profit factor de aparência perfeitamente normal, e é exatamente aí que uma
decisão errada nasce.

`minTrades = 30` é **só** o limiar do Teorema Central do Limite (quando um
intervalo de confiança *pode* ser calculado), **não** quando ele fica estreito
o bastante para decidir. Quantas operações são realmente necessárias, por
expectância real:

| Expectância | Operações (80% de poder, 5%) |
|---|---|
| 0,50 R | ~45 |
| 0,25 R | ~181 |
| 0,10 R | ~1.130 |

**Regra de ordem, herdada da literatura de overfitting** (Bajgrowicz &
Scaillet, JFE 2012): **congele os custos antes de calibrar qualquer
parâmetro**. Calibrar a custo zero e recalibrar depois dobra a contagem de
tentativas e contamina a segunda busca. Na prática: os pesos de OB/FVG da
Fase 4 só devem ser calibrados com o custo já ligado — que é o default.

## Passo 3 — diagnosticar de ONDE vem o resultado

```bash
npm run analyze-backtest -- --report ./backtest-report.json
```

Lê um relatório já gerado e o decompõe — **sem rodar replay nenhum e sem
tocar em parâmetro**, então não consome nenhuma "tentativa" no sentido de
overfitting. Quatro saídas:

1. **Por motivo de saída** (`STOP_HIT`, `TP2_HIT`, `INVALIDATED`,
   `CLOSED:TIME_STOP`, `CLOSED:CHOP_EXIT`).
2. **Por símbolo**.
3. **Estabilidade no tempo** — contribuição por trimestre, em ordem
   **cronológica** (é a única tabela que não sai ordenada por contribuição:
   aqui a sequência é a informação — degradação, concentração num período, ou
   estabilidade). Mais `positivePeriodsShare`: resultado que vem de um
   trimestre bom não é estratégia, é sorte datada.
4. **Composição do custo** — taxa vs slippage vs funding, em R, mais quantas
   fronteiras de 8h cada operação atravessou. Atravessar a fronteira e pagar
   funding são coisas separadas na saída: num run `--no-costs` a contagem de
   fronteiras continua sendo mostrada (é telemetria de duração, o número por
   trás da hipótese "o funding domina o custo"), mas nenhuma operação aparece
   como tendo pago.
5. **Tempo em posição** — média, mediana, mínimo, máximo.

A coluna que importa é **`contrib R`**: quantos R da expectância final vieram
daquele balde. As linhas somam **exatamente** a expectância geral, porque
todas usam o mesmo denominador (o total de operações com R). Isso é diferente
de comparar médias entre grupos: um balde de 3 operações com média −2 R
parece catastrófico e contribui menos que um balde de 60 operações com média
−0,1 R. A tabela sai ordenada da pior contribuição para a melhor, então a
primeira linha é literalmente a fonte do prejuízo.

**Por que isso vem antes de testar flags.** Cada gate opcional (`retestEnabled`,
`displacementEnabled`, `smcTierEnabled`, `smcObFvgEnabled`) é um filtro: corta
a amostra e alarga o intervalo de confiança. São 4 flags, ou seja 16
combinações — e com `sd(R) ≈ 1,1` e ~55 operações após um filtro, o **máximo
de 16 tentativas inúteis ainda é esperado em torno de +0,2 R**, só por sorte.
Um filtro também não cria vantagem, só concentra a que já existe. O
diagnóstico é o que diz se existe algo concentrado para filtrar — e, quando
diz, aponta a alavanca certa, que frequentemente **não** é um filtro de
entrada:

| Se o prejuízo se concentra em… | A alavanca é |
|---|---|
| `CLOSED:TIME_STOP` | a regra de **saída** (prazo, trailing), não a entrada |
| 1-2 símbolos | **quais ativos** são monitorados |
| funding (fatia alta do custo) | **quanto tempo** a posição fica aberta |
| nada — espalhado por igual | aí sim a entrada, e o A/B de flags fica justificado |

`--json` imprime a mesma análise como JSON, para diffar dois relatórios.
Precisa do **JSON completo** (o `--out` local ou o artifact `backtest-report`
do run) — o resumo publicado na aba Summary remove `overall.curve`, que é
onde cada operação vive. Na **Opção B** isso já vem pronto: o workflow publica
o diagnóstico no próprio job, na seção "Diagnóstico — de onde vem o
resultado", sem precisar baixar nada.

## O que o replay NÃO cobre (por design, não é lacuna)

- **Preço em tempo real (`priceCheckActiveOps`)** — não há dado de tick num
  backtest só de candle. As saídas usam o high/low de cada candle fechado
  (`persistScanResults`), que é uma aproximação **conservadora** do preço ao
  vivo (pior caso do range da barra) — **essa aproximação específica** só pode
  fazer o win rate replayado parecer pior que ao vivo, nunca melhor.
  ⚠️ **Correção (Fase 5, known-risks item 44)**: esta frase já esteve escrita
  aqui como se valesse para o replay INTEIRO. Era falsa. Até a Fase 5 o replay
  não descontava taxa/slippage/funding, o que empurra na direção oposta —
  inflava o resultado. Custos agora são descontados por padrão; ver
  `report.costs` abaixo.
- **Notificações Telegram** — desligadas (`scripts/backtestTelegram.js` é
  no-op) para não gerar spam/rate-limit reprocessando meses de sinais de
  uma vez.
- **Página nova no painel para o relatório** — os componentes existentes que
  consomem `summarizeOps` leem do Firestore real; reusá-los aqui exigiria
  poluir produção com dado de replay ou construir um segundo caminho
  local-só-pra-isso. Fica como pedido futuro separado se for necessário.
