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
(dados insuficientes, candles planos).

## Lacunas prioritárias (atacar junto com os P0)

- **Máquina de estados**: todas as transições válidas e a proibição de sair de
  estado terminal (ver transições em `.claude/rules/trading-engine.md`).
- **Concorrência**: múltiplos workers na mesma op → uma única transição, uma
  única notificação, uma única op ativa por ativo.
- **Temporalidade**: candle anterior à entrada, candle de entrada, gap, stop e TP
  no mesmo candle, trailing criado no fechamento, scans perdidos, replay de
  candles intermediários.
- **Paridade Pine×JS** (golden tests): ver `.claude/rules/pine-parity.md`.

## Convenções

- Vitest reaproveita `vite.config.js` — não crie config separada.
- Teste a **função pura** sempre que possível (indicadores, transição de estado
  isolada) antes de testar o loop inteiro.
- Novo bug corrigido = novo teste que reproduz o bug (falhava antes, passa
  depois).
