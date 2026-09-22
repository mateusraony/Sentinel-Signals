# Auditoria em cadeia do motor — dados → indicador → ... → experimentos

Mapa de referência de como o motor de trading do Sentinel decide abrir,
gerir e fechar uma operação hoje, e o que já está medido em cada elo da
cadeia — não um log cronológico (isso é `docs/known-risks.md`, 185 itens em
2026-09-22) nem uma lista de pendências (isso é `docs/roadmap.md`). Este
documento **referencia** o item de `known-risks.md` correspondente em vez de
repetir o texto; quando esse item diverge deste documento, `known-risks.md`
é a fonte de verdade (é o log; isto é o mapa).

Escrito em 2026-09-22, lendo o código atual (não memória). Pedido pelo
usuário: uma auditoria completa dados→indicador→sinal bruto→score→
arbitragem→confirmação→abertura→gestão→TP/stop/trailing→custos/funding→
fechamento→métricas→backtest→OOS→experimentos, para alimentar um conselho
sobre o próximo passo (ver a conclusão registrada em `docs/known-risks.md`
item 186).

## Visão geral do fluxo

```
Binance (Spot/Futures) → indicadores (RF/RSI/MACD/EMA/ATR/ADX/Chop/SMC)
  → sinal bruto + score de confluência → arbitragem (se já há op ativa)
  → confirmação (15m RF / 5m SMC + gates opcionais)
  → abertura (createTradeOpIfNoneActive, CAS transacional)
  → gestão (HOLDING/PROTECTED, decision snapshot)
  → TP1/TP2/stop/trailing → fechamento (transitionTradeOp)
  → custos (fee/slippage/funding) → métricas (summarizeOps, IC95)
  → backtest (mesmo motor, candles históricos) → correção estatística
    (cluster/DEFF/Bonferroni) → experimentos (modo sombra, Bloco 1)
```

`src/lib/scanner.js` (4669 linhas) roda **idêntico** no navegador e no cron
(GitHub Actions, via `scripts/build-scan.mjs`) — dois loops mutam
`TradeOperation`: `persistScanResults` (baseado em indicador/candle fechado,
`scanner.js:1841-4252`) e `priceCheckActiveOpsInner` (baseado em preço em
tempo real, `scanner.js:4402-4541`). Backend real desde 2026-09-12: Postgres/
Neon via `sentinel-signals-api` (ver nota no fim deste documento).

---

## 1. Dados

- **Cron (produção 24/7)**: Binance **Spot**, `data-api.binance.vision`
  (`scripts/adminMarketDataProvider.js`). Futures dá 451 em datacenter dos
  EUA — sem workaround gratuito, aceito como limitação permanente
  (`docs/known-risks.md` item 4).
- **Navegador (quando a aba está aberta)**: Binance **Futures**,
  `fapi.binance.com` (`src/lib/marketDataProvider.js`) — dois "escritores"
  reais de produção, um Spot (cron) e um Futures (painel), sem instrumentação
  de qual criou cada operação (item 4 addendum, item 125 achado 4).
- **Backfill retroativo** (ao adicionar/reativar ativo): 3º provedor,
  `scripts/backfillMarketDataProvider.js`, janela de 60 dias (item 137).
- **Backtest**: `scripts/fetch-backtest-data.mjs` (Spot, arquivo em lote) ou
  `scripts/fetch-backtest-data-futures.mjs` (Futures via `data.binance.vision`
  — serviço diferente do `fapi`, não bloqueado — item 86/122). Medido: Spot e
  Futures são estatisticamente indistinguíveis no resultado agregado (item
  123/124) — a divergência é de regime de mercado, não de fonte de dado.
- **Retry**: `src/lib/httpRetry.js` (`fetchWithRetry`) — backoff exponencial,
  respeita `Retry-After`. Causa raiz real de um período de baixo volume de
  operações ao vivo antes de existir (item 57).
- **Confiabilidade recente**: bug de `Proxy` em `httpRetry.js` quebrava toda
  leitura de `.ok`/`.status`/`.headers` no navegador real, causando "SEM
  COTAÇÃO" — corrigido (item 184, 2026-09-19).

