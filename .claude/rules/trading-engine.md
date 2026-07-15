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
- **[RESIDUAL — atacar junto com P0-c/d] Precedência stop>TP entre loops.** O
  CAS resolve a corrida de dados, mas quando os dois loops decidem transições
  DIFERENTES a partir do mesmo estado, "primeiro a commitar ganha" — não aplica
  a regra "stop tem prioridade" (hoje só intra-loop, `scanner.js:972`), e um
  `exit_price` pode ser gravado com stop defasado. Inseparável do candle de
  entrada retroativo (P0-c) e do trailing look-ahead (P0-d).
- **Candle de entrada retroativo.** O loop usa high/low do último candle fechado
  (`scanner.js:956-961`) sem comparar com `candle_close_time`/horário da entrada
  — o próprio candle de entrada pode "bater" TP/stop com movimento anterior à
  entrada. Falta guard temporal.
- **Trailing look-ahead.** O stop de trailing vem do `closePrice`
  (`scanner.js:1041-1046`) e é testado contra o high/low do MESMO candle
  (`:1049`).
- **`rf_reverse_bars_count` por scan, não por candle.** Incrementa `+1` por
  passada (`scanner.js:998`), não por candle único — cron 5min sobre sinal de 4h
  conta demais. (Mascarado só porque `useInvalidation` é `false` por default.)

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
