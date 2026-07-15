---
name: sentinel-state-machine-test
description: Escrever/rodar testes da máquina de estados de operações, de concorrência e de temporalidade do Sentinel. Use quando precisar cobrir transições de TradeOperation, cenários de múltiplos workers, ou casos de candle (entrada, gap, stop+TP no mesmo candle, trailing no fechamento). Não use para testes de indicador puro (use sentinel-pine-parity) nem para UI.
---

# sentinel-state-machine-test

## Quando usar
Cobrir com testes: transições de estado, concorrência entre os dois loops,
temporalidade de candles. Antes/depois de mexer no motor.

## Quando NÃO usar
Teste de indicador puro (`sentinel-pine-parity`); UI.

## Arquivos relevantes
`src/lib/scanner.js`, `src/lib/indicators/*.test.js` (padrão Vitest),
`.claude/rules/testing.md`, `.claude/rules/trading-engine.md`.

## Procedimento
1. Preferir extrair/expor a **função pura** de transição para testar sem
   Firestore; se não der, mockar o adaptador `backend`.
2. Cobrir transições válidas: `SIGNAL_CONFIRMED→RUNNER_ACTIVE`,
   `SIGNAL_CONFIRMED→STOP_HIT`, `RUNNER_ACTIVE→TP2_HIT`, `RUNNER_ACTIVE→STOP_HIT`,
   `RUNNER_ACTIVE→INVALIDATED`, e **terminal→(nenhuma)**.
3. Concorrência: simular dois workers na mesma op → uma transição, uma
   notificação, uma op ativa por ativo.
4. Temporalidade: candle pré-entrada, candle de entrada, gap, stop+TP no mesmo
   candle, trailing criado no fechamento, scans perdidos, replay intermediário.
5. `npm test` verde.

## Critérios de sucesso
Cada cenário acima tem teste determinístico; um teste que reproduz cada P0
relevante antes da correção correspondente.

## Testes obrigatórios
Os desta skill são o próprio entregável.

## Limites de permissão
Só adiciona testes/refatoração mínima p/ testabilidade. Não altera comportamento
de trading nesta skill. Não push/PR sem pedido.