## 2. Indicadores

Todos em `src/lib/indicators/`, portados do Pine real do usuário (ver
`.claude/rules/pine-parity.md` para o método de validação — golden tests
série×prefixo + referência cruzada + CSV opcional do TradingView).

| Indicador | Arquivo:linha (função central) | Fórmula-chave |
|---|---|---|
| Range Filter | `rangeFilter.js:24` `calculateRangeFilter` | EMA dupla do `abs(close-close[1])` × multiplicador → banda/filtro/direção (linhas 44-91) |
| Confirmação 15m | `rangeFilterConfirmation.js:31` `calculateConfirmedSignal` | Porta `ta.barssince` + follow-through nas últimas `confirmBars` velas |
| RSI | `rsi.js:10` `calculateRSI` | Wilder clássico, seed=SMA, cruzamento de 50 (`crossedBull50/Bear50`) alimenta o score |
| MACD | `macd.js:12` `calculateMACD` | `EMA(fast)-EMA(slow)`, `signal=EMA(macd,9)`, histograma |
| EMA | `movingAverages.js:9/53` `calculateEMAs`/`ema` | EMA recursiva clássica, seed = 1º valor |
| ATR | `atr.js:25/46` | RMA (Wilder) do True Range |
| ADX | `adx.js:24` `calculateADX` | `+DI`/`-DI` via RMA, `DX`, `ADX=RMA(DX)` |
| Choppiness | `choppiness.js:8` | `100·log10(ΣTR/(max-min))/log10(length)`, fallback 50 |
| Tier (regime) | `tier.js:22/49` | ATR% suavizado (SMA20) classifica T1/T2/T3 → stop mult/ADX mín/Chop máx/Time Stop por tier |
| SMC/ICT | `smcStructure.js:64/189/217/278` | BOS/CHoCH via swings, liquidity sweep, PD zone (premium/discount/equilibrium), perna OTE |

Gates opcionais (todos **desligados por padrão**, `pineParser.js` DEFAULTS,
exceto onde indicado — nenhum ativado sem medição prévia, ver seção 14):

- `retest.js:15` — reteste do nível rompido (item 40).
- `displacement.js:19` — candle de deslocamento, só cascata SMC (item 41).
- `candlePatterns.js:25/74/114` — engolfo/pin bar/marubozu, só cascata RF (item 58).
- `orderBlock.js:48` — aproximação geométrica **deliberada** (Pine real usa
  perfil de volume inacessível), só cascata SMC (item 43).
- `fvg.js:48` — porte fiel, só cascata SMC (item 43).

## 3. Sinal bruto / Score de confluência

Dois scores independentes, **nunca combinados**:

- **RF** — `confluence.js:105` `calculateSignalStrength`. Soma 100: 25 pts
  follow-through, 20 MACD, 20 EMA trend, 15 RSI cruzou 50, 10 volume>média,
  10 close vs filtro. `passed = score >= minScore` (default 75), exceto
  `rsiOnlyGateEnabled` (item 111, testado e **não promovido** — não
  significativo).
- **SMC** — `smcConfluence.js:60`. Soma 100 nos 7 componentes originais
  (estrutura 15, CHoCH bônus 10, EMA 20, RF 1h 15, volume 15, alinhamento MTF
  15, sweep 10) + OB/FVG a peso 0 por padrão (item 43). **Advisory only**
  (comentário explícito no arquivo) — nunca é gate de emissão do sinal SMC,
  só alimenta arbitragem/auditoria. A cascata SMC (1h→5m) mede ~0 operações
  reais na prática — 93% das rejeições nunca chegam a avaliar o próprio
  gatilho (item 75).

Sincronização: `pineParser.js:21` (`DEFAULTS`) + `pineParser.js:312`
(`SYNCED_STRATEGY_KEYS`, espelhado em `scripts/adminPineConfig.js` — **ao
adicionar parâmetro sincronizado, os dois arquivos precisam mudar juntos**).
`getPineConfig()` (`pineParser.js:408`) monta a config final: DEFAULTS →
localStorage → `StrategyConfig` (Postgres, ex-Firestore).

