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
  no mesmo candle). **Hardening (item 59, 2026-08-02)**: a proteção acima só
  cobria a ordem DENTRO de uma passagem — não excluía a vela do avanço de
  passagens SEGUINTES sobre a mesma vela ainda não fechada (o cron roda a
  cada ~5min; uma vela de 4h/1h pode ficar "a última fechada" por horas).
  Mesma classe de bug que o item 54 já tinha corrigido no pré-TP1
  (`pre_tp1_stop_advanced_candle_time`), nunca replicada aqui até esta
  rodada — `runner_stop_advanced_candle_time` fecha a mesma lacuna no
  trailing pós-TP1, já em produção. Review externa (Codex, PR #116) pegou
  uma 2ª lacuna: o marcador também precisava de proteção transacional
  contra um worker concorrente perdendo o `clampMonotonicStop` mas ainda
  sobrescrevendo o marcador com a própria vela (stale) — ver item 59
  addendum.
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
- **RF e SMC não são cascatas simétricas na prática, mesmo com o código
  tratando as duas como pares** (item 125 achado menor). RF (4h→15m) é o
  gerador ativo. SMC (1h→5m) está tecnicamente ativa em produção (opt-in
  por `MonitoredAsset.smc_enabled`) mas mede ~0 operações reais no mundo
  real — 93% das rejeições nunca chegam a avaliar o próprio gatilho
  (item 75, `no_trigger`). O Pine real do SMC (`docs/reference-pine/
  smc-a-unified-v2.3.pine`) nem é um `strategy()` — é um `indicator()` que só
  produz um score de confluência, nunca dispara operação sozinho; a cascata
  `1h_5m` é invenção própria do Sentinel, sem correspondência 1:1 no script
  real (item 77). A direção proposta (SMC como score/contexto sobre a RF
  nativa, não gerador independente) existe só como `pineConfig.
  smcAlignmentScoreEnabled`, backtest-only, desligado por padrão — não
  substituiu a cascata `1h_5m` em produção.
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

- **Alvo de medição: ESTREITAR O IC, não provar edge** (item 133,
  2026-08-27). `conclusive` é binário e aqui é quase sempre `false` — provar
  o edge medido (+0,026R) exigiria ~8.400 operações (~70 anos). A métrica de
  progresso é a **meia-largura do IC95**
  (`summarizeOps().expectancyRCI95HalfWidth`), que encolhe com √n exista edge
  ou não e responde "que vantagem esta amostra já descarta?".
  `tradesForCIHalfWidth(sd, alvo, deff)` dá o n necessário; `run-backtest`
  imprime o bloco "PODER DE DESCARTE" em todo run. **Sempre ingênuo** — a
  correção por cluster (`backtest-correlation-check.mjs`) costuma alargar
  neste projeto (DEFF medido de 0,08 a 1,43); nunca cite a meia-largura
  ingênua como se fosse a corrigida.

- **Teto de exposição de carteira** (`pineConfig.maxConcurrentSameSideOps`,
  item 133) — **BACKTEST-ONLY, `null` em produção**, com tripwire
  (`src/lib/portfolioSideCapTripwire.test.js`). Limita operações do MESMO
  LADO abertas ao mesmo tempo na carteira INTEIRA; `assetActiveOps` só
  garante 1 por ATIVO. Aplicado pelo wrapper `createTradeOpIfNoneActiveCapped`
  em `persistScanResults` (mesma assinatura do método do backend), fora de
  `createManualTradeOp` de propósito. Custo ZERO em produção: com o teto nulo
  nenhuma query extra é emitida. Ataca a variância ENTRE operações (o termo
  G/DEFF do item 110), não a variância POR operação que o item 132 já
  atacou. **MEDIDO (2026-08-28) e DESPRIORIZADO** — grade pré-registrada
  K=3/K=5 deu aceleração de 1,07×/1,00×, dentro da predição ("próximo de
  1"), muito longe dos 1,85× do item 132. Com só 7 símbolos, K=5 não bloqueou
  nenhuma operação em 11 meses (concorrência nunca chegou lá) e K=3 saturou
  sem sobrar sinal. Não eliminado — se o universo de símbolos crescer, a
  concorrência de carteira também cresce e o cálculo pode mudar.

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
  + `scanner.js`, branch pré-TP1 de `persistScanResults`) — item 53/54.
  `pineConfig.preTp1StopProtectionEnabled` é o interruptor MESTRE do bloco
  pré-TP1 inteiro (**LIGADO por padrão desde 2026-08-26**, item 132) — sem
  ele, nem o breakeven nem o trailing abaixo rodam. Achado que motivou: 61
  de 117 operações de um backtest real ficaram positivas cedo (MFE médio
  +0,578R) e depois erodiram sem NENHUMA proteção intermediária até o
  `initial_stop` original (`advanceTrailingStop` só roda pós-TP1). O modo
  em produção hoje é TRAILING, não breakeven — ver o bullet abaixo;
  `preTp1StopProtectionAtrMult` (default 1.0×) só tem efeito se o modo
  voltar a ser breakeven. **Decisão congelada na CRIAÇÃO**
  (`pre_tp1_stop_protection_enabled`/`pre_tp1_stop_advance_trigger_atr_mult`
  na operação), lida da OPERAÇÃO no loop de saída, nunca do `pineConfig` ao
  vivo — mesmo raciocínio do runner (item 46): um flag virando no meio não
  pode abandonar/introduzir proteção numa posição já em andamento (operações
  criadas ANTES de 2026-08-26 nasceram com o flag `false` e ficam sem
  nenhuma proteção pré-TP1 pra sempre — só operações novas herdam). Só em
  `persistScanResults` — igual a `advanceTrailingStop` e ao MFE/MAE, ausente
  de `priceCheckActiveOpsInner`.
- **Trailing pré-TP1 contínuo** (`opExitRules.js:advancePreTp1Trailing` +
  `favorableExtremeFromMfe`) — item 132, **`pineConfig.preTp1TrailEnabled`
  LIGADO por padrão desde 2026-08-26** (decisão do usuário, config A da
  grade pré-registrada: `start 1,0×ATR / trail 2,0×ATR`). Segundo modo do
  MESMO bloco pré-TP1, mutuamente exclusivo com o breakeven acima; qual
  roda é lido da OPERAÇÃO (`pre_tp1_stop_mode`, congelado na criação),
  nunca do `pineConfig` ao vivo. Não é recalibrar o breakeven: aquele é um
  salto binário que SATURA na entrada (protege muito por disparo, mas
  cortou 36% das que chegariam ao TP1 — item 55); este RATCHEIA com a
  volatilidade, ancorado no EXTREMO favorável desde a entrada, ficando mais
  longe do preço enquanto o movimento é jovem e continuando a subir depois.
  O extremo é **reconstruído de `mfe_r`** (item 47.2) em vez de um campo de
  pico novo — a inversa é exata porque `mfe_r` usa a distância do stop
  inicial como denominador. **O one-shot `pre_tp1_stop_advanced_at` só
  vale no modo breakeven** (que satura); o trailing precisa avançar a cada
  candle novo. **Medido** contra controle na mesma janela (120 vs. 103
  operações): expectância líquida indistinguível dentro do ruído
  (+0,0262R vs. +0,0257R, z=0,004 — não prova edge), sd(R) −35%, max
  drawdown pela metade (12,66% → 6,40%) — reduz o custo de medir um edge,
  não o gera. Ver `docs/known-risks.md` item 132 pra decomposição completa,
  inclusive a correção pós-review do Codex (aceleração real é 1,85×, não
  os 2,8× da 1ª leitura, e a config B ficou inconclusiva, não "morta").
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
- **Gate de padrão de vela** (`src/lib/indicators/candlePatterns.js`,
  `evaluateCandlePatternGate` ao lado de `evaluateRegime`) — item 58,
  **`pineConfig.candlePatternEnabled` desligado por padrão**. Pedido
  explícito do usuário: exige que o candle 4h que gerou o sinal também
  mostre um de 3 padrões válidos na direção do sinal — engolfo (corpo-a-
  corpo, candle anterior na cor oposta), pin bar/martelo-estrela-cadente
  (pavio dominante >= 2× o corpo) ou marubozu (corpo >= 90% do range) —
  checados nessa ordem de prioridade, combinados por OU. Camada A MAIS
  sobre a RF, nunca a substitui — deliberadamente não é "todos os padrões
  que existem" (decisão registrada no item 58: mais padrões testados no
  mesmo histórico curto é o problema de múltiplas comparações que a
  pesquisa de comunidade do próprio item alerta). Só cascata RF (4h→15m),
  nos mesmos 2 pontos de `evaluateRegime` (1ª passada e retry). Novo campo
  `results['4h'].last2Candles` (bounded slice de 2 candles fechados)
  alimenta o gate; sem equivalente no Pine real, sem obrigação de golden
  test. Auditoria em `TradeOperation.entry_candle_pattern`. **Não ativar
  sem comparar relatórios de backtest com/sem primeiro** — ver
  `docs/known-risks.md` item 58.

