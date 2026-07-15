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

## Riscos P0 confirmados no código — trate antes de features novas

- **Escrita não-transacional de `status`.** Ambos os loops fazem
  read-modify-write (`TradeOperation.update(op.id, {status})`) sem transação nem
  compare-and-set contra o status atual no banco (`scanner.js:1087` e `:1217`).
- **Locks diferentes.** `persistScanResults` roda sob o lock do full-scan;
  `priceCheckActiveOps` usa um lock separado `'price-check'` (`scanner.js:1147`)
  → os dois podem rodar concorrentes e sobrescrever a mesma op (lost update,
  regressão de estado, transição a partir de terminal, notificação duplicada).
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
