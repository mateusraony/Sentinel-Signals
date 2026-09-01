// Entry point for the scheduled scan (see .github/workflows/scan.yml).
// Bundled with esbuild (scripts/build-scan.mjs) before running — see that
// file for why a plain `node scripts/run-scan.mjs` won't work directly.
import { scanAllAssets, priceCheckActiveOps } from '../src/lib/scanner.js';
import { backend } from '@/api/entities';
import { assetHealthcheckReason, shouldAlertStale, shouldClearStaleAlert } from '../src/lib/assetHealthcheck.js';
import { isTelegramConfigured, notifyAssetStale, notifyFirestoreQuotaExhausted } from './adminTelegram.js';
import { withTimeout, forceExit } from './scanTimeout.mjs';

// docs/known-risks.md item 142 — a scan normal termina em ~20s; 90s dá
// folga generosa (retry de rede da Binance via httpRetry.js incluído) sem
// chegar perto dos minutos que uma chamada Firestore presa em retry de
// RESOURCE_EXHAUSTED levaria para desistir sozinha.
const SCAN_STEP_TIMEOUT_MS = 90 * 1000;

// Real Firestore quota exhaustion (docs/known-risks.md item 138), distinct
// from scanner.js's "projected near limit" warning (SystemLog-only, fires
// BEFORE the quota is actually hit). This is the "it's actually hit now"
// signal — checked against (a) an uncaught top-level failure (item
// 106/addendum: acquireScanLock or similar throwing all the way up), (b)
// per-asset scan errors that scanAllAssetsInner already swallows internally
// (item 106 original finding: every asset failing with RESOURCE_EXHAUSTED
// while main() itself completes without throwing), and (c) per-op price-check
// errors that priceCheckActiveOpsInner also swallows internally via
// logError (fire-and-forget, never propagates on its own — scanner.js now
// returns { errors } from that loop specifically so this can see them).
function isFirestoreQuotaExhausted(message) {
  return /RESOURCE_EXHAUSTED/i.test(String(message || ''));
}

async function alertIfQuotaExhausted(message) {
  if (!isFirestoreQuotaExhausted(message) || !isTelegramConfigured()) return;
  await notifyFirestoreQuotaExhausted(message).catch((e) =>
    console.warn('[scan] Falha ao notificar cota do Firestore (não crítico):', e.message)
  );
}

// Per-asset dead-man's-switch (docs/known-risks.md item 12): the
// healthchecks.io ping below only reports the WHOLE scan pass as
// failed/succeeded — an asset failing every single pass, or silently
// dropping out entirely, never surfaces. 30 min = 6x this workflow's 5-min
// cron cadence, matching the "cadence + margin" grace period recommended for
// dead-man's-switch monitoring (avoids false positives from one transient
// miss). Never allowed to throw or block the actual scan — see the try/catch
// around its call in main().
const ASSET_STALE_GRACE_MS = 30 * 60 * 1000;

async function checkAssetHealthchecks() {
  const assets = await backend.entities.MonitoredAsset.filter({ is_active: true });
  const now = Date.now();
  for (const asset of assets) {
    const reason = assetHealthcheckReason(asset, { now, graceMs: ASSET_STALE_GRACE_MS });
    if (shouldAlertStale(asset, reason)) {
      // Only persist the dedup marker once delivery is CONFIRMED — if Telegram
      // isn't configured, or the send fails/times out, leave it unset so the
      // next 5-min pass retries instead of silently suppressing the one alert
      // that matters most (a real, ongoing outage).
      const delivered = isTelegramConfigured() && await notifyAssetStale(asset, reason).catch(() => false);
      if (delivered) {
        await backend.entities.MonitoredAsset.update(asset.id, { stale_alert_sent_at: new Date().toISOString() });
      }
    } else if (shouldClearStaleAlert(asset, reason)) {
      await backend.entities.MonitoredAsset.update(asset.id, { stale_alert_sent_at: null });
    }
  }
}

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

  const { total, results } = await withTimeout(scanAllAssets(), SCAN_STEP_TIMEOUT_MS, 'scanAllAssets');
  const failed = results.filter((r) => !r.success);
  console.log(`[scan] scanAllAssets: ${total} ativo(s), ${failed.length} falha(s)`);
  failed.forEach((r) => console.error(`[scan]   ${r.symbol}: ${r.error}`));
  const quotaFailure = failed.find((r) => isFirestoreQuotaExhausted(r.error));
  if (quotaFailure) await alertIfQuotaExhausted(quotaFailure.error);

  const { errors: priceCheckErrors } = await withTimeout(priceCheckActiveOps(), SCAN_STEP_TIMEOUT_MS, 'priceCheckActiveOps');
  console.log('[scan] priceCheckActiveOps done');
  const priceCheckQuotaFailure = priceCheckErrors.find((e) => isFirestoreQuotaExhausted(e.error));
  if (priceCheckQuotaFailure) await alertIfQuotaExhausted(priceCheckQuotaFailure.error);

  try {
    await withTimeout(checkAssetHealthchecks(), SCAN_STEP_TIMEOUT_MS, 'checkAssetHealthchecks');
  } catch (err) {
    console.warn('[scan] per-asset healthcheck failed (non-fatal):', err.message);
    await alertIfQuotaExhausted(err?.message);
  }

  console.log(`[scan] finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await pingHealthcheck();
}

main().catch(async (err) => {
  console.error('[scan] FAILED:', err);
  await alertIfQuotaExhausted(err?.message);
  await pingHealthcheck('/fail');
  // forceExit (não só process.exitCode) — docs/known-risks.md item 142: se o
  // erro veio de um withTimeout acima, a chamada real ao Firestore perdeu a
  // corrida mas continua rodando (e re-tentando) em segundo plano; sem um
  // process.exit() explícito, o job do GitHub Actions ficaria vivo até ELA
  // desistir sozinha, do mesmo jeito que travava antes desta correção.
  forceExit(1);
});
