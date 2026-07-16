// Implementações de REFERÊNCIA (test-only) seguindo as convenções documentadas
// do Pine Script v5/v6, escritas de forma independente do código de produção —
// direto das fórmulas publicadas — para servir de referência cruzada nos
// golden tests (goldenParity.test.js). NUNCA importar em código de produção.
//
// Convenções (fontes na pesquisa registrada no PR / .claude/rules/pine-parity.md):
// - ta.rma (Wilder): alpha = 1/n, seed = SMA das primeiras n amostras
//   (https://www.tradingcode.net/tradingview/relative-moving-average/).
// - ta.ema: alpha = 2/(n+1); o valor inicial deriva do primeiro valor não-na.
//   O seed exato do gráfico real só é observável no export do TradingView —
//   por isso o teste MEDE a sensibilidade ao seed em vez de afirmá-la.
// - ta.rsi: RMA de ganhos/perdas (Wilder).
// - ta.atr: RMA do True Range.
// - ta.dmi/ADX: +DM/-DM Wilder, DI = 100*RMA(DM)/RMA(TR),
//   DX = 100*|+DI - -DI|/(+DI + -DI), ADX = RMA(DX, smoothing).
// - Choppiness: 100*log10(sum(TR,n)/(maxHigh(n)-minLow(n)))/log10(n).

export function smaRef(values, n) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// RMA (Wilder) com seed = SMA das primeiras n amostras, posicionado em n-1.
export function rmaRef(values, n) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < n) return out;
  let seed = 0;
  for (let i = 0; i < n; i++) seed += values[i];
  seed /= n;
  out[n - 1] = seed;
  let v = seed;
  for (let i = n; i < values.length; i++) {
    v = (v * (n - 1) + values[i]) / n;
    out[i] = v;
  }
  return out;
}

// EMA com seed configurável: 'first' (1º valor — convenção do port atual)
// ou 'sma' (SMA das primeiras n amostras — convenção RMA-like).
export function emaRef(values, n, seedMode = 'first') {
  const out = new Array(values.length).fill(NaN);
  if (values.length === 0) return out;
  const k = 2 / (n + 1);
  let start = 0;
  if (seedMode === 'sma') {
    if (values.length < n) return out;
    let seed = 0;
    for (let i = 0; i < n; i++) seed += values[i];
    out[n - 1] = seed / n;
    start = n;
  } else {
    out[0] = values[0];
    start = 1;
  }
  for (let i = start; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

export function trRef(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

export function atrRef(candles, n) {
  return rmaRef(trRef(candles), n);
}

export function rsiRef(closes, n) {
  const gains = new Array(closes.length).fill(0);
  const losses = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  // Pine seeda a RMA a partir da 1ª variação (índice 1) — replicamos usando
  // as séries a partir do índice 1 e realinhando.
  const g = rmaRef(gains.slice(1), n);
  const l = rmaRef(losses.slice(1), n);
  const out = new Array(closes.length).fill(NaN);
  for (let i = 0; i < g.length; i++) {
    if (Number.isNaN(g[i]) || Number.isNaN(l[i])) continue;
    out[i + 1] = l[i] === 0 ? 100 : 100 - 100 / (1 + g[i] / l[i]);
  }
  return out;
}

export function adxRef(candles, n, smoothing) {
  const len = candles.length;
  const tr = trRef(candles);
  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  // Séries começam na 1ª variação (índice 1), como no DMI clássico.
  const rTR = rmaRef(tr.slice(1), n);
  const rPlus = rmaRef(plusDM.slice(1), n);
  const rMinus = rmaRef(minusDM.slice(1), n);
  const dx = new Array(rTR.length).fill(NaN);
  const plusDI = new Array(len).fill(NaN);
  const minusDI = new Array(len).fill(NaN);
  for (let i = 0; i < rTR.length; i++) {
    if (Number.isNaN(rTR[i]) || rTR[i] === 0) continue;
    const p = (100 * rPlus[i]) / rTR[i];
    const m = (100 * rMinus[i]) / rTR[i];
    plusDI[i + 1] = p;
    minusDI[i + 1] = m;
    const s = p + m;
    dx[i] = s > 0 ? (100 * Math.abs(p - m)) / s : 0;
  }
  const firstDx = dx.findIndex((v) => !Number.isNaN(v));
  const adxCore = rmaRef(dx.slice(firstDx), smoothing);
  const adx = new Array(len).fill(NaN);
  for (let i = 0; i < adxCore.length; i++) {
    if (!Number.isNaN(adxCore[i])) adx[i + firstDx + 1] = adxCore[i];
  }
  return { adx, plusDI, minusDI };
}

export function chopRef(candles, n) {
  const tr = trRef(candles);
  const out = new Array(candles.length).fill(NaN);
  for (let i = n - 1; i < candles.length; i++) {
    let sumTR = 0;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      sumTR += tr[j];
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    const range = hh - ll;
    out[i] = range <= 0 ? 50 : (100 * Math.log10(sumTR / range)) / Math.log10(n);
  }
  return out;
}
