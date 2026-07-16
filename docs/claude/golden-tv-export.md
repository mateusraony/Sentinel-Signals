# Padrão-ouro real: exportar o CSV do TradingView para os golden tests

Os golden tests (`src/lib/indicators/goldenParity.test.js`) já validam a
matemática dos indicadores com referências de convenção Pine. O **padrão-ouro
real** — comparar contra o que o SEU gráfico calculou de fato — ativa sozinho
quando você commitar um export oficial do TradingView. Requer plano **PRO+ ou
Premium** (o free não exporta; scraping viola os ToS e foi rejeitado).

## Passo a passo (uma vez por timeframe)

1. Abra o gráfico **BINANCE:BTCUSDT** (mercado **SPOT**, não perpétuo/futures —
   para casar com a fonte do cron `data-api.binance.vision`).
2. Timezone do gráfico: **UTC** (rodapé do gráfico → fuso).
3. Timeframe: **4h** (repita depois para **1h**).
4. Adicione um indicador Pine simples que plote as séries com ESTES títulos
   exatos (o teste casa por nome de coluna; plote só as que quiser comparar):

   ```pinescript
   //@version=6
   indicator("Sentinel Golden", overlay=false)
   plot(ta.rsi(close, 14),        title="RSI")
   plot(ta.atr(14),               title="ATR")
   plot(ta.ema(close, 20),        title="EMA_FAST")
   plot(ta.ema(close, 50),        title="EMA_SLOW")
   [macd, signal, _] = ta.macd(close, 12, 26, 9)
   plot(macd,                     title="MACD")
   plot(signal,                   title="MACD_SIGNAL")
   [_, _, adx] = ta.dmi(14, 14)
   plot(adx,                      title="ADX")
   // Choppiness (fórmula padrão):
   chop = 100 * math.log10(math.sum(ta.tr, 14) / (ta.highest(14) - ta.lowest(14))) / math.log10(14)
   plot(chop,                     title="CHOP")
   ```

   Para o Range Filter (`RF_FILT`), plote a variável de filtro do SEU Pine
   v13.2 (a linha central do Range Filter) com `title="RF_FILT"` — os
   parâmetros do painel são `rng_per=20`, `rng_qty=3.5`.

5. Menu do gráfico (⋯ no topo) → **"Export chart data…"** → marque incluir os
   dados do indicador → **UTC** → baixe o CSV.
6. Carregue **pelo menos ~400 barras** no gráfico antes de exportar (role o
   histórico para trás) — o teste descarta as 210 primeiras como warm-up.
7. Renomeie para `tv-export-btcusdt-4h.csv` (e `...-1h.csv`) e coloque em:

   ```
   src/lib/indicators/__fixtures__/golden/
   ```

8. Commite. Na próxima rodada de `npm test`, o bloco "padrão-ouro: CSV do
   TradingView" sai de `skipped` e compara barra a barra (pós warm-up,
   tolerância relativa+absoluta). A última linha do CSV é descartada
   automaticamente (pode ser a barra ao vivo, não fechada).

## Notas

- **Parâmetros devem casar**: RSI 14 · ATR 14 · EMA 20/50 · MACD 12/26/9 ·
  ADX 14/14 · CHOP 14 · RF 20/3.5. Se o seu Pine usar outros valores, ajuste o
  plot (não o teste).
- Se alguma série divergir além da tolerância fora do warm-up, o teste falha
  apontando a barra exata — abra uma sessão com a skill `sentinel-pine-parity`
  para investigar (seed/suavização/fonte de dados são os suspeitos usuais).
- Alternativa/complemento sem plano pago: spot check manual de ~10 barras no
  Data Window (free) e/ou congelar candles reais rodando localmente
  `node scripts/fetch-golden-fixture.mjs BTCUSDT 4h 500` (a rede deste
  container de sessões bloqueia a Binance; a sua máquina não).