## 4. Arbitragem entre cascatas

`src/lib/signalArbitration.js` (211 linhas, puro) + `scanner.js:1175`
`handleActiveOpArbitration`. Decide o que fazer quando um sinal candidato
chega com outra cascata já ativa no mesmo ativo — **nunca abre uma segunda
operação**, só ajusta a gestão da já ativa (promoção em dois estágios
`PENDING_15M`→`CONFIRMED`/`EXPIRED`, reforço, redução de confiança,
invalidação opt-in). Matriz de decisão em `planSignalArbitration`
(`signalArbitration.js:95-211`), classificada por direção (mesma/oposta) ×
relação de timeframe (maior/menor/igual). `ARBITRATION_VERSION=2` (item 93).
7 problemas corrigidos após auditoria externa do PR #78 (item 39).

## 5. Confirmação de entrada

Funil de gates, na ordem real (`scanner.js:3060-3149`, cascata nativa
`4h_15m` como referência — as outras 3 cascatas repetem o mesmo padrão):
`buyRegimeFilterEnabled` (item 100, opt-in) → `trend_reversed` → regime ADX+
Chop (`evaluateRegime`, `scanner.js:301`) → padrão de vela (opt-in) →
`smc_confirm_4h15m` (**desligado em produção**, item 108 — zerava a cascata
inteira) → reteste (opt-in, item 40) → confirmação 15m (`check15mConfirmation`,
`scanner.js:552`, ou bypass via `skip15mConfirmationEnabled` — **ligado em
produção desde item 121**, fidelidade ao Pine real, não por significância
estatística) → `passesRiskReward` (`opExitRules.js:283`, gate matemático
que hoje nunca rejeita um candidato real — honestidade documentada no
próprio código, item citado na função).

Cascata SMC usa `check5mSmcConfirmation` (`scanner.js:658`) no lugar da
confirmação 15m — gatilho 5m sobre sweep/estrutura, medido contra a perna do
próprio rompimento (`buildOteLeg`), não contra o candle de viés 1h (correção
de tautologia geométrica, item 38).

Instrumentação: `SignalEvent.last_rejection_reason` (write-on-change, item
163) + `decision_snapshot` (Explainability V2, itens 181-183 — ver seção 7).

## 6. Abertura

`buildTradeOpData`/`buildSmcTradeOpData` (`scanner.js:356`/`1003`) montam o
payload → `createTradeOpIfNoneActiveCapped` (`scanner.js:2076`, wrapper que
aplica o teto de exposição por lado — `maxConcurrentSameSideOps`,
backtest-only, item 133) → `backend.tradeOps.createTradeOpIfNoneActive`
(`src/api/entities.js:87`, hoje uma chamada HTTP para
`/api/trade-ops/create-if-none-active`).

Decisão pura compartilhada: `planTradeOpCreation` (Firestore-era,
`opTransition.js:119`) / `planTradeOpCreationSql` (Postgres,
`opTransition.js:169`) — desde o cutover, **1 operação ativa por ativo** é
garantida por um **índice único parcial** no Postgres
(`trade_operations_active_anchor_uq`), não mais pelo doc-âncora
`assetActiveOps` do Firestore (`.claude/rules/firestore-concurrency.md`).
Op terminal nunca é ressuscitada; ponteiro órfão se autorrepara (item 21).

4 cascatas competem pelo mesmo slot por ativo: `4h_15m` (nativa),
`1h_5m` (SMC), `rf1h_cond4h_15m` (item 56, experimental, ver seção 14),
`rf1h_uncond_15m` (item 68).

## 7. Gestão da operação ativa (HOLDING / PROTECTED)

Dois blocos em `persistScanResults`: pré-TP1 (`scanner.js:~3895-3994`) e
runner pós-TP1 (`scanner.js:~4096-4250`, ver seção 8). Cada avaliação grava
um **Decision Snapshot** (`src/lib/decisionSnapshot.js`, 544 linhas — 12+
builders puros) via `src/lib/decisionExplanation.js` (`explainOperationDecision`),
exibido no `TradeCard.jsx`. Fail-closed: `data_status` nunca vira `LIVE`
quando falta um fato (item 181).

