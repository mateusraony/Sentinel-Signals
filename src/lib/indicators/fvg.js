// Fair Value Gap (FVG / imbalance) — Fase 4 (docs/known-risks.md item 43).
// Porte da lógica de `_detect_fvg_object`/`FVG.update` do Pine real do usuário
// ("SMC+A Unified v2.3", docs/reference-pine/) — a parte de FVG é portável na
// íntegra: não depende de perfil de volume nem de desenho de gráfico, ao
// contrário do Order Block (ver orderBlock.js).
//
// Divergência DELIBERADA e registrada (item 43): o Pine acumula FVGs num array
// `var` desde o início do gráfico, sem limite de idade. Aqui não há estado
// entre scans (mesma premissa de todo smcStructure.js), então a varredura é
// limitada a uma janela `lookback` — um FVG de centenas de barras atrás não é
// nem barato de achar nem informativo. Não é falha de paridade.
//
// No I/O, sem Date.now(), sem estado — recalculado do zero a cada scan.
// `sizeThreshold` chega PRONTO do chamador (atrValue * mult), mesma convenção
// de retest.js/displacement.js, que também não calculam ATR internamente.

/**
 * Procura o FVG mais recente AINDA NÃO PREENCHIDO na direção pedida.
 *
 * Convenção de índice: `candles` é crescente (0 = mais antigo, n-1 = mais
 * recente), enquanto o Pine usa [0]=atual e [2]=duas barras atrás. Para um FVG
 * cuja TERCEIRA vela está no índice `i`:
 *   BUY  (`low[0] - high[2]`): gapLow = candles[i-2].high, gapHigh = candles[i].low
 *   SELL (`low[2] - high[0]`): gapLow = candles[i].high,   gapHigh = candles[i-2].low
 * Nos dois casos o gap existe quando `gapHigh - gapLow > sizeThreshold`.
 *
 * @param {Array<{open:number,high:number,low:number,close:number}>} candles
 * @param {Object} params
 * @param {'BUY'|'SELL'} params.direction
 * @param {number} params.sizeThreshold - tamanho mínimo do gap (ATR × mult)
 * @param {number} [params.fillTargetRatio=0.6] - fração do gap que, uma vez
 *   ultrapassada por um FECHAMENTO posterior, marca o FVG como preenchido
 *   (0.6 = o default real do Pine, `fvg_fill_target_ratio = 60/100` — não é
 *   preenchimento total nem 50%).
 * @param {number} [params.lookback=60] - quantas velas para trás procurar.
 * @returns {{active:boolean, gapHigh:number|null, gapLow:number|null,
 *   gapSize:number|null, fillTargetLevel:number|null, barsAgo:number|null,
 *   reason:string|null}}
 */
export function detectFvg(candles, { direction, sizeThreshold, fillTargetRatio = 0.6, lookback = 60 }) {
  const none = {
    active: false, gapHigh: null, gapLow: null, gapSize: null,
    fillTargetLevel: null, barsAgo: null, reason: null,
  };

  if (direction !== 'BUY' && direction !== 'SELL') return { ...none, reason: 'invalid_params' };
  if (sizeThreshold == null || !(sizeThreshold >= 0)) return { ...none, reason: 'invalid_params' };
  if (fillTargetRatio == null || fillTargetRatio < 0 || fillTargetRatio > 1) {
    return { ...none, reason: 'invalid_params' };
  }
  if (!Array.isArray(candles) || candles.length < 3) return { ...none, reason: 'no_candles' };

  const n = candles.length;
  const isBuy = direction === 'BUY';
  // A terceira vela do FVG mais recente possível é a última fechada (n-1); a
  // mais antiga que a janela permite ainda precisa ter i-2 >= 0.
  const oldest = Math.max(2, n - lookback);

  for (let i = n - 1; i >= oldest; i--) {
    const near = candles[i];
    const far = candles[i - 2];
    const gapLow = isBuy ? far.high : near.high;
    const gapHigh = isBuy ? near.low : far.low;
    const gapSize = gapHigh - gapLow;
    if (!(gapSize > sizeThreshold)) continue;

    const fillTargetLevel = isBuy
      ? gapHigh - fillTargetRatio * gapSize
      : gapLow + fillTargetRatio * gapSize;

    // Preenchimento pelo FECHAMENTO (LevelBreakMode.CLOSE, o modo usado na
    // chamada real do Pine) — um pavio que entra no gap mas fecha fora NÃO
    // preenche. Só velas POSTERIORES à formação contam: no Pine, `update()`
    // roda antes do push do FVG novo, então a própria vela que forma o gap
    // nunca o preenche.
    let filled = false;
    for (let j = i + 1; j < n; j++) {
      if (isBuy ? candles[j].close < fillTargetLevel : candles[j].close > fillTargetLevel) {
        filled = true;
        break;
      }
    }
    if (filled) continue;

    return {
      active: true,
      gapHigh,
      gapLow,
      gapSize,
      fillTargetLevel,
      barsAgo: n - 1 - i,
      reason: null,
    };
  }

  return { ...none, reason: 'no_unfilled_gap' };
}
