// Entry point for the Fase 1 shadow-mode workflow (see
// .github/workflows/scan-shadow.yml and docs/known-risks.md item 56 "Modo
// sombra"). Bundled with esbuild (scripts/build-scan-shadow.mjs) before
// running — same reason as scripts/run-scan.mjs (Vite '@/' alias + Node's
// native ESM loader can't resolve it directly).
//
// Deliberately simpler than run-scan.mjs: no per-asset healthcheck alerting
// and no external watchdog ping — those exist to protect REAL trading
// signals from going unnoticed, which doesn't apply here (nothing here ever
// opens a real TradeOperation; the whole point is prospective, log-only
// observation). scanAllAssets/priceCheckActiveOps are imported from
// src/lib/scanner.js WITHOUT modification — see scripts/build-scan-shadow.mjs
// for the 4 import redirections that route every write to isolated,
// 'experimentalRf1hShadow'-prefixed Firestore collections instead of the
// real production ones.
import { scanAllAssets, priceCheckActiveOps } from '../src/lib/scanner.js';

async function main() {
  const started = Date.now();

  const { total, results } = await scanAllAssets();
  const failed = results.filter((r) => !r.success);
  console.log(`[scan-shadow] scanAllAssets: ${total} ativo(s), ${failed.length} falha(s)`);
  failed.forEach((r) => console.error(`[scan-shadow]   ${r.symbol}: ${r.error}`));

  await priceCheckActiveOps();
  console.log('[scan-shadow] priceCheckActiveOps done');

  console.log(`[scan-shadow] finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('[scan-shadow] FAILED:', err);
  process.exitCode = 1;
});
