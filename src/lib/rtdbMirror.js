// Pure Firestore→RTDB mirror helpers, shared by src/api/entities.js (browser,
// firebase/database) and scripts/adminEntities.js (cron, firebase-admin/
// database) — each backend implements its own I/O primitives (mirrorSet/
// mirrorUpdate/mirrorRemove, backed by its own SDK) and injects them here, so
// this file never imports either SDK and is testable without mocking
// firebase/database at all. Same reasoning as src/lib/queryFilters.js:
// scanner.js runs unmodified in both environments, so any behavior this
// touches must be identical in both.
//
// RTDB is a READ-ONLY mirror for the dashboard's polling reads — see
// .claude/rules/firestore-concurrency.md and docs/known-risks.md item 152.
// It never participates in TradeOperation mutation: withCreateOpMirror/
// withTransitionOpMirror only fire AFTER the real Firestore transaction has
// already resolved (never inside runTransaction), and never alter the value
// returned to the caller — a mirror failure must never affect the write it
// followed. Verified structurally by entitiesRtdbTripwire.test.js /
// scripts/adminEntitiesRtdbTripwire.test.js.

// assetStates/tradeOperations were the first round (docs/known-risks.md item
// 152). signalEvents joined in round 2 (item 152 addendum, item 155/159
// investigation): measured against the CURRENT (already-fixed, 60-120s)
// polling intervals, Dashboard/Assets/Alerts/Trades each read SignalEvent
// straight from Firestore and each, alone, costs more than the entire daily
// quota if left open a full day (100 docs/60s on Assets.jsx alone is
// ~159.800 reads/day against a 50.000 budget) — the single highest-leverage
// collection left un-mirrored, shared by every screen a user would
// realistically keep open while watching the market. monitoredAssets/
// verificationTasks/systemLogs remain candidates for a future round; their
// document counts are an order of magnitude smaller (tens, not hundreds),
// so measured priority puts them after, not before.
export const RTDB_MIRRORED_ENTITIES = Object.freeze({
  AssetState: 'assetStates',
  SignalEvent: 'signalEvents',
  TradeOperation: 'tradeOperations',
});

// RTDB keys can't contain '.', '#', '$', '[', ']', '/'. TradeOperation ids
// are deterministic and embed a raw ISO candle timestamp (scanner.js, e.g.
// `trade_${signal.dedup_key}` where dedup_key ends in
// `..._raw_2026-09-03T12:00:00.000Z`) — the `.000Z` alone would make
// set()/update() throw synchronously. Sanitizing is deterministic
// (collisions are practically impossible given the id shapes scanner.js
// actually produces — symbol+timeframe+signal type+source+timestamp). The
// REAL Firestore id is always kept as the `id` field inside the mirrored
// value, so a mutation initiated from data read via the RTDB mirror always
// targets the real Firestore document, never the sanitized key.
export function toRtdbKey(firestoreId) {
  return String(firestoreId).replace(/[.#$/[\]]/g, '_');
}

/**
 * @param {{
 *   mirrorSet: (rtdbPath: string, firestoreId: string, value: object) => void,
 *   mirrorUpdate: (rtdbPath: string, firestoreId: string, patch: object) => void,
 *   mirrorRemove: (rtdbPath: string, firestoreId: string) => void,
 * }} io - fire-and-forget I/O primitives; each backend supplies its own SDK
 *   glue and its own error handling. None of these are ever awaited by the
 *   wrappers below, and their return value is ignored — a mirror write can
 *   never delay or fail the real Firestore call it followed.
 */
export function createRtdbMirrorHelpers({ mirrorSet, mirrorUpdate, mirrorRemove }) {
  // Defense in depth: mirrorSet/mirrorUpdate/mirrorRemove are documented as
  // fire-and-forget (each backend's own implementation already wraps its
  // SDK call in .catch()), but nothing here should trust that blindly — a
  // synchronous throw from a misbehaving primitive must never propagate out
  // of a mirror call and abort the real Firestore write/transition it
  // followed. Errors are swallowed silently here: the primitive is expected
  // to have already logged (console.warn, same pattern as
  // makeResilientLogEntity in entities.js).
  function safeMirrorCall(fn, ...args) {
    try {
      fn(...args);
    } catch {
      // Intentionally silent — see comment above.
    }
  }

  // Wraps one backend.entities.<Name> object. Only entities present in
  // RTDB_MIRRORED_ENTITIES are intercepted (create/createUnique/update/
  // bulkCreate/deleteMany) — every other entity (MonitoredAsset, SystemLog,
  // VerificationTask, ...) is returned completely untouched.
  function withRtdbMirror(entityKey, entity) {
    const rtdbPath = RTDB_MIRRORED_ENTITIES[entityKey];
    if (!rtdbPath) return entity;

    return {
      ...entity,
      async create(data) {
        const created = await entity.create(data);
        safeMirrorCall(mirrorSet, rtdbPath, created.id, created);
        return created;
      },
      // SignalEvent's real creation path in scanner.js is createUnique
      // (dedup by signal.dedup_key), never create() — same {created, doc}
      // shape as createTradeOpIfNoneActive below, so the same "only on a
      // real create" guard applies: a dedup hit (created: false) must not
      // re-mirror the pre-existing doc.
      async createUnique(id, data) {
        const res = await entity.createUnique(id, data);
        if (res.created && res.doc) safeMirrorCall(mirrorSet, rtdbPath, res.doc.id, res.doc);
        return res;
      },
      async update(id, data) {
        const updated = await entity.update(id, data);
        safeMirrorCall(mirrorUpdate, rtdbPath, id, data);
        return updated;
      },
      async bulkCreate(items) {
        const created = await entity.bulkCreate(items);
        created.forEach((item) => safeMirrorCall(mirrorSet, rtdbPath, item.id, item));
        return created;
      },
      async deleteMany(filters) {
        const deleted = await entity.deleteMany(filters);
        (deleted ?? []).forEach((item) => safeMirrorCall(mirrorRemove, rtdbPath, item.id));
        return deleted;
      },
    };
  }

  // TradeOperation ids are created via backend.tradeOps.createTradeOpIfNoneActive
  // (the CAS transaction), never via entities.TradeOperation.create() in
  // production — this wraps that path instead.
  function withCreateOpMirror(createTradeOpIfNoneActiveFn) {
    const rtdbPath = RTDB_MIRRORED_ENTITIES.TradeOperation;
    return async function createTradeOpIfNoneActiveMirrored(...args) {
      const res = await createTradeOpIfNoneActiveFn(...args);
      if (res.created && res.doc) safeMirrorCall(mirrorSet, rtdbPath, res.doc.id, res.doc);
      return res;
    };
  }

  // transitionTradeOp's CAS write is the other real mutation path — mirrors
  // the applied patch (res.patch, the post-clampMonotonicStop value) after
  // the transaction has already committed.
  function withTransitionOpMirror(transitionTradeOpFn) {
    const rtdbPath = RTDB_MIRRORED_ENTITIES.TradeOperation;
    return async function transitionTradeOpMirrored(opId, fromStatus, patch, options) {
      const res = await transitionTradeOpFn(opId, fromStatus, patch, options);
      if (res.applied && res.patch) safeMirrorCall(mirrorUpdate, rtdbPath, opId, res.patch);
      return res;
    };
  }

  return { withRtdbMirror, withCreateOpMirror, withTransitionOpMirror };
}
