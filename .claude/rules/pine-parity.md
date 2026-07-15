---
description: Paridade entre o Pine Script (TradingView) e a implementação JS dos indicadores. Carregue ao mexer em pineParser, indicadores ou config de estratégia.
paths:
  - src/lib/pineParser.js
  - src/lib/indicators/**
  - scripts/adminPineConfig.js
---

# Paridade Pine × JavaScript

O scanner replica um Pine real do usuário ("NEW ERA - Range Filter Strategy
v13.2" e a cascata SMC "SMC+A Unified v2.3"). Divergência de implementação =
divergência entre o painel e o TradingView.

## Config sincronizada (dois lugares espelhados à mão)

`src/lib/pineParser.js` (browser) e `scripts/adminPineConfig.js` (cron) mantêm um
par `DEFAULTS`/`SYNCED_STRATEGY_KEYS`. Ambos leem `strategyConfig/current` do
Firestore (escrito pela página Pine Script via `syncPineToAssets`). **Ao
adicionar um parâmetro sincronizado, adicione-o nos DOIS arquivos.**
`rf_period`/`rf_multiplier` não entram aqui — são por-ativo em `MonitoredAsset`.

## Regras ao tocar cálculo

- **Golden tests barra a barra** contra candles conhecidos do TradingView antes
  de dar por pronto: Range Filter, RSI, MACD, EMA, ATR, ADX, Choppiness, Tier,
  score, BOS/CHoCH, sweep, zona Premium/Discount, sinal final.
- Pontos ainda **não** validados numericamente (não são bugs, são nuances —
  known-risks 8/9): seeding da EMA no Range Filter, suavização ADX/DMI, contagem
  do Time Stop por tempo decorrido vs contador de barras do Pine, `swing_len` da
  cascata SMC.
- Só candles fechados. Não misture convenção de índice (barra atual vs anterior)
  sem checar o Pine correspondente.
- Paridade ≠ taxa de acerto: corrigir paridade aproxima do TradingView, não torna
  a estratégia lucrativa.
