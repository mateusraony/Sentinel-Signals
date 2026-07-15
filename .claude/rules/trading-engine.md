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
  `src/lib/opExitRules.js`, comparando `tfData.lastCandleTime` com
  `op.candle_close_time`). Ops legadas sem `candle_close_time` mantêm o
  comportamento antigo (fallback explícito). O price-check por preço spot cobre
  o intervalo ao vivo — sem buraco de proteção.
- **[CORRIGIDO — P0-d] Trailing look-ahead.** As saídas do runner são avaliadas
  contra o stop ARMAZENADO; o avanço do trailing (`advanceTrailingStop`) só
  acontece depois, do fechamento, e passa a proteger no candle SEGUINTE. O
  `exit_price` de stop do runner agora usa o stop armazenado (nunca o avançado
  no mesmo candle).
- **[CORRIGIDO — P0-e] `rf_reverse_bars_count` por candle.** Deduplicado por
  `rf_reverse_last_candle` (`nextRfReverseCount`) — N passadas do cron sobre o
  mesmo candle contam 1x; reset quando o RF volta a favor; fallback por-passada
  se o feed não trouxer timestamp.
- **[RESIDUAL — aguardando dados] Precedência stop>TP entre loops.** O CAS
  resolve a corrida de dados; com P0-c/d corrigidos, o cenário grave (TP1
  retroativo vencendo stop real) deixou de existir. O que resta — dois loops
  decidindo transições legítimas diferentes no mesmo instante — é raro e agora
  **observável**: toda transição descartada pelo CAS gera `logWarn` em
  `SystemLog` ("Transição descartada pelo CAS"). Só investir numa regra dura de
  precedência (stop autoritativo entre loops) se os logs mostrarem ocorrência
  real.

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
