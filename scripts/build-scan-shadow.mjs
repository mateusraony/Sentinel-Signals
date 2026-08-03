// Bundles scripts/run-scan-shadow.mjs (which imports src/lib/scanner.js
// verbatim) into a single Node-runnable file for the Fase 1 shadow-mode
// GitHub Actions job (docs/known-risks.md item 56 "Modo sombra"). Same
// structure and same reasoning as scripts/build-scan.mjs — see that file's
// header comment — but 3 of the 4 redirected imports point at shadow-only
// modules instead of the real production ones:
//   '@/api/entities'      → scripts/adminEntitiesShadow.js   (isolated 'experimentalRf1hShadow*' collections)
//   './telegram'          → scripts/adminTelegramShadow.js   (no-op — never notify)
//   './pineParser'        → scripts/adminPineConfigShadow.js (real strategyConfig/current + rf1hCondEnabled:true)
//   './marketDataProvider' → scripts/adminMarketDataProvider.js (UNCHANGED — market data is always real/live, only the write destination is isolated)
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const shadowOverrides = {
  name: 'shadow-overrides',
  setup(b) {
    b.onResolve({ filter: /^@\/api\/entities$/ }, () => ({
      path: path.resolve(root, 'scripts/adminEntitiesShadow.js'),
    }));
    b.onResolve({ filter: /^\.\/telegram$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'lib', 'scanner.js'))) {
        return { path: path.resolve(root, 'scripts/adminTelegramShadow.js') };
      }
    });
    b.onResolve({ filter: /^\.\/pineParser$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'lib', 'scanner.js'))) {
        return { path: path.resolve(root, 'scripts/adminPineConfigShadow.js') };
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
  entryPoints: [path.resolve(root, 'scripts/run-scan-shadow.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.resolve(root, 'scripts/dist/run-scan-shadow.mjs'),
  plugins: [shadowOverrides],
  external: ['firebase-admin', 'firebase-admin/*'],
  logLevel: 'info',
});
