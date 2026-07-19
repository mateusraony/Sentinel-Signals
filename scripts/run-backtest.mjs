// CLI entry point for the historical backtest (see
// docs/claude/backtest-usage.md for the full local-only flow). Bundled with
// esbuild (scripts/build-backtest.mjs) before running — see that file for
// why a plain `node scripts/run-backtest.mjs` won't work directly (same
// reason as scripts/run-scan.mjs).
//
// Usage:
//   node scripts/dist/run-backtest.mjs \
//     --symbols BTCUSDT,ETHUSDT \
//     --from 2026-01-01T00:00:00Z --to 2026-06-01T00:00:00Z \
//     [--data-dir scripts/__fixtures__/backtest] \
//     [--smc BTCUSDT] [--pine-config ./my-pine-overrides.json] \
//     [--step-ms 900000] [--out ./backtest-report.json]
import fs from 'node:fs';
import { runBacktest } from '../src/lib/backtestEngine.js';
import { backend } from '@/api/entities';
import { setPineConfigOverrides } from './backtestPineConfig.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i++;
  }
  return args;
}

function makeAsset(symbol, { smcSymbols, rfPeriod, rfMultiplier }) {
  const smcEnabled = smcSymbols.has(symbol);
  return {
    id: symbol,
    symbol,
    display_name: symbol,
    is_active: true,
    timeframes_enabled: { '1h': true, '4h': true, '1d': true },
    rf_period: rfPeriod,
    rf_multiplier: rfMultiplier,
    // Off by default here (unlike AddAssetForm.jsx's live default for NEW
    // real assets) — a backtest asset list is explicit CLI input, not a
    // panel action, so it stays opt-in via --smc rather than silently
    // inheriting the live-panel default.
    smc_enabled: smcEnabled,
    smc_confirm_4h15m: smcEnabled,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.symbols || !args.from || !args.to) {
    console.error('Uso: run-backtest.mjs --symbols SYM1,SYM2 --from ISO --to ISO [--data-dir DIR] [--smc SYM1,SYM2] [--pine-config FILE] [--step-ms N] [--out FILE]');
    process.exitCode = 1;
    return;
  }

  if (args['data-dir']) process.env.BACKTEST_DATA_DIR = args['data-dir'];

  if (args['pine-config']) {
    const overrides = JSON.parse(fs.readFileSync(args['pine-config'], 'utf-8'));
    setPineConfigOverrides(overrides);
  }

  const symbols = String(args.symbols).split(',').map((s) => s.trim()).filter(Boolean);
  const smcSymbols = new Set(String(args.smc || '').split(',').map((s) => s.trim()).filter(Boolean));
  const rfPeriod = args['rf-period'] ? Number(args['rf-period']) : 20;
  const rfMultiplier = args['rf-multiplier'] ? Number(args['rf-multiplier']) : 3.5;
  const assets = symbols.map((symbol) => makeAsset(symbol, { smcSymbols, rfPeriod, rfMultiplier }));

  const fromMs = new Date(args.from).getTime();
  const toMs = new Date(args.to).getTime();
  const stepMs = args['step-ms'] ? Number(args['step-ms']) : undefined;

  console.log(`[backtest] ${symbols.join(', ')} de ${new Date(fromMs).toISOString()} a ${new Date(toMs).toISOString()}`);

  const started = Date.now();
  let lastLoggedPct = -1;
  const report = await runBacktest({
    assets, backend, fromMs, toMs, stepMs,
    onStep(t, err) {
      if (err) {
        console.warn(`[backtest] ${err.asset} falhou em ${new Date(t).toISOString()}: ${err.error}`);
        return;
      }
      const pct = Math.floor(((t - fromMs) / (toMs - fromMs)) * 100);
      if (pct >= lastLoggedPct + 10) {
        lastLoggedPct = pct;
        console.log(`[backtest] ${pct}% (${new Date(t).toISOString()})`);
      }
    },
  });

  console.log(`[backtest] concluído em ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`[backtest] total de operações: ${report.totalOps} (ainda abertas no corte: ${report.stillOpenAtCutoff})`);
  console.log('[backtest] geral:', report.overall);
  for (const [cascade, summary] of Object.entries(report.byCascade)) {
    console.log(`[backtest] cascata ${cascade}:`, summary);
  }

  const outPath = args.out || 'backtest-report.json';
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`[backtest] relatório completo salvo em ${outPath}`);
}

main().catch((err) => {
  console.error('[backtest] FALHOU:', err);
  process.exitCode = 1;
});
