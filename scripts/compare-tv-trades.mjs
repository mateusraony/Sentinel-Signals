// Compara a lista de negociações do Strategy Tester do TradingView com o relatório do backtest do Sentinel (docs/known-risks.md item 308).
// Uso: node scripts/compare-tv-trades.mjs --tv lista.csv --report backtest-report.json [--from "2025-02-03 00:00"] [--tolerance 0.002]
// Só LÊ arquivos. Não toca banco, rede nem Telegram.
import fs from 'node:fs';
import { parseTvTrades, compareTvToSentinel } from './tvParity.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

function main() {
  const tvFile = arg('tv');
  const reportFile = arg('report');
  if (!tvFile || !reportFile) {
    console.error('Uso: node scripts/compare-tv-trades.mjs --tv lista.csv --report backtest-report.json [--from "AAAA-MM-DD HH:mm"] [--tolerance 0.002]');
    process.exitCode = 1;
    return;
  }
  const { positions, tradeRows } = parseTvTrades(fs.readFileSync(tvFile, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const curve = report.overall?.curve || [];
  const from = arg('from', '');
  const r = compareTvToSentinel(positions, curve, { from, priceTolerance: Number(arg('tolerance', '0.002')) });
  console.log(`TradingView: ${tradeRows} negociações → ${positions.length} posições no total; comparadas ${r.tvPositions} (a partir de "${from || 'o começo'}").`);
  console.log(`Sentinel: ${r.sentinelOps} operações.`);
  console.log(`Mesma entrada (hora da barra + lado): ${r.sameEntry} · só no TradingView: ${r.onlyTv.length} · só no Sentinel: ${r.onlySentinel.length}`);
  console.log(`Mesma saída final (preço ±${(Number(arg('tolerance', '0.002')) * 100).toFixed(1)}%): ${r.sameExit} de ${r.sameEntry}`);
  console.log(`Soma do retorno por posição: TradingView ${r.tvPctSum.toFixed(1)}% · Sentinel ${r.sentinelPctSum.toFixed(1)}% (só as posições com a mesma entrada)`);
  if (Object.keys(r.byCause).length) {
    console.log('\nSaídas diferentes, por causa (TradingView × Sentinel):');
    for (const [k, v] of Object.entries(r.byCause)) console.log(`  ${v}×  ${k}`);
  }
  for (const d of r.differing) console.log(`  ${d.entryTime} ${d.side}: TV ${d.tvReason} ${d.tvExitTime} @${d.tvExitPrice} | Sentinel ${d.sentinelReason} ${d.sentinelExitTime} @${Math.round(d.sentinelExitPrice * 100) / 100}`);
  if (r.onlyTv.length) { console.log('\nSó no TradingView:'); for (const p of r.onlyTv) console.log(`  ${p.entryTime} ${p.side} @${p.entryPrice}`); }
  if (r.onlySentinel.length) { console.log('\nSó no Sentinel:'); for (const c of r.onlySentinel) console.log(`  ${c.op.candle_open_time} ${c.op.side} @${c.op.entry_price}`); }
}

main();
