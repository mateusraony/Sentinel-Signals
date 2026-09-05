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
**Desde a Fase 5 (item 44) esse módulo desconta taxa/slippage/funding POR
PADRÃO**, no painel e no backtest; os testes que documentam a fórmula BRUTA
passam `ZERO_COST` explicitamente. Ao escrever teste novo ali, decida
conscientemente qual regime está afirmando — um valor hand-computed sem
`ZERO_COST` é líquido, não bruto.

`backtestAnalysis.test.js` cobre o **diagnóstico pós-backtest**
(`src/lib/backtestAnalysis.js` — decomposição do resultado por motivo de saída,
símbolo, componente de custo e tempo em posição). O teste que importa ali é o
de **aditividade**: as contribuições dos baldes têm que somar exatamente a
expectância geral, e taxa+slippage+funding têm que reconstruir o custo total —
é isso que separa uma decomposição de uma comparação de médias entre grupos de
tamanhos diferentes. Ao estender, prefira asserções sobre essa invariante a
valores absolutos por balde.

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

`backtestEngine.test.js` cobre o **motor de backtest histórico**
(`src/lib/backtestEngine.js`, ver `docs/claude/backtest-usage.md` e
`docs/known-risks.md` item 33) contra as MESMAS funções reais de
`scanner.js` (`scanAsset`/`persistScanResults`), com candles sintéticos e
valores de flip derivados empiricamente (não chutados): a propriedade
central de "sem look-ahead" (nenhum sinal/operação aparece antes do
instante histórico real da mudança de tendência), o shim de relógio
simulado (`installSimClock`/`advanceSimClock`/`restoreClock`, incluindo
restauração garantida mesmo após exceção), o comportamento seguro ao
esgotar os dados (nunca fecha uma operação à força só por falta de candle
futuro) e — de quebra — a **cascata de confirmação 15m atrasada**
(`check15mConfirmation` via o loop de retry de `persistScanResults`), que
fecha a lacuna descrita abaixo.

## Camada de tela — smoke test de renderização (item 166)

`src/pages/pagesSmoke.test.jsx` monta TODA página em jsdom com os mesmos
provedores de `App.jsx`, em **duas variantes: dados vazios e dados presentes**.
Não é teste de comportamento — responde "renderiza sem explodir?".

Antes dele a cobertura de `src/pages`/`src/components`/`src/hooks` era **0,0%**
(63 arquivos, 2.439 linhas, zero executadas), e foi de lá que veio a página
quebrada do item 157.

**As duas variantes são obrigatórias.** Um teste de reintrodução provou que a
variante vazia SOZINHA não pega a classe de bug do item 157: um componente que
só renderiza quando há dados nunca é exercitado — o mesmo ponto cego que deixou
o bug chegar em produção. Ao adicionar página nova, some-a a `PAGINAS`; ao
adicionar entidade, some uma linha plausível a `LINHAS_EXEMPLO`
(`src/pages/__fixtures__/renderPage.jsx`).

O mock é de UM módulo (`@/api/entities`) — dividendo do adaptador. Página que
importe Firestore direto quebra aqui, o que é a informação certa.

## Verificação de guard: reintroduza o bug (item 166)

**Todo tripwire/guard novo precisa provar que falha com o bug que ele deve
pegar.** Nesta sessão a verificação achou buraco no guard recém-escrito duas
vezes (o smoke test que não pegava; a catraca do typecheck que aprovava erro de
sintaxe porque a contagem despencava). Guard não testado contra o próprio alvo
é suposição com aparência de proteção.

## Módulo que faz trabalho no carregamento é intestável (item 166)

Já mordeu 3× neste projeto (itens 158, 164, 166). Em Node/ESM, ou a parte pura
sai para um módulo próprio (`healthAuditFormat.mjs`, `failureClassification.mjs`),
ou o corpo fica atrás de uma guarda de execução direta
(`import.meta.url === pathToFileURL(process.argv[1]).href`).

## Lacunas restantes

- **Cascata de entrada completa** (`check15mConfirmation`/
  `check5mSmcConfirmation`, que buscam candles via rede): a confirmação 4h→15m
  (incluindo o caminho de retry com confirmação atrasada) ganhou cobertura em
  `backtestEngine.test.js` (ver acima). `check5mSmcConfirmation` (cascata
  1h→5m SMC) já tem cobertura extensa em `scannerStateMachine.test.js`
  (`insufficient_data`/`no_trigger`/`wrong_direction_trigger`/`fetch_error`/
  `ote_zone_unfavorable`, write-on-change entre retries, expiração 4x1h) —
  incluindo, desde 2026-08-04, o caminho de timing que faltava: um sinal que
  rejeita (`no_trigger`) na 1ª passada e só confirma (cria a `TradeOperation`)
  numa passada de retry posterior (`SMC: check5mSmcConfirmation rejeita
  (no_trigger) na 1a passada e confirma pelo retry`). Fechado.
- **Paridade Pine×JS** (golden tests): ver `.claude/rules/pine-parity.md`.

## Convenções

- Vitest reaproveita `vite.config.js` — não crie config separada.
- Teste a **função pura** sempre que possível (indicadores, transição de estado
  isolada) antes de testar o loop inteiro.
- Novo bug corrigido = novo teste que reproduz o bug (falhava antes, passa
  depois).
