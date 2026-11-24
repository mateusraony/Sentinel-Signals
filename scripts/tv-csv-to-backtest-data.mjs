// Converte o CSV "Export chart data" do TradingView em candles para o backtest local (docs/known-risks.md item 308).
// Uso: node scripts/tv-csv-to-backtest-data.mjs --symbol BTCUSDT --out DIR --csv-4h arquivo4h.csv [--csv-1h arquivo1h.csv]
// Grava SYMBOL_4h.json, SYMBOL_1d.json (agregado do 4h) e, se pedido, SYMBOL_1h.json em DIR. A última linha de cada CSV (barra ao vivo) é descartada.
// Não toca rede nem banco. A série de 15m/5m NÃO existe nesse CSV: use só com `skip15mConfirmationEnabled: true` (o simulador entra no fechamento da vela do sinal).
import fs from 'node:fs';
import path from 'node:path';
import { tvChartCsvToCandles, aggregateDailyFrom4h } from './tvParity.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function main() {
  const symbol = arg('symbol');
  const out = arg('out');
  const csv4h = arg('csv-4h');
  if (!symbol || !out || !csv4h) {
    console.error('Uso: node scripts/tv-csv-to-backtest-data.mjs --symbol BTCUSDT --out DIR --csv-4h arquivo4h.csv [--csv-1h arquivo1h.csv]');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(out, { recursive: true });
  const c4h = tvChartCsvToCandles(fs.readFileSync(csv4h, 'utf8'), 4 * 3600 * 1000);
  fs.writeFileSync(path.join(out, `${symbol}_4h.json`), JSON.stringify(c4h));
  const c1d = aggregateDailyFrom4h(c4h);
  fs.writeFileSync(path.join(out, `${symbol}_1d.json`), JSON.stringify(c1d));
  console.log(`4h: ${c4h.length} candles · 1d (agregado): ${c1d.length}`);
  const csv1h = arg('csv-1h');
  if (csv1h) {
    const c1h = tvChartCsvToCandles(fs.readFileSync(csv1h, 'utf8'), 3600 * 1000);
    fs.writeFileSync(path.join(out, `${symbol}_1h.json`), JSON.stringify(c1h));
    console.log(`1h: ${c1h.length} candles`);
  }
}

main();
