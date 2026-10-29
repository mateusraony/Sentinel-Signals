// Pure, dependency-free per-asset "dead man's switch" decision logic.
// Extracted so it's testable without Firestore/network, mirroring the pattern
// established for opTransition.js/opExitRules.js. Consumed by
// scripts/run-scan.mjs — the cron's per-asset healthcheck, which closes the
// gap documented in docs/known-risks.md item 12: the existing healthchecks.io
// ping only reports the WHOLE scan pass as failed/succeeded, never a single
// asset silently failing every pass.
//
// Two independent triggers, because last_scan_at is refreshed on BOTH success
// and error (src/lib/scanner.js's persistScanResults and the outer per-asset
// catch) — staleness of last_scan_at alone would never catch an asset that is
// failing every single pass but still being "touched" each time:
//   - 'persistent_error': scan_error_since has been set for longer than the
//     grace period (the asset has failed every pass since then).
//   - 'silent': last_scan_at itself is older than the grace period (the asset
//     stopped being processed at all — should be rare given the isolated
//     try/catch per asset in scanAllAssets, but is the direct
//     dead-man's-switch case).

/**
 * Tolerância do dead-man's-switch por ativo: 60 min (item 286).
 *
 * Era 30 min com o scan a cada 5 min (6 passadas). Com ~15 min, 30 min são só
 * 2 passadas — um único disparo atrasado do GitHub Actions viraria "Ativo sem
 * atualização" e o alerta de erro persistente sairia na 3ª falha seguida.
 * 60 min = 4 passadas, a mesma folga de "cadência + margem". Fonte única: o
 * cron (`scripts/run-scan.mjs`), a tela (`assetDataQuality`) e o texto do
 * Dashboard leem daqui.
 */
export const ASSET_STALE_GRACE_MIN = 60;
export const ASSET_STALE_GRACE_MS = ASSET_STALE_GRACE_MIN * 60 * 1000;

export function assetHealthcheckReason(asset, { now = Date.now(), graceMs = ASSET_STALE_GRACE_MS } = {}) {
  if (!asset || asset.is_active === false) return null;
  if (asset.scan_error_since) {
    const errorAge = now - new Date(asset.scan_error_since).getTime();
    if (errorAge > graceMs) return 'persistent_error';
  }
  if (asset.last_scan_at) {
    const scanAge = now - new Date(asset.last_scan_at).getTime();
    if (scanAge > graceMs) return 'silent';
  }
  return null;
}

// Fire the alert only on the transition INTO an unhealthy state — dedup via
// stale_alert_sent_at so the cron (every 5 min) doesn't spam Telegram every
// pass while the asset stays unhealthy.
export function shouldAlertStale(asset, reason) {
  return !!reason && !asset.stale_alert_sent_at;
}

// Clear the dedup marker once the asset recovers, so a FUTURE staleness
// episode alerts again instead of being silently suppressed forever.
export function shouldClearStaleAlert(asset, reason) {
  return !reason && !!asset.stale_alert_sent_at;
}
