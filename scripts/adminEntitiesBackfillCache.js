// Backfill-only wrapper around scripts/adminEntities.js — fixes the
// 2026-08-29 hang that got `npm run backfill-check` disabled in scan.yml
// (docs/known-risks.md item 137 addendum). src/lib/scanner.js stays
// completely unmodified, and EVERY collection except AssetState/
// MonitoredAsset passes straight through to the real production adapter —
// a backfilled TradeOperation is a REAL TradeOperation, created by the exact
// same transactional path (createTradeOpIfNoneActive) as a live one. No
// third mutation path.
//
// Root cause of the hang: runBacktest's tick loop (src/lib/backtestEngine.js)
// calls scanAsset + persistScanResults once per simulated 15-min step —
// 5,760 ticks for a single asset over the 60-day backfill window
// (MAX_ASSETS_PER_RUN=1 in run-backfill-check.mjs). Inside
// persistScanResults, TWO collections are touched UNCONDITIONALLY on every
// single tick — no change-detection gate, unlike every other write in that
// function:
//   - AssetState.filter({asset_id, timeframe}) — a real Firestore QUERY,
//     every tick, per timeframe (scanner.js ~line 1839). hasAssetStateChanged
//     only skips the WRITE when nothing changed; the READ always happens.
//   - MonitoredAsset.update(asset.id, {last_scan_at, scan_status, ...}) —
//     unconditional at the end of every persistScanResults call
//     (scanner.js ~line 3963).
// For 1 asset / 60 days / RF-only (3 timeframes) that's ~17,280 real reads
// and 5,760 real sequential writes against firebase-admin. The writes alone
// — awaited one at a time, ~100-200ms network round-trip each — account for
// the observed "11+ minutes, still not done" that blew past scan.yml's
// 12-minute job timeout. The reads alone are close to a third of the
// ENTIRE daily Spark quota (~50k reads/day,
// .claude/rules/firestore-concurrency.md) for a SINGLE backfill run.
//
// Neither collection is a decision input: scanAsset recomputes RF/signals
// fresh from candles every tick (the golden-parity no-look-ahead guarantee,
// .claude/rules/pine-parity.md — nothing reads AssetState back to decide
// anything), and MonitoredAsset.scan_status/last_scan_at/scan_error* are
// pure dashboard bookkeeping. So during a replay both are safe to serve from
// an in-memory cache and NEVER flushed to Firestore — which doubles as the
// fix for the item 137 addendum's 2nd finding ("o replay sobrescrevia o
// snapshot ao vivo do ativo com dado histórico simulado enquanto rodava"):
// if it's never written for real, there's nothing to corrupt and nothing to
// restore afterward.
//
// Isolation verified by adminEntitiesBackfillCacheTripwire.test.js, which
// scans this file's own source text for any accidental real write from the
// two intercepted entities and confirms every other entity is a pure
// passthrough.
import { backend as realBackend, getAndResetOpCounts } from './adminEntities.js';

// AssetState.filter is only ever called by persistScanResults
// (scanner.js ~line 1839) shaped exactly {asset_id, timeframe}, no sort, no
// limit. Any OTHER shape (a future caller, a different query) falls straight
// through to the real adapter untouched — this cache can never silently
// serve a stale result for a query it doesn't recognize.
function isAssetStateHotPathQuery(filters, sort, limitCount) {
  if (sort || limitCount || !filters) return false;
  const keys = Object.keys(filters);
  return keys.length === 2 && filters.asset_id != null && filters.timeframe != null;
}

function createAssetStateCache(real) {
  const cacheByKey = new Map(); // "${asset_id}::${timeframe}" -> [doc] (mirrors .filter()'s array shape)
  const keyOf = (f) => `${f.asset_id}::${f.timeframe}`;

  return {
    async list(...args) { return real.list(...args); },

    async filter(filters = {}, sort, limitCount) {
      if (!isAssetStateHotPathQuery(filters, sort, limitCount)) {
        return real.filter(filters, sort, limitCount);
      }
      const key = keyOf(filters);
      if (!cacheByKey.has(key)) {
        cacheByKey.set(key, await real.filter(filters, sort, limitCount));
      }
      return cacheByKey.get(key);
    },

    // persistScanResults only ever calls create() right after a filter()
    // that found nothing for that key — always caches under a synthetic id,
    // never touches Firestore.
    async create(data) {
      const key = keyOf(data);
      const doc = { id: `backfill-cache::${key}`, ...data };
      cacheByKey.set(key, [doc]);
      return doc;
    },

    // Never actually used for AssetState by scanner.js — passthrough kept
    // only so this stays a complete drop-in replacement of the real shape.
    async createUnique(id, data) { return real.createUnique(id, data); },

    // persistScanResults always calls update(existing[0].id, stateData)
    // immediately after reading existing[0] from filter() above, so the
    // owning key is always already cached here.
    async update(id, data) {
      for (const [key, docs] of cacheByKey) {
        if (docs[0]?.id === id) {
          cacheByKey.set(key, [{ ...docs[0], ...data }]);
          return { id, ...data };
        }
      }
      return { id, ...data };
    },

    async delete(id) { return real.delete(id); },
    async bulkCreate(items) { return real.bulkCreate(items); },
    async deleteMany(filters) { return real.deleteMany(filters); },
  };
}

// scanner.js's only per-tick MonitoredAsset write (scan_status/last_scan_at/
// scan_error/scan_error_since bookkeeping) becomes an in-memory-only no-op —
// same return shape as the real adapter's update() so nothing that might
// destructure the result breaks, just never reaches Firestore during
// replay. Reads (filter/list — the one real lookup run-backfill-check.mjs
// does per asset, outside the tick loop) stay real: the "already has an
// active op" guard and the asset's live config must reflect production.
function createMonitoredAssetBackfillEntity(real) {
  return {
    ...real,
    async update(id, data) { return { id, ...data }; },
  };
}

export const backend = {
  ...realBackend,
  entities: {
    ...realBackend.entities,
    AssetState: createAssetStateCache(realBackend.entities.AssetState),
    MonitoredAsset: createMonitoredAssetBackfillEntity(realBackend.entities.MonitoredAsset),
  },
};

export { getAndResetOpCounts };