Histórico: Fase 1 (rejeição de entrada, item 181) → Fase 3 (gestão
HOLDING/PROTECTED, item 182) → Fase 4 (EXIT + Telegram/Histórico/timeline
consumindo a mesma explicação, item 183, 2026-09-18). Uma 2ª revisão
independente (pedido explícito do usuário) achou e corrigiu 4 bugs reais na
própria camada de explicação (evidência podia descrever motivo já resolvido;
`data_status:'LIVE'` não garantia frescor; snapshot podia contradizer
`current_stop` sob corrida; snapshot sobrevivia no candle exato do TP1 —
item 182 addendum).

## 8. TP / Stop / Trailing

Tudo em `src/lib/opExitRules.js` (299 linhas, puro, sem I/O):

- **Guarda temporal P0-c/P0-g** — `isCandleUsableForExits` (linha 34):
  candle só avalia stop/TP se **abriu** no ou após o instante real da
  entrada (`getEntryReferenceTime`, linha 51 — prioriza candle de
  confirmação 15m/5m sobre o candle de sinal).
- **Trailing pós-TP1 (P0-d)** — `advanceTrailingStop` (linha 60): ATR-mult,
  monotônico, avaliado contra o stop ARMAZENADO antes de avançar (sem
  look-ahead).
- **Proteção pré-TP1, 2 modos mutuamente exclusivos, congelados na criação
  da op**: breakeven (`advancePreTp1StopProtection`, linha 81 — salta e
  satura na entrada; medido: 36% dos disparos cortaram operações que
  chegariam ao TP1, item 55) e trailing contínuo (`advancePreTp1Trailing`,
  linha 122 — ratcheia no extremo favorável via `favorableExtremeFromMfe`,
  linha 146; **LIGADO por padrão desde 2026-08-26**, item 132 — mesma
  expectância dentro do ruído, drawdown pela metade).
- **Stop estrutural SMC** — `computeStructuralStop` (linha 184): stop além
  do swing/sweep com buffer/piso/teto em ATR — não medido isoladamente com
  o teto tier-aware corrigido (item 104, re-run não confirmou
  estatisticamente).
- **Ambiguidade mesmo candle** — `resolveCandleExit` (linha 222): stop vence
  TP no mesmo candle fechado (política de mercado padrão, `exit_ambiguous`
  observável, item 36).
- **`closesFullyAtTp1`** (linha 248): runner ligado por padrão
  (`runnerEnabled: true`) — medido: custou −0,040 R/op num regime de baixa
  (item 46), não virou default diferente por ser medição de um regime só.

`priceCheckActiveOpsInner` (`scanner.js:4402`) replica a mesma lógica
stop/TP1/TP2 contra preço em tempo real (não candle), sem trailing/proteção
pré-TP1/MFE-MAE (esses só rodam no loop de candle — resolução deliberada).

## 9. Custos (fee / slippage / funding)

`src/lib/tradeMetrics.js`. `calcTradeCost` (linha 269): fee+slippage por
fill (2 ou 3, conforme `tp1_hit`) + `calcFundingCost` (linha 186, conta
fronteiras de 8h cruzadas via `countFundingSettlementsByLeg`, linha 124).
`calcRealizedDelta` (linha 368, chokepoint interno) subtrai o custo do bruto
ponderado por `getWeights` (linha 355, lido de `partial_percent`).

**Ligado por padrão desde a Fase 5** (diferente dos gates opt-in acima —
corrige uma medição que estava otimista, não adiciona mecanismo, item 44).
`avgCostR` é a métrica que decide: comparável direto com `expectancyR`.
Funding é **57,9-59% do custo medido**, não os ~5% originalmente estimados
(item 131) — `--real-funding` no backtest troca a constante por série real
com sinal por lado (comprado paga, vendido recebe quando a taxa é positiva).

## 10. Fechamento

