---
description: Regras do motor de trading — máquina de estados, concorrência e temporalidade em scanner.js e indicadores. Carregue ao mexer em src/lib/scanner.js, src/lib/indicators/**, scripts de scan.
paths:
  - src/lib/scanner.js
  - src/lib/indicators/**
  - scripts/run-scan.mjs
  - scripts/build-scan.mjs
  - scripts/admin*.js
---

# Motor de trading — invariantes e riscos P0

`src/lib/scanner.js` roda **idêntico** no browser e no cron (via esbuild em
`scripts/build-scan.mjs`). Há **dois loops** que mutam `TradeOperation`:
`persistScanResults` (baseado em indicador, ~`scanner.js:938-1107`) e
`priceCheckActiveOpsInner` (baseado em preço, ~`scanner.js:1160-1231`).

## Máquina de estados (única fonte)

`SIGNAL_CONFIRMED → RUNNER_ACTIVE` (TP1) · `→ STOP_HIT` · `RUNNER_ACTIVE →
TP2_HIT` / `STOP_HIT` / `INVALIDATED` · saídas `CLOSED` (Time Stop / Chop Exit).
Terminais: `STOP_HIT`, `TP2_HIT`, `INVALIDATED`, `CLOSED`. **Estado terminal
nunca deve receber nova transição.**

## Riscos P0 — status atual

- **[CORRIGIDO — P0-a] Escrita não-transacional de `status`.** Os dois loops
  agora escrevem via `backend.tradeOps.transitionTradeOp(opId, fromStatus,
  patch)` (`src/api/entities.js` + espelho em `scripts/adminEntities.js`), um
  compare-and-set transacional sobre o `status` (regra pura compartilhada em
  `src/lib/opTransition.js`, testada em `opTransition.test.js`). Fecha:
  lost-update de status, transição a partir de estado terminal e **notificação
  duplicada** (notify só dispara quando `applied === true`). O `clearActiveOp`
  foi dobrado para **dentro da mesma transação** nos estados terminais —
  corrige também o bug pré-existente do ativo travado (crash entre gravar o
  terminal e limpar `assetActiveOps` bloqueava novas entradas para sempre).
- **Locks diferentes (mantidos de propósito).** `persistScanResults` (full-scan)
  e `priceCheckActiveOps` (`'price-check'`, `scanner.js:1147`) seguem com locks
  separados: o CAS por-op protege independentemente do lock (que é fail-open), e
  serializar os dois atrasaria o price-check leve, que é o caminho rápido de
  segurança.
- **[CORRIGIDO — P0-c] Candle de entrada retroativo.** `persistScanResults` só
  avalia stop/TP por high/low quando o candle avaliado fechou ESTRITAMENTE
  depois do candle de sinal (`isCandleUsableForExits` em
  `src/lib/opExitRules.js`). Ops legadas sem referência de entrada mantêm o
  comportamento antigo (fallback explícito). O price-check por preço spot cobre
  o intervalo ao vivo — sem buraco de proteção.
- **[CORRIGIDO — P0-g] Guarda P0-c comparava contra o candle de SINAL, não o
  da entrada real — confirmação atrasada (retry) ainda vazava preço
  pré-entrada.** Auditoria externa (2026-07-18): um sinal 4h fechado às 08:00
  cuja confirmação 15m só chega às 11:45 (retry) tinha seu primeiro candle
  "utilizável" (08:00–12:00) julgado seguro pela guarda antiga — o fechamento
  dele (12:00) é posterior ao fechamento do candle de SINAL (08:00) — mesmo
  contendo ~3h45 de movimento ANTES da entrada existir; o mesmo horário errado
  também alimentava o Time Stop (`barsOpen`), fazendo a operação "envelhecer"
  antes de nascer. `entry_candle_time_15m`/`entry_candle_time_5m` já eram
  gravados na criação da op mas nunca eram lidos em lugar nenhum. Corrigido:
  `isCandleUsableForExits` (`src/lib/opExitRules.js`) passou a comparar o
  **open** do candle candidato (não o close) contra o horário real da entrada
  (`getEntryReferenceTime`, nova função — prioriza
  `entry_candle_time_15m`/`_5m`, cai para `candle_close_time` quando ausente);
  só um candle que COMEÇA no ou após o instante da entrada está livre de
  contaminação. O Time Stop passou a envelhecer a partir da mesma referência.
  No caminho rápido (sem atraso de retry) o comportamento é idêntico ao
  P0-c original — a mudança só afeta confirmações atrasadas, que é
  exatamente onde o bug existia. Ver `docs/known-risks.md` item 26.
- **[CORRIGIDO — P0-d] Trailing look-ahead.** As saídas do runner são avaliadas
  contra o stop ARMAZENADO; o avanço do trailing (`advanceTrailingStop`) só
  acontece depois, do fechamento, e passa a proteger no candle SEGUINTE. O
  `exit_price` de stop do runner agora usa o stop armazenado (nunca o avançado
  no mesmo candle).
- **[CORRIGIDO — P0-e] `rf_reverse_bars_count` por candle.** Deduplicado por
  `rf_reverse_last_candle` (`nextRfReverseCount`) — N passadas do cron sobre o
  mesmo candle contam 1x; reset quando o RF volta a favor; fallback por-passada
  se o feed não trouxer timestamp.
- **[CORRIGIDO — P0-f] Retry re-apontava `assetActiveOps` para op terminal.**
  `createTradeOpIfNoneActive`, ao encontrar a op de ID determinístico já
  existente (retry de sinal), regravava o ponteiro sem checar estado terminal —
  ativo ficava bloqueado para sempre (a limpeza em-transação só roda numa
  transição terminal, que o CAS rejeita em op já terminal). Agora a decisão é a
  regra pura `planTradeOpCreation` (`src/lib/opTransition.js`), compartilhada
  por `entities.js`/`adminEntities.js`/fake: a transação lê também a op
  apontada; ponteiro para op inexistente/terminal conta como vago (auto-reparo
  de ponteiros órfãos legados); op terminal nunca volta a ser apontada; op viva
  sem ponteiro (janela de crash) continua sendo re-apontada. Ver
  `docs/known-risks.md` item 21.
- **[CORRIGIDO — item 20 da proposta de hardening 2026-07] `current_stop`
  podia regredir mesmo com o CAS de `status` intacto.** `transitionTradeOp`
  faz CAS só sobre `status` (`canApplyTransition`) — o resto do `patch`,
  incluindo `current_stop`, era aplicado com `tx.update` sem checar se o novo
  valor é realmente melhor que o já salvo. Como o browser e o cron computam
  `current_stop` ANTES de abrir a transação (a partir da própria leitura de
  preço/candle), dois avanços de trailing no mesmo status (`RUNNER_ACTIVE`)
  passam ambos no CAS — o segundo a commitar vencia mesmo carregando um stop
  pior, calculado antes do primeiro ter sido salvo. Um comentário anterior em
  `opTransition.js` chamava isso de "last-write-wins by design... self-corrects
  on the next pass" — verificado: `advanceTrailingStop` usa o `current_stop`
  ARMAZENADO como piso (`Math.max`/`Math.min`), então uma regressão só se
  autocorrige quando o preço volta a se mover favoravelmente o bastante — não
  é imediato, é uma janela real (embora estreita) em que o stop pior poderia
  encerrar a operação. **Correção**: nova função pura `clampMonotonicStop`
  (`src/lib/opTransition.js`), usada DENTRO da mesma transação nos três
  backends (`entities.js`, `adminEntities.js`, `fakeBackend.js`) — o
  `current_stop` do patch é comparado contra o valor lido na transação
  (nunca contra o valor pré-transação do chamador) e só aplica se for melhor
  para o lado (`BUY`: maior; `SELL`: menor). Campos sem risco equivalente
  (contadores dedupados por candle, flags one-way) continuam last-write-wins,
  de propósito. Regressão em `opTransition.test.js` (função pura + cenário de
  corrida via o harness `makeStore`) e `scannerStateMachine.test.js` (mesmo
  cenário contra o `fakeBackend.transitionTradeOp` real).
- **[CORRIGIDO — item 38] Gate de zona PD da cascata SMC 1h→5m.** Dado real
  (74/74 rompimentos 1h rejeitados em 18,5 meses de BTCUSDT) confirmou o
  viés geométrico medido no item 35: o gate compartilhava o `closedCandles`
  de `calculateStructure`, então um rompimento cai por construção na zona
  que o gate rejeita para aquela direção — tautologia, não raridade
  estatística. Removido do candle de viés 1h (toda quebra de estrutura vira
  `SignalEvent` incondicionalmente); zona movida para o gatilho de entrada
  5m (`check5mSmcConfirmation`, `scanner.js`), medida contra a perna
  (`buildOteLeg`, `src/lib/indicators/smcStructure.js`) do próprio
  rompimento em vez do range de 20 velas — divergência deliberada do porte
  1:1 do Pine, mesma categoria do item 24. Ver `docs/known-risks.md`
  item 38.
- **[OBSERVÁVEL — política já correta] Ambiguidade stop/TP no mesmo
  candle.** Um candle fechado pode tocar stop e TP1/TP2 sem que o OHLC diga
  a ordem intrabar real. A política "stop vence" (`scanner.js`, pré e
  pós-TP1) já era o padrão de mercado (pesquisa de comunidade: backtesting.py,
  QuantConnect, NinjaTrader). Formalizada em `resolveCandleExit`
  (`opExitRules.js`) e agora observável via `TradeOperation.exit_ambiguous`
  — sem mudar nenhuma transição. Reconstrução via timeframe menor fica
  registrada como opção futura, condicionada a volume real desse campo (dado
  de 15m/5m não fica disponível no loop de saída hoje — buscar exigiria
  custo de API recorrente). Ver `docs/known-risks.md` item 36.
- **[RESIDUAL — aguardando dados] Precedência stop>TP entre loops.** O CAS
  resolve a corrida de dados; com P0-c/d corrigidos, o cenário grave (TP1
  retroativo vencendo stop real) deixou de existir. O que resta — dois loops
  decidindo transições legítimas diferentes no mesmo instante — é raro e agora
  **observável**: toda transição descartada pelo CAS gera `logWarn` em
  `SystemLog` ("Transição descartada pelo CAS"). Só investir numa regra dura de
  precedência (stop autoritativo entre loops) se os logs mostrarem ocorrência
  real.
- **Arbitragem entre cascatas** (`src/lib/signalArbitration.js` +
  `scanner.js:handleActiveOpArbitration`) — decide o que fazer quando um
  sinal candidato chega com a outra cascata já ativa (promoção em dois
  estágios `PENDING_15M`→`CONFIRMED`/`EXPIRED`/`REJECTED`, continuidade,
  correção de confiança, risco crítico). Nunca cria uma segunda
  `TradeOperation`; toda escrita passa por `transitionTradeOp` (mesma CAS
  acima). Detalhe completo, os 7 problemas corrigidos após auditoria externa
  do PR #78, e os campos novos: `docs/known-risks.md` item 39.
- **[CORRIGIDO — item 39.1] Guarda de operações duplicadas agora cobre os
  DOIS loops mutadores.** `persistScanResults` já suspendia
  arbitragem/entrada/stop-TP quando detectava mais de uma operação ativa
  para o mesmo ativo; `priceCheckActiveOpsInner` não tinha a mesma guarda —
  escolhia implicitamente a primeira op da lista. Extraída função pura
  compartilhada `groupActiveOpsByAsset` (`src/lib/opTransition.js`, sem
  I/O) — agrupa por `asset_id` (fallback por `symbol` para op legada sem o
  campo), devolve `{ validGroups, duplicateGroups }`, independente da ordem
  de retorno do backend. Os dois loops agora usam a mesma regra;
  `priceCheckActiveOpsInner` loga o grupo duplicado via
  `SystemLog.createUnique` (dedupado pelo conjunto de IDs, para não
  spammar a cada tick) e só processa `[...validGroups.values()]`. Ver
  `docs/known-risks.md` item 39.1.
- **Gatilho de reteste** (`src/lib/indicators/retest.js` +
  `scanner.js:evaluateRetestGate`) — Fase 2 rodada 1, **`pineConfig.
  retestEnabled` desligado por padrão**. Gate adicional ANTES de
  `check15mConfirmation`/`check5mSmcConfirmation` (intocadas) nos 4 pontos de
  chamada — exige que o preço volte a tocar o nível que o sinal candidato
  rompeu antes de confirmar a entrada. Com o flag desligado é um passthrough
  total (zero fetch extra). **Não ativar sem comparar relatórios de backtest
  com/sem primeiro** — ver `docs/known-risks.md` item 40 para a justificativa
  estatística e o desenho completo.
- **Gatilho de candle de deslocamento** (`src/lib/indicators/displacement.js`
  + `scanner.js:evaluateDisplacementGate`) — Fase 2 rodada 2, **`pineConfig.
  displacementEnabled` desligado por padrão, só cascata SMC (1h→5m)**.
  Diferente do reteste: classifica um único candle já conhecido (o gatilho
  que `check5mSmcConfirmation` já achou), roda DEPOIS da confirmação 5m
  (intocada — ganhou só 1 campo aditivo no retorno, `closedCandles`, para o
  gate reaproveitar sem `fetchCandles` redundante), ANTES de criar a op.
  **Não ativar sem comparar relatórios de backtest com/sem primeiro** — ver
  `docs/known-risks.md` item 41. Com as duas rodadas, a Fase 2 está completa.
- **Tier/regime na cascata SMC** (`src/lib/indicators/tier.js` +
  `scanner.js:evaluateRegime`) — Fase 3, **`pineConfig.smcTierEnabled`
  desligado por padrão**. Reaproveita o MESMO sistema de tier/ADX/Choppiness
  que a cascata RF já usa (mesma tabela de limiares, sem calibração nova pra
  1h) — não é um mecanismo novo, fecha uma assimetria real entre as duas
  cascatas (SMC nunca teve regime nem tier próprio). Gate posicionado ANTES
  de `hasActiveOp`, igual à RF, então também bloqueia arbitragem cross-
  cascade quando reprova. `tier.atrStopMult` continua sem uso em SMC — o
  stop segue estrutural, nunca ATR-multiple. **Não ativar sem comparar
  relatórios de backtest com/sem primeiro** — ver `docs/known-risks.md`
  item 42 para o efeito colateral no Chop Exit e a suposição não validada
  sobre a tabela de limiares em 1h.
- **Order Block / Fair Value Gap** (`src/lib/indicators/orderBlock.js` +
  `fvg.js`) — Fase 4, **`pineConfig.smcObFvgEnabled` desligado por padrão**.
  **Informativos: entram no score SMC, NUNCA são gate** — o próprio Pine do
  usuário os consome assim (4 dos 7 componentes do seu Confluence Score).
  **Ativação em dois estágios**: ligar o flag com os pesos no default (0) dá
  medição pura com score byte-idêntico; dar peso é decisão separada, porque os
  7 pesos existentes já somam 100 e o score alimenta os limiares de arbitragem
  da Fase 1. FVG é porte fiel; **Order Block é aproximação deliberada** (o
  original depende de perfil de volume via biblioteca externa inacessível) —
  ver `docs/known-risks.md` item 43.

- **Custos reais e gate de amostra** (`src/lib/tradeMetrics.js`) — Fase 5,
  **LIGADO por padrão** (não é opt-in como as Fases 2-4: corrige uma medição
  errada, não adiciona mecanismo). Taxa/slippage/funding descontados no
  chokepoint `calcRealizedDelta`, propagando para win rate, drawdown e profit
  factor — no painel E no backtest. `ZERO_COST` é o opt-out explícito.
  **`avgCostR` é a métrica que decide**: custo em R, comparável direto com
  `expectancyR`. `summarizeOps` também devolve IC da expectância e
  `conclusive` — relatório com amostra insuficiente diz INCONCLUSIVO em vez de
  exibir win rate. **Regra herdada da literatura: congele os custos ANTES de
  calibrar qualquer parâmetro** (calibrar a custo zero e recalibrar depois
  dobra as tentativas e contamina a busca). Ver `docs/known-risks.md` item 44.

- **Runner do TP1** (`opExitRules.js:closesFullyAtTp1`) — item 46, **LIGADO por
  padrão** (`pineConfig.runnerEnabled: true` = o comportamento de sempre). Com
  `false`, o TP1 vira saída TERMINAL (`CLOSED`/`closed_reason: TP1_FULL`) em vez
  de `RUNNER_ACTIVE`. **A decisão é congelada na CRIAÇÃO** (`partial_percent:
  100`) e lida da OPERAÇÃO nos dois loops, nunca do `pineConfig` — porque
  `priceCheckActiveOpsInner` não tem config em escopo, e porque virar um flag
  não pode abandonar um runner já vivo. `partial_percent` é a fonte única
  compartilhada com `getWeights` (`tradeMetrics.js`): se os dois divergirem, o R
  reportado descreve uma posição que não existiu. Medido em 344 operações: o
  runner custou −0,040 R/op (−13,9 R), e fechar no TP1 teria sido melhor em 95
  das 121 que o atingiram — mas **num regime só** (bear market), por isso não
  virou default. Primeira rodada a tocar a SAÍDA e não a entrada.

- **MFE/MAE por operação** (item 47.2) — `mfe_r`/`mae_r`/`bars_to_mfe`/
  `bars_to_mae` rastreados incrementalmente em `persistScanResults` (candle-
  based) a partir do high/low do candle de gerenciamento, gated pelo mesmo
  `candleUsable` de P0-c/P0-g. Recomputado toda passada mas estável dentro do
  mesmo candle — só gera escrita quando um candle NOVO chega, mesmo ritmo do
  resto do loop. **Deliberadamente não** rastreado em
  `priceCheckActiveOpsInner` (preço muda a cada tick, viraria fonte de
  escrita quase contínua) — resolução de candle, não de tick.
  `bars_to_tp1`/`bars_to_stop` reusam o mesmo proxy de tempo decorrido que o
  Time Stop (`barsOpen`), não um contador novo.

- **Funil de confirmação de entrada instrumentado** (item 45.3/45.4/49) —
  `SignalEvent.last_rejection_reason` registra qual gate rejeitou a última
  tentativa de entrada, escrito **só pelos loops de RETRY** de
  `persistScanResults` (o 1º pass já loga verboso pro `SystemLog` uma vez por
  sinal), write-on-change (mesma convenção de `expired_logged`/
  `rf_reverse_bars_count` — motivo igual entre passadas custa zero escrita
  extra). Cada avaliação (mude o campo ou não) também empurra pra
  `entryFunnelOutcomes`, devolvido por `persistScanResults` e agregado num
  histograma por cascata (`report.entryFunnel`) no backtest — responde "qual
  gate barra mais no funil inteiro", não só o motivo final de cada sinal. O
  log de expiração (RF e SMC) inclui o último motivo conhecido. Fechou o
  `no_trigger` colapsado de `check5mSmcConfirmation` (item 45.3) em três
  causas distintas: `insufficient_data` (< 60 candles 5m fechados),
  `no_trigger` (dado suficiente, gatilho nunca disparou), `fetch_error`.
  `active_op_exists` conta no histograma mas nunca grava o campo — não é
  rejeição do gate, é o asset já estar ocupado.
- **Instrumentação granular RF regime + gatilho SMC 5m** (item 50) — dado
  real (12 meses/7 símbolos) mostrou `regime_rejected` como 69% das
  rejeições RF e `no_trigger` como 70% das rejeições SMC, mas nenhuma das
  duas cascatas tem um threshold "solto" pra recalibrar (RF usa a tabela de
  tier copiada do Pine real do usuário; o gatilho 5m SMC não existe no Pine
  — é desenho original do Sentinel). `rfRegimeOutcomes` (novo, simétrico a
  `smcRegimeOutcomes` da Fase 3 — os dois agora gravam `adx`/`chop`/`tier`
  reais, não só ok/not-ok) e `wrong_direction_trigger` (novo valor de
  `last_rejection_reason` — sweep/estrutura dispararam, só no lado OPOSTO
  ao sinal, antes indistinguível de "nenhum evento") fecham a lacuna de
  instrumentação, sem mudar nenhum critério de confirmação/rejeição.
  `smcTriggerOutcomes`/`attemptsByKey.smcTrigger` trocam a inferência
  aritmética agregada (346 sinais × ~48 avaliações ≈ 17.024) por contagem
  real de tentativas por sinal. Novas seções no backtest: `report.rfRegime`,
  `report.smcTrigger`, e `report.smcRegime` (existia, nunca era impressa) —
  todas via `scripts/analyze-backtest.mjs`. Decisão de mudar algum
  threshold fica para depois, com este dado em mãos.
- **Proteção de stop pré-TP1** (`opExitRules.js:advancePreTp1StopProtection`
  + `scanner.js`, branch pré-TP1 de `persistScanResults`) — item 53/54,
  **`pineConfig.preTp1StopProtectionEnabled` desligado por padrão**. Achado
  que motivou: 61 de 117 operações de um backtest real ficaram positivas
  cedo (MFE médio +0,578R) e depois erodiram sem NENHUMA proteção
  intermediária até o `initial_stop` original (`advanceTrailingStop` só
  roda pós-TP1). Quando ligado, avança o stop pra breakeven (nunca além)
  uma vez que o preço se move a favor por `preTp1StopProtectionAtrMult ×
  ATR` (default 1.0×, múltiplo generoso de propósito — pesquisa de
  comunidade documenta whipsaw em breakeven prematuro). **Decisão congelada
  na CRIAÇÃO** (`pre_tp1_stop_protection_enabled`/
  `pre_tp1_stop_advance_trigger_atr_mult` na operação), lida da OPERAÇÃO no
  loop de saída, nunca do `pineConfig` ao vivo — mesmo raciocínio do
  runner (item 46): um flag virando no meio não pode abandonar/introduzir
  proteção numa posição já em andamento. Só em `persistScanResults` — igual
  a `advanceTrailingStop` e ao MFE/MAE, ausente de
  `priceCheckActiveOpsInner`. **Não ativar sem comparar relatórios de
  backtest com/sem primeiro** — ver `docs/known-risks.md` itens 53/54.
- **Retry na busca de candle ao vivo** (`src/lib/httpRetry.js`,
  `fetchWithRetry`) — item 57. Causa raiz confirmada do volume baixo de
  operações ao vivo: `src/lib/marketDataProvider.js` (browser) e
  `scripts/adminMarketDataProvider.js` (cron) faziam um único `fetch()` sem
  retry — uma falha transitória de rede (`"Failed to fetch"`, visto em
  produção) derrubava a busca de 1h/4h/5m/15m daquele ativo naquela passada
  inteira, sem segunda tentativa até o próximo scan. Mesmo padrão de retry
  (backoff exponencial, respeita `Retry-After`, só erro transitório) que já
  existia em `scripts/fetch-backtest-data.mjs` — por isso o backtest nunca
  via esse problema. Puro I/O: não toca gate, threshold nem transição de
  estado, só a confiabilidade do dado que alimenta todos eles.

## Regras ao mexer aqui

- **Não** introduza um terceiro caminho de mutação de op. Consolidar/serializar
  os dois loops é preferível a adicionar mais.
- Toda transição de estado deve ser **idempotente** e segura sob concorrência
  (guardar contra o status atual do banco, não só o lido em memória).
- Contagens baseadas em barra devem deduplicar por candle (timestamp), nunca por
  execução do scanner.
- Use **apenas candles fechados** (`onlyClosedCandles`) para decisão.
- Qualquer mudança aqui exige os testes de `.claude/rules/testing.md`
  (estado + concorrência + temporalidade) e, se tocar cálculo, paridade Pine
  (`.claude/rules/pine-parity.md`).
- **Nunca** adicione envio real de ordem (ver `.claude/rules/trading-safety.md`).
