---
description: Como e o que testar (Vitest). Carregue ao escrever/alterar testes ou ao mexer em lógica testável do motor.
paths:
  - "**/*.test.js"
  - vite.config.js
---

# Testes (Vitest)

`npm test` (= `vitest run`) roda no CI (`.github/workflows/ci.yml`) antes do
build e **bloqueia o merge** (o job precisa estar "required" em Branch
protection). Falha de teste manda alerta no Telegram.

Cobertura atual: `src/lib/indicators/*.test.js` (RSI, SMC BOS/CHoCH/sweep/PD,
ADX, Choppiness, Tier) — funções puras, com casos de valor conhecido e limites
(dados insuficientes, candles planos). `opTransition.test.js`/
`opExitRules.test.js`/`assetHealthcheck.test.js`/`assetStateDiff.test.js`
cobrem as regras puras extraídas do motor (CAS, guard temporal, trailing,
contador RF, healthcheck, diff de estado). `tradeMetrics.test.js` cobre a
fonte única de métricas de performance (`src/lib/tradeMetrics.js` — PnL
realizado com parcial, R sobre risco inicial, classificação WIN/LOSS/BE por
resultado, agregados winRate/profitFactor/expectância/drawdown) com valores
hand-computed BUY e SELL — ver `docs/known-risks.md` item 22.

`scannerStateMachine.test.js` cobre a **máquina de estados fim a fim** contra
as funções REAIS do `scanner.js` (`persistScanResults`, `priceCheckActiveOps`,
`buildTradeOpData`), usando um backend fake em memória
(`src/lib/__fixtures__/fakeBackend.js`, mesma forma de chamada de
`src/api/entities.js`, reaproveitando o `canApplyTransition`/`isTerminalStatus`
real) — sem re-implementar as regras, só trocando a persistência. Cobre: todas
as transições documentadas em `.claude/rules/trading-engine.md`
(`SIGNAL_CONFIRMED→RUNNER_ACTIVE→TP2_HIT/STOP_HIT/INVALIDATED`, `→CLOSED` por
Time Stop/Chop Exit), o guard temporal do candle de entrada (P0-c), o trailing
sem look-ahead (P0-d), o dedup do contador RF por candle (P0-e), e um teste de
concorrência real (`Promise.all` sem await individual, deixando as duas
funções racearem de verdade via microtask do fake) provando que o CAS nunca
resulta em estado misto/corrompido quando os dois loops disputam a mesma op.

## Lacunas restantes

- **Cascata de entrada completa** (`check15mConfirmation`/
  `check5mSmcConfirmation`, que buscam candles via rede): não coberta por
  `scannerStateMachine.test.js` (que testa `buildTradeOpData` isoladamente,
  pulando a etapa de confirmação) — exigiria mockar `fetchCandles` com séries
  sintéticas; valor incremental baixo (a criação de op em si é só dados, a
  decisão de "quando confirmar" é o que ficaria sem cobertura, e é lógica de
  timing, não de máquina de estados).
- **Paridade Pine×JS** (golden tests): ver `.claude/rules/pine-parity.md`.

## Convenções

- Vitest reaproveita `vite.config.js` — não crie config separada.
- Teste a **função pura** sempre que possível (indicadores, transição de estado
  isolada) antes de testar o loop inteiro.
- Novo bug corrigido = novo teste que reproduz o bug (falhava antes, passa
  depois).
