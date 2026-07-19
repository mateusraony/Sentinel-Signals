// Bundles scripts/run-backtest.mjs (which imports src/lib/scanner.js
// verbatim, via src/lib/backtestEngine.js) into a single Node-runnable file.
// Same reasoning as scripts/build-scan.mjs (scanner.js's "@/" alias and
// extension-less imports need Node-compatible resolution) and the same
// technique: redirect four imports to backtest-specific Node adapters
// without touching scanner.js itself — a 5th redirect target alongside the
// cron's four, not a new code path:
//   '@/api/entities'       → scripts/backtestEntities.js         (in-memory fake backend, real CAS logic)
//   './telegram'           → scripts/backtestTelegram.js         (no-op — a replay must never spam Telegram)
//   './pineParser'         → scripts/backtestPineConfig.js       (static config, CLI-overridable, no Firestore)
//   './marketDataProvider' → scripts/backtestMarketDataProvider.js (reads candles from local JSON, not Binance)
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const backtestOverrides = {
  name: 'backtest-overrides',
  setup(b) {
    b.onResolve({ filter: /^@\/api\/entities$/ }, () => ({
      path: path.resolve(root, 'scripts/backtestEntities.js'),
    }));
    b.onResolve({ filter: /^\.\/telegram$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'lib', 'scanner.js'))) {
        return { path: path.resolve(root, 'scripts/backtestTelegram.js') };
      }
    });
    b.onResolve({ filter: /^\.\/pineParser$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'lib', 'scanner.js'))) {
        return { path: path.resolve(root, 'scripts/backtestPineConfig.js') };
      }
    });
    b.onResolve({ filter: /^\.\/marketDataProvider$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'lib', 'scanner.js'))) {
        return { path: path.resolve(root, 'scripts/backtestMarketDataProvider.js') };
      }
    });
  },
};

await build({
  entryPoints: [path.resolve(root, 'scripts/run-backtest.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.resolve(root, 'scripts/dist/run-backtest.mjs'),
  plugins: [backtestOverrides],
  logLevel: 'info',
});