Toda transição de status passa por `backend.tradeOps.transitionTradeOp`
(`src/api/entities.js:101`) → CAS transacional no Postgres
(`db/pgEntitiesCore.mjs`), regra pura compartilhada `canApplyTransition`
(`opTransition.js:47`): rejeita se o doc já é terminal ou se outro worker já
moveu o status. `clampMonotonicStop` (linha 66) garante que `current_stop`
nunca regride mesmo com CAS de status intacto. Estados terminais:
`STOP_HIT`, `TP2_HIT`, `INVALIDATED`, `CLOSED` — nunca recebem nova
transição. `clearActiveOp` dobrado para dentro da mesma transação
(libera o índice único de operação ativa automaticamente no Postgres).

## 11. Métricas

`summarizeOps(ops, options)` (`tradeMetrics.js:514-648`) — o agregador único
que todo painel/backtest usa. `expectancyR = ΣR/n`. IC95 **sempre ingênuo**
(i.i.d., `±1.96·erroPadrão`, linha 589) — nunca cite como corrigido (ver
seção 13). `conclusive` (linha 643) é `false` se `n < minTrades(30)` OU sem
amostra de R OU o IC cruza zero. **Alvo declarado do projeto desde o item
133**: não é mais provar edge (provar o +0,026R medido exigiria ~8.400
operações, ~70 anos) — é estreitar a meia-largura do IC
(`expectancyRCI95HalfWidth`, linha 615), que encolhe com √n independente de
existir edge ou não. `tradesForCIHalfWidth(sd, alvo, deff)` (linha 507) dá o
n necessário.

`src/lib/equityCurve.js` — duas curvas de capital REAL (compostas): risco
fixo % por trade (`simulateEquityCurve`) e retorno composto 100%
(`compoundReturnCurve`) — usar em vez de `maxDrawdownPct` de `summarizeOps`
para julgar risco de conta (aquele soma pnlPct bruto como se fosse 100% de
risco por operação, produz drawdown de 90%+ artificial em multi-símbolo).

Card **"Confiança ao Vivo"** no Dashboard (item 129) aplica o mesmo
`summarizeOps`/IC/gate de amostra às operações REAIS de produção,
crescendo sozinho a cada operação fechada.

## 12. Backtest

`src/lib/backtestEngine.js:157` `runBacktest` — relógio simulado
(`installSimClock`), itera `scanAsset`+`persistScanResults` **exatamente as
mesmas funções de produção**, sem modificação, contra candles históricos.
Warm-up (`fromMs`/`toMs`) separado da janela avaliada
(`evaluationFromMs`/`evaluationToMs`) desde item 47.2. `buildReport`
segmenta por cascata e monta ~15 seções de diagnóstico (funil de regime,
gatilho SMC, reteste, deslocamento, custo, equity curve, atribuição por
indicador via simulador de operação-fantasma).

`scripts/run-backtest.mjs` — CLI (`npm run backtest`), imprime o bloco
**"PODER DE DESCARTE"** em todo run (meia-largura do IC ingênuo + n
necessário para 0.20/0.15/0.10R). `scripts/analyze-backtest.mjs` decompõe
um relatório já gerado (sem replay novo, não consome "tentativa" no sentido
de overfitting): por motivo de saída, por símbolo, por trimestre
(cronológico — degradação vs. sorte datada), decomposição de custo, tempo
em posição. Regra de ordem citada da literatura (Bajgrowicz & Scaillet, JFE
2012): **congelar custos antes de calibrar qualquer parâmetro**.

Fonte de dado: Spot por padrão, Futures real disponível desde item 122-124
(estatisticamente indistinguível no agregado). Carteira padrão: 7 símbolos
fixos por escolha deliberada do usuário (`BTCUSDT,ETHUSDT,FETUSDT,
PENDLEUSDT,ZROUSDT,DYDXUSDT,PAXGUSDT`) — **nunca trocar pela carteira de 20
"para ajudar"** sem pedido explícito (`docs/claude/backtest-usage.md`).

## 13. OOS / Correção estatística

Dois scripts, nunca tocam `backtestEngine.js`/`pineConfig` — puramente
diagnóstico sobre um relatório já gerado:

