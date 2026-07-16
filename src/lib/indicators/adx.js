/**
 * ADX / DMI — Average Directional Index (Wilder), igual ao ta.dmi do Pine.
 *
 * +DM/-DM/TR suavizados via RMA (período adxLen), +DI/-DI derivados,
 * DX = 100*|+DI - -DI|/(+DI + -DI), ADX = RMA(DX, adxSmooth).
 */
import { calculateTRSeries } from './atr';

function rma(series, period, startIndex) {
  const n = series.length;
  const out = new Array(n).fill(0);
  let seed = 0;
  for (let i = startIndex; i < startIndex + period; i++) seed += series[i];
  seed /= period;
  out[startIndex + period - 1] = seed;
  let value = seed;
  for (let i = startIndex + period; i < n; i++) {
    value = (value * (period - 1) + series[i]) / period;
    out[i] = value;
  }
  return out;
}

export function calculateADX(candles, period = 14, smoothing = 14) {
  const n = candles.length;
  if (n < period + smoothing + 1) {
    return { adx: 0, plusDI: 0, minusDI: 0 };
  }

  const tr = calculateTRSeries(candles);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }

  const rmaTR = rma(tr, period, 1);
  const rmaPlusDM = rma(plusDM, period, 1);
  const rmaMinusDM = rma(minusDM, period, 1);

  const dx = new Array(n).fill(0);
  const plusDISeries = new Array(n).fill(0);
  const minusDISeries = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!rmaTR[i]) continue;
    const plusDI = 100 * (rmaPlusDM[i] / rmaTR[i]);
    const minusDI = 100 * (rmaMinusDM[i] / rmaTR[i]);
    plusDISeries[i] = plusDI;
    minusDISeries[i] = minusDI;
    const sum = plusDI + minusDI;
    dx[i] = sum > 0 ? (100 * Math.abs(plusDI - minusDI)) / sum : 0;
  }

  const firstDxIndex = period; // rma(...) series only becomes non-zero from index `period` on (startIndex=1)
  const adxSeries = rma(dx, smoothing, firstDxIndex);

  const last = n - 1;

  return {
    adx: adxSeries[last] || 0,
    plusDI: plusDISeries[last],
    minusDI: minusDISeries[last],
    // Full per-bar series, same convention as the other indicators — used by
    // the golden parity tests; last-bar consumers above are unchanged.
    series: { adx: adxSeries, plusDI: plusDISeries, minusDI: minusDISeries },
  };
}
