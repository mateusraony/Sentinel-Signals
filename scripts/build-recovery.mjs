// Empacota scripts/run-recovery.mjs (replay de recuperação, docs/known-risks.md item 288).
// 7º alvo de redirecionamento, mesma técnica dos outros (esbuild onResolve, scanner.js intacto):
//   '@/api/entities'       → scripts/recoveryEntities.js           (vazio; o orquestrador põe a loja em
//                                                                  memória no teste a seco — logger.js também)
//   './telegram'           → scripts/backtestTelegram.js           (no-op: o replay NUNCA manda alerta do scanner)
//   './pineParser'         → scripts/adminPineConfig.js            (StrategyConfig REAL, só leitura)
//   './marketDataProvider' → scripts/recoveryMarketDataProvider.js (velas pré-carregadas, como o ao vivo vê)
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromScanner = (args) => args.importer.endsWith(path.join('src', 'lib', 'scanner.js'));

const recoveryOverrides = {
  name: 'recovery-overrides',
  setup(b) {
    b.onResolve({ filter: /^@\/api\/entities$/ }, () => ({ path: path.resolve(root, 'scripts/recoveryEntities.js') }));
    b.onResolve({ filter: /^\.\/telegram$/ }, (args) => (fromScanner(args) ? { path: path.resolve(root, 'scripts/backtestTelegram.js') } : undefined));
    b.onResolve({ filter: /^\.\/pineParser$/ }, (args) => (fromScanner(args) ? { path: path.resolve(root, 'scripts/adminPineConfig.js') } : undefined));
    b.onResolve({ filter: /^\.\/marketDataProvider$/ }, (args) => (fromScanner(args) ? { path: path.resolve(root, 'scripts/recoveryMarketDataProvider.js') } : undefined));
  },
};

await build({
  entryPoints: [path.resolve(root, 'scripts/run-recovery.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.resolve(root, 'scripts/dist/run-recovery.mjs'),
  plugins: [recoveryOverrides],
  // 'pg' externo pelo mesmo motivo de build-scan.mjs ("Dynamic require of events").
  external: ['firebase-admin', 'firebase-admin/*', 'pg'],
  logLevel: 'info',
});