- `scripts/backtest-correlation-check.mjs` — corrige o IC ingênuo por
  correlação entre símbolos. `findOverlapClusters` (linha 116, União-Find
  por sobreposição temporal REAL de operações, não por calendário) →
  `clusterRobustStdErr` (linha 142, Cameron-Miller CR1) → `designEffect`
  (linha 293, `(SE_cluster/SE_naive)²`). `clusteredCIStudentT` (via
  `studentTCritical95`, linha 265) é o recomendado quando G (nº de
  clusters) é baixo. `permutationTest` (linha 343, deslocamento circular
  por símbolo) valida o DEFF contra uma nula. `clusterSignFlipTest` (linha
  442) testa o efeito em si. **DEFF medido neste projeto: 0,08 a 3,56** —
  às vezes estreita, às vezes alarga mais que triplica o erro-padrão
  ingênuo (item 97-99).
- `scripts/backtest-trial-registry.mjs` — ledger append-only
  (`docs/backtest-trial-registry.json`). `bonferroniZ(familySize)` (linha
  76) devolve o z bicaudal ajustado (`alpha/familySize`). `summarizeFamily`
  (linha 229) recalcula o IC de cada trial da família sob esse z e aplica
  `correctedConclusiveVerdict` (linha 217 — nunca resgata um trial com
  amostra insuficiente via correção). Existe porque um experimento
  renomeado e repetido até dar resultado favorável por acaso é o modo
  padrão de "descobrir" um edge que não existe — itens 88/89 documentam a
  família SELL-only (14 trials, 0 sobrevivem ao Bonferroni).

**Regra prática vigente**: qualquer IC95 já publicado neste projeto deve ser
lido como N efetivo ≈ N nominal / 3 (DEFF médio medido em 3 relatórios
independentes, item 99) até rodar a ferramenta relatório por relatório.

## 14. Experimentos

- **Bloco 0 (edge existe ou é só regime de mercado?) — ENCERRADO** (item
  133, 2026-08-27). Medido em janela de alta (+0,294R CONCLUSIVA) e baixa
  (INCONCLUSIVA); BUY e SELL viraram hipóteses separadas (item 88); o único
  holdout SELL genuinamente fora da amostra falhou (n=150, IC cruza zero).
  Achado direcional robusto do ledger: **BUY perde −0,344R**, não "SELL
  ganha". SELL-only não vai a produção.
- **Bloco 1 (4 flags de entrada dormentes — retest/displacement/smcTier/
  OB-FVG) — TRANCADO**, não por preguiça de testar: a base (RF nativa) não
  tem edge demonstrado fora da amostra que a gerou, testar filtro em cima
  disso reproduziria o mesmo padrão de falso positivo (recomendação do
  conselho, item 73). 3 dos 4 flags nem chegam a terminar um run de 20
  símbolos/12 meses (timeout, gargalo de performance do replay — item 113).
- **Modo sombra prospectivo** (`scripts/run-scan-shadow.mjs`/
  `analyze-shadow-rf1h.mjs`, item 56) — braço experimental
  `rf1h_cond4h_15m` rodando ao vivo em coleções isoladas, nunca abre
  operação real. **Checkpoint 2026-09-21 (item 185)**: no ritmo real
  medido (0,72 op/mês), atingir a amostra mínima (n≥30) levaria **~3,5
  anos**; n≈100 (alvo original), ~11,6 anos. **Correção desta auditoria**:
  a primeira versão deste documento (escrita a partir do texto do item 185)
  dizia que a pausa era "recomendada, ainda não executada" — **errado**. O
  `git log` confirma que a pausa já foi executada no mesmo PR que registrou
  o item 185: commit `812b268` ("chore: pausar scan-shadow.yml/
  analyze-shadow.yml (modo sombra, item 185) #383", 2026-09-21 12:21
  -03:00) — os dois workflows já estão com `schedule:` comentado. O texto
  do item 185 em `known-risks.md` descreve a análise que MOTIVOU a pausa,
  não o estado final da ação — ele não foi atualizado depois do commit que
  a executou (achado do conselho de revisão desta rodada, papel Segurança).
