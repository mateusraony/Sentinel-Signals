// Entry point for the scheduled scan (see .github/workflows/scan.yml).
// Bundled with esbuild (scripts/build-scan.mjs) before running — see that
// file for why a plain `node scripts/run-scan.mjs` won't work directly.
import { scanAllAssets, priceCheckActiveOps } from '../src/lib/scanner.js';

// Dead-man's-switch heartbeat (healthchecks.io or compatible) — pinged on
// every successful run so an external, non-GitHub-Actions service can alert
// (via Telegram) if the scan stops running entirely, including the
// scenario where GitHub itself auto-disables this scheduled workflow after
// 60 days of repo inactivity (a real, documented GitHub Actions behavior —
// an in-repo watchdog would share that exact same blind spot, which is why
// this needs to live outside GitHub). Optional: skipped entirely if the env
// var isn't set, so local `npm run scan` runs never ping it by accident.
// Never allowed to throw or block the actual scan — a ping failure/timeout
// is logged and swallowed, not surfaced as a scan failure.
const HEALTHCHECKS_PING_URL = process.env.HEALTHCHECKS_PING_URL;

async function pingHealthcheck(suffix = '') {
  if (!HEALTHCHECKS_PING_URL) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(`${HEALTHCHECKS_PING_URL}${suffix}`, { signal: controller.signal });
    clearTimeout(timeout);
  } catch (err) {
    console.warn('[scan] healthcheck ping failed (non-fatal):', err.message);
  }
}

async function main() {
  const started = Date.now();

  const { total, results } = await scanAllAssets();
  const failed = results.filter((r) => !r.success);
  console.log(`[scan] scanAllAssets: ${total} ativo(s), ${failed.length} falha(s)`);
  failed.forEach((r) => console.error(`[scan]   ${r.symbol}: ${r.error}`));

  await priceCheckActiveOps();
  console.log('[scan] priceCheckActiveOps done');

  console.log(`[scan] finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await pingHealthcheck();
}

main().catch(async (err) => {
  console.error('[scan] FAILED:', err);
  await pingHealthcheck('/fail');
  process.exitCode = 1;
});