- **Horário real do evento vs. horário de detecção** (item 107) — todo
  `_at` de saída (`stop_hit_at`/`tp1_hit_at`/`tp2_hit_at`/`closed_at`) é o
  instante em que a PASSADA do scan detectou a condição, nunca o evento de
  mercado em si. Nos exits baseados em candle (`persistScanResults`, não
  `priceCheckActiveOpsInner`, que não tem candle pra referenciar), campos
  novos aditivos (`stop_hit_real_time`/`tp1_hit_real_time`/
  `tp2_hit_real_time`/`closed_at_real_time`) gravam um horário real ao lado
  do `_at` existente, sem substituí-lo — `TradeHistory.jsx` e os templates
  do Telegram (`src/lib/telegram.js` + `scripts/adminTelegram.js`, mesmo
  espelho manual de sempre) preferem o `_real_time` quando presente. Os
  dois pontos de `notify*` em `scanner.js` passam o `op` mesclado com o
  `updatePayload` recém-escrito (não mais o `op` pré-transição) — sem isso
  os campos novos nunca chegariam à notificação. **Precisão varia por
  campo** (Codex review, PR #213): stop/TP1/TP2 são avaliados contra
  HIGH/LOW intrabar, então `tfData.lastCandleTime` (fechamento do candle) é
  só um LIMITE SUPERIOR do cruzamento real, nunca o instante exato — UI/
  Telegram rotulam esses três como "vela" em vez de "horário real" pra não
  implicar precisão de tick. TIME_STOP dispara por idade em relógio, não
  por candle — usa o prazo calculado (`entryRef + timeStopBars × barMs`),
  não `lastCandleTime`. INVALIDATION/CHOP_EXIT são exatos (decisão é sobre
  o CLOSE do candle).

## Padrões de bug já redescobertos mais de uma vez (item 125 achado 5)

Três armadilhas que já custaram uma rodada de ablação cara pra descobrir —
registradas aqui pra não serem redescobertas do zero na próxima. Nenhuma das
três é um bug hoje (os 3 casos que as motivaram já foram corrigidos/
compreendidos); são propriedades estruturais de `pineConfig`/da cascata que
qualquer flag NOVO pode pisar sem aviso.

- **Acoplamento matemático entre parâmetros não documentado.** `tp1R`/
  `minRR` são matematicamente acoplados — um `tp1R` baixo demais pode violar
  `minRR` e zerar TODAS as operações silenciosamente, sem erro (item 116, só
  descoberto quando um teste real deu 0 operações e a causa raiz levou uma
  rodada pra achar). Antes de testar um novo valor de QUALQUER parâmetro que
  afete a relação risco/retorno (tp1R, tp2R, stop, minRR), verifique se ele
  interage matematicamente com outro gate — não assuma independência só
  porque são campos separados no config.
- **Flags "por cascata" nem sempre são exclusivos da cascata.** `useADX`/
  `useChop` são GLOBAIS (compartilhados por RF e SMC), não exclusivos da
  cascata RF onde foram introduzidos — ligar `smcTierEnabled` sem saber
  disso herda o estado desses dois pra SMC também, efeito colateral não
  óbvio pelo nome do flag (item 42). Ao introduzir um flag novo com nome
  "por cascata" (`smcXxxEnabled`, `rfXxxEnabled`), confirme explicitamente
  se ele lê algum parâmetro/threshold JÁ usado pela outra cascata antes de
  assumir isolamento.
- **Tautologia geométrica de gate compartilhando `closedCandles` com a
  função que ele filtra.** Já apareceu 2x em lugares DIFERENTES do código
  (itens 35/38, gate de zona PD da cascata SMC 1h→5m — 74/74 rompimentos
  rejeitados em 18,5 meses de BTCUSDT — e de novo no item 77, mecanismo
  novo, mesmo padrão): um gate que mede a posição de `close` contra um
  range/estrutura derivado do MESMO `closedCandles` que gerou o evento que
  ele está filtrando tende a rejeitar por construção geométrica, não por
  raridade estatística real — parece seletivo, mas é tautológico. Ao
  escrever um gate novo que compara preço contra estrutura recente, meça a
  distribuição do valor filtrado (mesmo método do item 35: histograma de
  `pdZone`/equivalente no momento do evento) ANTES de aceitar uma taxa de
  rejeição alta como "o gate está funcionando".

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