- **Instrumentação Spot×Futures (`market_source`, item 178, 2026-09-14) já
  existe, mas não é consumida em nenhuma métrica agregada.** Todo
  `TradeOperation` grava `market_source` na criação (`scanner.js:515/1115/
  2157`) — cron sempre Spot, navegador sempre Futures, 1:1 com "qual dos
  dois loops criou a operação" (a lacuna que o item 4 addendum apontava em
  2026-08-24 já foi fechada por outro item três semanas depois, sem que os
  dois se referenciassem). Achado do conselho: nenhum consumidor de
  `summarizeOps`/`tradeMetrics.js`/card "Confiança ao Vivo" agrupa por esse
  campo hoje — `grep` só encontra `market_source` em `scanner.js`,
  `opTransition.js` (gate) e `TradeCard.jsx` (exibição por operação
  individual), nunca em agregação.
- **Teto de exposição de carteira** (`maxConcurrentSameSideOps`, item 133) —
  backtest-only, medido e despriorizado (aceleração 1,00-1,07×, muito abaixo
  da meta).

---

## Estado atual, em uma frase por estágio

| Estágio | Estado |
|---|---|
| Dados | Estável; divergência Spot/Futures aceita como limitação permanente |
| Indicadores | Paridade validada por engenharia (golden tests), não por CSV oficial do TradingView (falta plano pago) |
| Score | Fiel ao Pine real; SMC é advisory, nunca gate |
| Arbitragem | 7 bugs corrigidos após auditoria externa; sem medição de efeito próprio |
| Confirmação | Funil bem instrumentado; `skip15mConfirmationEnabled` ligado por paridade, não por significância |
| Abertura | CAS transacional (Postgres), invariante de 1 op/ativo estrutural desde o cutover |
| Gestão | Explainability V2 completa (4 fases), 4 bugs de exibição corrigidos numa 2ª revisão |
| TP/Stop/Trailing | Todos os P0 de look-ahead corrigidos; trailing pré-TP1 medido (reduz variância, não prova edge) |
| Custos | Ligado por padrão; funding é 58% do custo real, maior do que se assumia |
| Fechamento | CAS + clamp monotônico; sem 3º caminho de mutação |
| Métricas | Alvo mudou de "provar edge" para "estreitar o IC" (item 133) |
| Backtest | Mesmo motor de produção; fonte Futures disponível desde item 122 |
| OOS/correção | DEFF medido 0,08-3,56; regra prática N efetivo ≈ N/3 |
| Experimentos | Bloco 0 encerrado, Bloco 1 trancado, modo sombra pausado (já executado, PR #383) |

---

## Achado colateral desta auditoria (corrigido nesta rodada)

`CLAUDE.md` (seção "Stack") descrevia o backend como "Firebase — apenas
Firestore + Authentication" e não mencionava o cutover para Postgres/Neon.
Mas `.claude/rules/trading-safety.md`, `.claude/rules/firestore-concurrency.md`
e `docs/known-risks.md` item 170 (2026-09-08 a 2026-09-12) documentam que
`TradeOperation` e as demais entidades de negócio já migraram para Postgres/
Neon via `sentinel-signals-api` — `entities.js` é hoje um cliente HTTP, não
mais um SDK Firestore direto. Auth e (aparentemente) `strategyConfig`/
`telegramFilters` continuam em Firestore. Três papéis independentes do
conselho de revisão desta rodada (Arquiteto, Segurança, Testes)
convergiram, sem coordenação entre si, em recomendar a correção como
primeiro passo de baixo custo/alto valor (`.claude/rules/
documentation-truth.md`: "confronte com o código antes de afirmar...
corrija a contradição primeiro") — **corrigido nesta rodada**, ver
`CLAUDE.md` atual.

## Conclusão do conselho de revisão (2026-09-22)

Síntese completa, com as refutações entre papéis, registrada em
`docs/known-risks.md` item 186 (formato fato/hipótese/recomendação,
mesmo padrão dos conselhos anteriores — itens 73, 125/126, 133, 140, 149,
180).
