// Entry point for the scheduled scan (see .github/workflows/scan.yml).
// Bundled with esbuild (scripts/build-scan.mjs) before running — see that
// file for why a plain `node scripts/run-scan.mjs` won't work directly.
import { scanAllAssets, priceCheckActiveOps } from '../src/lib/scanner.js';

async function main() {
  const started = Date.now();

  const { total, results } = await scanAllAssets();
  const failed = results.filter((r) => !r.success);
  console.log(`[scan] scanAllAssets: ${total} ativo(s), ${failed.length} falha(s)`);
  failed.forEach((r) => console.error(`[scan]   ${r.symbol}: ${r.error}`));

  await priceCheckActiveOps();
  console.log('[scan] priceCheckActiveOps done');

  console.log(`[scan] finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('[scan] FAILED:', err);
  process.exitCode = 1;
});
