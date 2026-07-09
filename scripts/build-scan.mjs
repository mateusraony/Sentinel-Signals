// Bundles scripts/run-scan.mjs (which imports src/lib/scanner.js verbatim)
// into a single Node-runnable file for the scheduled GitHub Actions job.
//
// Why bundle at all: scanner.js's imports use the Vite "@/" alias and
// extension-less relative paths ("./marketDataProvider") that Node's native
// ESM loader can't resolve on its own — Vite/esbuild resolve those, Node
// doesn't. Bundling also lets us redirect four imports to Node-compatible
// versions without touching scanner.js itself, so the exact same scanning
// logic runs in the browser and in this cron job:
//   '@/api/entities'      → scripts/adminEntities.js          (firebase-admin, not the browser SDK)
//   './telegram'          → scripts/adminTelegram.js          (env-var secrets, not localStorage)
//   './pineParser'        → scripts/adminPineConfig.js        (reads strategyConfig/current via Admin SDK)
//   './marketDataProvider' → scripts/adminMarketDataProvider.js (Binance Spot — Futures 451s from US datacenters)
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const adminOverrides = {
  name: 'admin-overrides',
  setup(b) {
    b.onResolve({ filter: /^@\/api\/entities$/ }, () => ({
      path: path.resolve(root, 'scripts/adminEntities.js'),
    }));
    b.onResolve({ filter: /^\.\/telegram$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'lib', 'scanner.js'))) {
        return { path: path.resolve(root, 'scripts/adminTelegram.js') };
      }
    });
    b.onResolve({ filter: /^\.\/pineParser$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'lib', 'scanner.js'))) {
        return { path: path.resolve(root, 'scripts/adminPineConfig.js') };
      }
    });
    b.onResolve({ filter: /^\.\/marketDataProvider$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'lib', 'scanner.js'))) {
        return { path: path.resolve(root, 'scripts/adminMarketDataProvider.js') };
      }
    });
  },
};

await build({
  entryPoints: [path.resolve(root, 'scripts/run-scan.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.resolve(root, 'scripts/dist/run-scan.mjs'),
  plugins: [adminOverrides],
  external: ['firebase-admin', 'firebase-admin/*'],
  logLevel: 'info',
});
