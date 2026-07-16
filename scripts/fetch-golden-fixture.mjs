// Baixa candles FECHADOS da Binance Spot (data-api.binance.vision — a mesma
// fonte que o cron 24/7 usa) e congela como fixture JSON para os golden tests
// de paridade (src/lib/indicators/goldenParity.test.js).
//
// Uso (manual, NUNCA no CI — a fixture é congelada e versionada para o teste
// ser determinístico e offline):
//   node scripts/fetch-golden-fixture.mjs [SYMBOL] [INTERVAL] [LIMIT]
//   node scripts/fetch-golden-fixture.mjs BTCUSDT 4h 500
//
// Regrave a fixture só de propósito (ex.: trocar o período de referência) —
// e, ao regravar, os vetores esperados de um eventual CSV do TradingView
// precisam ser re-exportados para o MESMO intervalo de datas.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://data-api.binance.vision/api/v3';
const symbol = (process.argv[2] || 'BTCUSDT').toUpperCase();
const interval = process.argv[3] || '4h';
const limit = Number(process.argv[4] || 500);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src/lib/indicators/__fixtures__/golden');

const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
if (!res.ok) {
  console.error(`Binance respondeu ${res.status} ${res.statusText}`);
  process.exit(1);
}
const raw = await res.json();

// Mesmo shape de normalizeCandles (src/lib/marketDataProvider.js) + só fechados.
const now = Date.now();
const candles = raw
  .map((c) => ({
    openTime: c[0],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
    closeTime: c[6],
    isClosed: now > c[6],
  }))
  .filter((c) => c.isClosed);

const fixture = {
  meta: {
    source: `${BASE}/klines`,
    symbol,
    interval,
    count: candles.length,
    firstOpenTime: new Date(candles[0].openTime).toISOString(),
    lastCloseTime: new Date(candles[candles.length - 1].closeTime).toISOString(),
    fetchedAt: new Date().toISOString(),
    note: 'Candles SPOT congelados p/ golden tests — mesma fonte do cron. Não regravar sem motivo.',
  },
  candles,
};

mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${symbol}_${interval}.json`);
writeFileSync(outFile, JSON.stringify(fixture));
console.log(`OK: ${candles.length} candles fechados → ${path.relative(root, outFile)}`);
console.log(`Intervalo: ${fixture.meta.firstOpenTime} → ${fixture.meta.lastCloseTime}`);
