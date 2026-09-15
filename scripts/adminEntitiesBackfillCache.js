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

// Item 179: persistScanResults' AssetState write moved from filter+create/
// update to a single atomic backend.assetStates.upsert(assetId, timeframe,
// data) call. entity.filter/upsert below share the SAME cacheByKey Map on
// purpose — a filter() right after an upsert() in the same tick needs to see
// the write, and two separate Maps could silently drift out of sync.
function createAssetStateCache(real) {
  const cacheByKey = new Map(); // "${asset_id}::${timeframe}" -> [doc] (mirrors .filter()'s array shape)
  const keyOf = (assetId, timeframe) => `${assetId}::${timeframe}`;

  const entity = {
    async list(...args) { return real.list(...args); },

    async filter(filters = {}, sort, limitCount) {
      if (!isAssetStateHotPathQuery(filters, sort, limitCount)) {
        return real.filter(filters, sort, limitCount);
      }
      const key = keyOf(filters.asset_id, filters.timeframe);
      if (!cacheByKey.has(key)) {
        cacheByKey.set(key, await real.filter(filters, sort, limitCount));
      }
      return cacheByKey.get(key);
    },

    // Defensive passthroughs — scanner.js no longer calls create()/update()
    // for AssetState (see upsert() below, the real per-tick call since item
    // 179), kept only so this stays a complete drop-in replacement of the
    // real shape for anything else that might still call them directly.
    async create(data) {
      const key = keyOf(data.asset_id, data.timeframe);
      const doc = { id: `backfill-cache::${key}`, ...data };
      cacheByKey.set(key, [doc]);
      return doc;
    },
    async createUnique(id, data) { return real.createUnique(id, data); },
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

  // The interception that actually matters post-item-179: this is what
  // persistScanResults calls once per timeframe per tick
  // (backend.assetStates.upsert). Never touches `real` — verified by
  // adminEntitiesBackfillCacheTripwire.test.js, same as the rest of this
  // file.
  async function upsert(assetId, timeframe, data) {
    const key = keyOf(assetId, timeframe);
    const existing = cacheByKey.get(key)?.[0];
    const merged = existing
      ? { ...existing, ...data, asset_id: assetId, timeframe, id: existing.id }
      : { id: `backfill-cache::${key}`, asset_id: assetId, timeframe, ...data };
    cacheByKey.set(key, [merged]);
    return merged;
  }

  return { entity, upsert };
}

// scanner.js's only per-tick MonitoredAsset write is exactly these 4
// bookkeeping fields (scanner.js:4057-4064 and :4414-4420) — nothing else is
// ever written from inside the tick loop. docs/known-risks.md item 176
// addendum 5: the ORIGINAL version of this guard intercepted the update()
// METHOD unconditionally, not just this shape — which also silently
// swallowed run-backfill-check.mjs's OWN orchestration writes
// (backfill_check_status/backfill_checked_at/backfill_ops_found/
// backfill_check_error), since that script imports the exact same `backend`
// object (the '@/api/entities' redirect in build-backfill.mjs isn't
// importer-scoped, unlike the other 3 redirects). Result: the backfill's own
// done/error outcome could never actually persist, no matter what happened —
// explaining why the same asset (LDOUSDT) resurfaced as 'pending' forever
// regardless of timeout/success. Same defensive shape-check pattern as
// isAssetStateHotPathQuery below: recognize the exact per-tick shape and
// no-op ONLY that; anything else (in particular the orchestrator's own
// status fields) passes through to the real backend untouched.
const SCAN_BOOKKEEPING_KEYS = new Set(['last_scan_at', 'scan_status', 'scan_error', 'scan_error_since']);
function isScanBookkeepingUpdate(data) {
  const keys = Object.keys(data ?? {});
  return keys.length > 0 && keys.every((key) => SCAN_BOOKKEEPING_KEYS.has(key));
}

// Reads (filter/list — the one real lookup run-backfill-check.mjs does per
// asset, outside the tick loop) stay real: the "already has an active op"
// guard and the asset's live config must reflect production.
function createMonitoredAssetBackfillEntity(real) {
  return {
    ...real,
    async update(id, data) {
      if (isScanBookkeepingUpdate(data)) return { id, ...data };
      return real.update(id, data);
    },
  };
}

const assetStateCache = createAssetStateCache(realBackend.entities.AssetState);

export const backend = {
  ...realBackend,
  entities: {
    ...realBackend.entities,
    AssetState: assetStateCache.entity,
    MonitoredAsset: createMonitoredAssetBackfillEntity(realBackend.entities.MonitoredAsset),
  },
  // Item 179: realBackend.assetStates.upsert is Postgres-real (never cached
  // by the ...realBackend spread above) — must be overridden explicitly,
  // same reasoning as AssetState under `entities` above. Without this, a
  // replay tick's write would go straight to production, reproducing the
  // exact item 137 addendum hang this whole file exists to prevent.
  assetStates: {
    ...realBackend.assetStates,
    upsert: assetStateCache.upsert,
  },
};

export { getAndResetOpCounts };
