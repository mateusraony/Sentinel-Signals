// Realtime Database READ adapter (docs/known-risks.md item 152) — mirrors
// the reduced subset of backend.entities.<Name>'s shape ({list, filter})
// that the dashboard's hot polling reads actually use for AssetState/
// TradeOperation: order+limit ("-created_date", N) and a single-field range
// ({ created_date: { gte, lt } }, MonthlyReport.jsx). Every call is
// fire-and-forget-free (normal awaited reads) but NEVER mutates anything —
// all writes/mutations continue exclusively through backend.entities/
// backend.tradeOps (Firestore), never through this module. See
// .claude/rules/firestore-concurrency.md: this stays the only place pages
// import firebase/database from, same discipline already applied to
// firebase/firestore.
//
// "Recognize the exact shape, else fall through to Firestore" — same spirit
// as isAssetStateHotPathQuery in scripts/adminEntitiesBackfillCache.js.
// Introducing this module can never regress correctness: an unrecognized
// filter shape gets today's behavior (a real Firestore read via the
// `fallbackEntity` passed in), never an incomplete/wrong RTDB result. RTDB
// not provisioned in this environment (rtdb === null) falls back the same way.
import { ref, get, query, orderByChild, limitToLast, startAt, endBefore } from 'firebase/database';
import { rtdb } from '@/lib/firebaseClient';
import { backend } from '@/api/entities';

function sortField(sort) {
  return sort ? (sort.startsWith('-') ? sort.slice(1) : sort) : null;
}

function isDescending(sort) {
  return Boolean(sort && sort.startsWith('-'));
}

function valuesOf(snapshot) {
  const val = snapshot.val();
  return val ? Object.values(val) : [];
}

function withOrder(items, sort) {
  return isDescending(sort) ? items.reverse() : items;
}

// { field: { gte, lt } } — exactly the shape src/lib/queryFilters.js's
// classifyFilter() calls 'range', restricted here to a SINGLE filtered field
// (the only shape any of the 9 pollers in scope this round ever uses —
// MonthlyReport.jsx's { created_date: { gte, lt } }). Anything else (a 2nd
// field, an array/`in` value, an equality value) isn't recognized — RTDB has
// no composite index for this round's collections, so it falls through
// rather than risk silently returning a partial/wrong result.
function singleFieldRangeShape(filters) {
  const keys = Object.keys(filters);
  if (keys.length !== 1) return null;
  const [field] = keys;
  const value = filters[field];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const valueKeys = Object.keys(value);
  if (valueKeys.length === 0 || !valueKeys.every((k) => k === 'gte' || k === 'lt')) return null;
  return { field, gte: value.gte, lt: value.lt };
}

function createRtdbReadEntity(rtdbPath, fallbackEntity) {
  return {
    async list(sort, limitCount) {
      if (!rtdb) return fallbackEntity.list(sort, limitCount);
      if (!sort && !limitCount) {
        const snapshot = await get(ref(rtdb, rtdbPath));
        return valuesOf(snapshot);
      }
      const constraints = [orderByChild(sortField(sort))];
      if (limitCount) constraints.push(limitToLast(limitCount));
      const snapshot = await get(query(ref(rtdb, rtdbPath), ...constraints));
      return withOrder(valuesOf(snapshot), sort);
    },

    async filter(filters = {}, sort, limitCount) {
      if (!rtdb) return fallbackEntity.filter(filters, sort, limitCount);
      if (Object.keys(filters).length === 0) return this.list(sort, limitCount);

      const range = singleFieldRangeShape(filters);
      if (!range) return fallbackEntity.filter(filters, sort, limitCount);

      const constraints = [orderByChild(range.field)];
      if (range.gte !== undefined) constraints.push(startAt(range.gte));
      if (range.lt !== undefined) constraints.push(endBefore(range.lt));
      if (limitCount) constraints.push(limitToLast(limitCount));
      const snapshot = await get(query(ref(rtdb, rtdbPath), ...constraints));
      return withOrder(valuesOf(snapshot), sort);
    },
  };
}

export const rtdbEntities = {
  AssetState: createRtdbReadEntity('assetStates', backend.entities.AssetState),
  TradeOperation: createRtdbReadEntity('tradeOperations', backend.entities.TradeOperation),
};
