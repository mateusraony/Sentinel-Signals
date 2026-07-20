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

## Golden tests (método adotado — `goldenParity.test.js`)

Definido por pesquisa de comunidade (fontes no PR que o introduziu):

- **Consistência série×prefixo**: valor da barra i na série completa ==
  calculado só com candles 0..i (é o que a produção faz por scan; divergência
  = look-ahead). Cobre RF, RSI, MACD, EMA, ATR, ADX.
- **Referência cruzada convenção Pine** (`__fixtures__/pineRef.js`, test-only):
  RMA/Wilder seed=SMA p/ RSI/ATR/ADX; fórmula fechada p/ Choppiness. Comparar
  **pós warm-up de ~6× o período** (consenso: EMA/RMA nunca converge exato com
  histórico diferente) com tolerância `max(atol, rtol·|ref|)` — osciladores
  0–100: atol 0.05; séries de preço: rtol 1e-3.
- **Seed da EMA**: o port seeda com o 1º valor; o teste PROVA que pós warm-up a
  escolha do seed é irrelevante (<1e-3 relativo) — medido, não é problema na
  profundidade de produção. Veredito final vem do CSV real do TradingView.
- **SMC (BOS/CHoCH/sweep/PD)**: validar por **eventos + não-repaint** (evento
  na barra N idêntico com dados até N e com o dataset completo; barras
  fechadas imutáveis) — nunca por floats.
- **Padrão-ouro real**: CSV oficial do TradingView do usuário em
  `__fixtures__/golden/tv-export-*.csv` ativa o bloco de comparação contra o
  Pine real (procedimento em `docs/claude/golden-tv-export.md`; exige plano
  pago; scraping viola ToS — rejeitado). Fixture de candles reais opcional via
  `scripts/fetch-golden-fixture.mjs` (rodar na máquina do usuário — a rede das
  sessões bloqueia a Binance).
- **Âncora com valores reais do TV** (`tvSpotCheck.test.js`): 4 barras spot
  4h (BTC/ETH/PENDLE/FET) transcritas de prints da Data Window do usuário
  (2026-07-18) — 31/32 valores na precisão exibida; exceção documentada
  (ADX do PENDLE, ~0,6%). Novo spot check = novos casos nesse arquivo.

## Regras ao tocar cálculo

- Rodar/estender os golden tests acima antes de dar por pronto; novo indicador
  = nova entrada em cada camada aplicável (prefixo, referência, CSV).
- Nuance ainda aberta (não é bug): contagem do Time Stop por tempo decorrido vs
  contador de barras do Pine; `swing_len` da cascata SMC sem equivalente direto.
- **A janela de candles buscada por scan importa para SMC, não só o cálculo.**
  `calculateStructure` é path-dependent (sem estado entre scans) — com
  `swingLen=50` (default real do Pine), uma janela curta demais silencia
  BOS/CHoCH quase por completo (medido, `docs/known-risks.md` item 34). Ao
  ajustar qualquer parâmetro dessa cascata, considere também quantos candles
  o `fetchCandles` daquele timeframe está buscando — não é só o cálculo do
  indicador que precisa de paridade, é o histórico disponível pra ele rodar.
- Só candles fechados. Não misture convenção de índice (barra atual vs anterior)
  sem checar o Pine correspondente.
- Paridade ≠ taxa de acerto: corrigir paridade aproxima do TradingView, não torna
  a estratégia lucrativa.
