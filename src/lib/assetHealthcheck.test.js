import { describe, it, expect } from 'vitest';
import { SCAN_CADENCE_MS } from './pollingIntervals.js';
import { assetHealthcheckReason, shouldAlertStale, shouldClearStaleAlert, ASSET_STALE_GRACE_MS, ASSET_STALE_GRACE_MIN } from './assetHealthcheck.js';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');
const GRACE = ASSET_STALE_GRACE_MS; // fonte única (item 286): 60 min, o mesmo default do cron e da tela

function minutesAgo(mins) {
  return new Date(NOW - mins * 60 * 1000).toISOString();
}

describe('assetHealthcheckReason', () => {
  it('returns null for an inactive asset regardless of staleness', () => {
    const asset = { is_active: false, last_scan_at: minutesAgo(120) };
    expect(assetHealthcheckReason(asset, { now: NOW, graceMs: GRACE })).toBe(null);
  });

  it('returns null for a healthy asset (recent scan, no error)', () => {
    const asset = { is_active: true, last_scan_at: minutesAgo(2), scan_status: 'success', scan_error_since: null };
    expect(assetHealthcheckReason(asset, { now: NOW, graceMs: GRACE })).toBe(null);
  });

  it('returns null for a fresh error (below grace period) — avoids false positives on a single miss', () => {
    const asset = { is_active: true, last_scan_at: minutesAgo(2), scan_status: 'error', scan_error_since: minutesAgo(10) };
    expect(assetHealthcheckReason(asset, { now: NOW, graceMs: GRACE })).toBe(null);
  });

  it('returns "persistent_error" when scan_error_since exceeds the grace period, even though last_scan_at stays recent', () => {
    // This is the core gap: last_scan_at refreshes every failing pass too.
    const asset = { is_active: true, last_scan_at: minutesAgo(2), scan_status: 'error', scan_error_since: minutesAgo(90) };
    expect(assetHealthcheckReason(asset, { now: NOW, graceMs: GRACE })).toBe('persistent_error');
  });

  it('returns "silent" when last_scan_at itself is stale and there is no active error streak', () => {
    const asset = { is_active: true, last_scan_at: minutesAgo(90), scan_status: 'success', scan_error_since: null };
    expect(assetHealthcheckReason(asset, { now: NOW, graceMs: GRACE })).toBe('silent');
  });

  it('never scanned yet (no last_scan_at) is not stale — avoids false positive on a brand new asset', () => {
    const asset = { is_active: true, last_scan_at: null, scan_status: 'idle', scan_error_since: null };
    expect(assetHealthcheckReason(asset, { now: NOW, graceMs: GRACE })).toBe(null);
  });

  it('prioritizes persistent_error over silent when both would technically apply', () => {
    const asset = { is_active: true, last_scan_at: minutesAgo(90), scan_status: 'error', scan_error_since: minutesAgo(100) };
    expect(assetHealthcheckReason(asset, { now: NOW, graceMs: GRACE })).toBe('persistent_error');
  });
});

describe('tolerância única (item 286)', () => {
  it('o padrão é 60 min: 59 min de idade ainda é saudável, 61 min é atrasado', () => {
    expect(ASSET_STALE_GRACE_MIN).toBe(60);
    const fresco = { is_active: true, last_scan_at: minutesAgo(59), scan_status: 'success', scan_error_since: null };
    const velho = { is_active: true, last_scan_at: minutesAgo(61), scan_status: 'success', scan_error_since: null };
    expect(assetHealthcheckReason(fresco, { now: NOW })).toBe(null);
    expect(assetHealthcheckReason(velho, { now: NOW })).toBe('silent');
  });

  it('REGRESSÃO (cadência 5 -> 15 min): a tolerância cobre pelo menos 3 passadas do scan', () => {
    // Com 30 min e scan de 15 min eram só 2 passadas: um disparo atrasado do GitHub
    // viraria "Ativo sem atualização". Se alguém aumentar a cadência sem
    // aumentar a tolerância, este teste quebra.
    expect(ASSET_STALE_GRACE_MS).toBeGreaterThanOrEqual(3 * SCAN_CADENCE_MS);
  });
});

describe('shouldAlertStale / shouldClearStaleAlert (dedup)', () => {
  it('alerts once on the transition into unhealthy', () => {
    const asset = { stale_alert_sent_at: null };
    expect(shouldAlertStale(asset, 'persistent_error')).toBe(true);
  });

  it('does not re-alert while already marked (dedup across 5-min passes)', () => {
    const asset = { stale_alert_sent_at: minutesAgo(5) };
    expect(shouldAlertStale(asset, 'persistent_error')).toBe(false);
  });

  it('does not alert a healthy asset', () => {
    const asset = { stale_alert_sent_at: null };
    expect(shouldAlertStale(asset, null)).toBe(false);
  });

  it('clears the marker once the asset recovers', () => {
    const asset = { stale_alert_sent_at: minutesAgo(60) };
    expect(shouldClearStaleAlert(asset, null)).toBe(true);
  });

  it('does not clear a marker that was never set', () => {
    const asset = { stale_alert_sent_at: null };
    expect(shouldClearStaleAlert(asset, null)).toBe(false);
  });

  it('does not clear while still unhealthy', () => {
    const asset = { stale_alert_sent_at: minutesAgo(60) };
    expect(shouldClearStaleAlert(asset, 'silent')).toBe(false);
  });
});
