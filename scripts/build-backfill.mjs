// Bundles scripts/run-backfill-check.mjs into a single Node-runnable file —
// the retroactive backfill check (docs/known-risks.md item 137). A 6th
// redirect target alongside scan (4) and backtest (5), same technique
// (esbuild onResolve rewriting scanner.js's imports without touching
// scanner.js itself):
//   '@/api/entities'       → scripts/adminEntities.js            (REAL backend — a backfilled op is a real production TradeOperation)
//   './telegram'           → scripts/backtestTelegram.js         (no-op — replaying historical candle closes must never fire "live" Telegram alerts for events days/weeks old)
//   './pineParser'         → scripts/adminPineConfig.js          (REAL live strategyConfig/current — same settings production scanning uses right now)
//   './marketDataProvider' → scripts/backfillMarketDataProvider.js (live Binance REST, bounded recent window, not archive files)
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const backfillOverrides = {
  name: 'backfill-overrides',
  setup(b) {
    b.onResolve({ filter: /^@\/api\/entities$/ }, () => ({
      path: path.resolve(root, 'scripts/adminEntities.js'),
    }));
    b.onResolve({ filter: /^\.\/telegram$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'lib', 'scanner.js'))) {
        return { path: path.resolve(root, 'scripts/backtestTelegram.js') };
      }
    });
    b.onResolve({ filter: /^\.\/pineParser$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'lib', 'scanner.js'))) {
        return { path: path.resolve(root, 'scripts/adminPineConfig.js') };
      }
    });
    b.onResolve({ filter: /^\.\/marketDataProvider$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'lib', 'scanner.js'))) {
        return { path: path.resolve(root, 'scripts/backfillMarketDataProvider.js') };
      }
    });
  },
};

await build({
  entryPoints: [path.resolve(root, 'scripts/run-backfill-check.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.resolve(root, 'scripts/dist/run-backfill-check.mjs'),
  plugins: [backfillOverrides],
  external: ['firebase-admin', 'firebase-admin/*'],
  logLevel: 'info',
});
