// Janela de candles do scanner × valor REAL do TradingView (docs/known-risks.md item 307).
// O scanner calcula os indicadores só com os últimos N candles de cada timeframe (DEFAULT_CANDLE_LIMIT), enquanto o TradingView usa todo o histórico.
// EMA/MACD/Range Filter dependem do começo da série; com janela curta erram e algumas comparações (close>RF, EMA20>EMA50) viram o lado.
// Este teste usa os CSV REAIS do TradingView (BTCUSDT 4h e 1h) e prova que, com a janela PADRÃO do scanner, nenhuma dessas decisões muda.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateRangeFilter } from './indicators/rangeFilter.js';
import { calculateMACD } from './indicators/macd.js';
import { calculateEMAs } from './indicators/movingAverages.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'indicators/__fixtures__/golden');
const last = (a) => a[a.length - 1];

/** Lê a janela padrão direto do código-fonte do scanner (o teste não pode ficar desatualizado em relação ao valor real). */
function scannerDefaultWindow() {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'scanner.js'), 'utf8');
  const m = src.match(/const DEFAULT_CANDLE_LIMIT = (\d+);/);
  if (!m) throw new Error('DEFAULT_CANDLE_LIMIT não encontrado em scanner.js');
  return Number(m[1]);
}

function load(tf) {
  const L = readFileSync(path.join(DIR, `tv-export-btcusdt-${tf}.csv`), 'utf8').trim().split(/\r?\n/);
  const h = L[0].split(',');
  const rows = L.slice(1).map((l) => l.split(',')); rows.pop(); // última linha = barra ao vivo
  const col = (n) => h.indexOf(n);
  const candles = rows.map((r) => ({ openTime: Date.parse(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: 0, closeTime: 0, isClosed: true }));
  const tv = (n) => rows.map((r) => +r[col(n)]);
  return { candles, RF: tv('RF_FILT'), E20: tv('EMA_FAST'), E50: tv('EMA_SLOW'), MACD: tv('MACD'), SIG: tv('MACD_SIGNAL') };
}

/** Compara, nas últimas `n` barras, o cálculo com janela de `win` candles contra o valor real do TradingView. */
function flipsWithWindow(tf, win, n = 1000) {
  const { candles, RF, E20, E50, MACD, SIG } = load(tf);
  const flips = { closeAboveRF: 0, ema20AboveEma50: 0, macdAboveSignal: 0 };
  let maxRelRF = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const w = candles.slice(i - win + 1, i + 1);
    const e = calculateEMAs(w, 20, 50).series; const m = calculateMACD(w, 12, 26, 9).series;
    const rf = last(calculateRangeFilter(w, 20, 3.5).series.filterValues);
    const c = candles[i].close;
    if ((c > rf) !== (c > RF[i])) flips.closeAboveRF++;
    if ((last(e.shortEMA) > last(e.longEMA)) !== (E20[i] > E50[i])) flips.ema20AboveEma50++;
    if ((last(m.macdLine) > last(m.signalLine)) !== (MACD[i] > SIG[i])) flips.macdAboveSignal++;
    maxRelRF = Math.max(maxRelRF, Math.abs(rf - RF[i]) / Math.abs(RF[i]));
  }
  return { flips, maxRelRF };
}

describe('janela de candles do scanner × TradingView real (item 307)', () => {
  it('a janela padrão do scanner é de pelo menos 300 candles', () => {
    expect(scannerDefaultWindow()).toBeGreaterThanOrEqual(300);
  });

  for (const tf of ['4h', '1h']) {
    it(`${tf}: com a janela padrão, nenhuma comparação de decisão muda e o Range Filter erra < 1e-6 (relativo)`, () => {
      const { flips, maxRelRF } = flipsWithWindow(tf, scannerDefaultWindow());
      expect(flips).toEqual({ closeAboveRF: 0, ema20AboveEma50: 0, macdAboveSignal: 0 });
      expect(maxRelRF).toBeLessThan(1e-6);
    });
  }

  it('não-vacuidade: com 150 candles (a janela antiga) o erro do Range Filter é ordens de grandeza maior', () => {
    const { maxRelRF } = flipsWithWindow('4h', 150);
    expect(maxRelRF).toBeGreaterThan(1e-5);
  });
});
