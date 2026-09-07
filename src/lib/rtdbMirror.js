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
// verificationTasks joined in round 3b (item 169) — smaller collections
// (tens/low hundreds, not thousands), read via the whole-node mode in
// src/api/rtdbEntities.js (createRtdbWholeNodeReadEntity) instead of an
// RTDB-side query, so no .indexOn is needed for either. systemLogs joined in
// round 3c (item 169) — its two createUnique() calls (scanner.js) embed
// unbounded free-text (err.message) in the doc id, which is why toRtdbKey()
// below got a length-safe fallback FIRST; read via the SAME order+limit mode
// as SignalEvent/TradeOperation (createRtdbReadEntity — this collection is
// large, thousands of docs, so whole-node fetch would defeat the purpose).
export const RTDB_MIRRORED_ENTITIES = Object.freeze({
  AssetState: 'assetStates',
  MonitoredAsset: 'monitoredAssets',
  SignalEvent: 'signalEvents',
  SystemLog: 'systemLogs',
  TradeOperation: 'tradeOperations',
  VerificationTask: 'verificationTasks',
});

// RTDB rejects keys over 768 bytes (UTF-8) — see
// https://firebase.google.com/docs/database/usage/limits#data-tree. Kept
// well under that: SystemLog's scan-error dedup key (scanner.js) embeds
// `err.message` verbatim, which is free text with no length contract.
const RTDB_KEY_MAX_BYTES = 700;

function utf8ByteLength(str) {
  return new TextEncoder().encode(str).length;
}

// Truncates to a byte budget, not a character budget — a naive
// String.slice() could cut a multi-byte UTF-8 character in half and produce
// a STILL-too-long result (surrogate pairs, accented/non-Latin text in a
// live error message). TextDecoder's default (non-fatal) mode replaces any
// dangling partial sequence at the cut point with U+FFFD instead of
// throwing — harmless here, since the key is never read back for content
// (the untruncated original lives in the mirrored value's own fields).
function truncateToByteBudget(str, maxBytes) {
  const bytes = new TextEncoder().encode(str);
  if (bytes.length <= maxBytes) return str;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

// Deterministic, non-cryptographic 32-bit hash (FNV-1a) — collision
// avoidance for truncated keys, not security. Same input always produces the
// same hash in both the browser and Node (no Web Crypto / crypto module
// dependency), which matters here: two DIFFERENT long ids that happen to
// share their first N bytes must not collapse onto the same RTDB key once
// truncated, and the SAME long id (a repeated error on the same day) must
// keep landing on the same key so createUnique()'s dedup still works after
// truncation.
function shortHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

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
//
// SystemLog's scan-error dedup key (scanner.js:
// `scan_error::${asset.id}::${today}::${err.message}`) is the one id shape
// in this codebase that can blow past RTDB_KEY_MAX_BYTES — err.message is
// unbounded free text (item 169 round-3 proposal flagged this as the
// blocker for mirroring SystemLog). When the sanitized id is too long, it's
// truncated to a byte budget and a short deterministic hash of the FULL
// sanitized string is appended — deterministic (same id -> same key, so
// createUnique dedup still works) and collision-safe (the hash covers the
// whole string, not just the surviving prefix, so two long ids sharing a
// prefix still diverge). Short ids (the overwhelming majority — every other
// entity's ids, and most SystemLog ids) are completely unaffected: this
// branch only triggers once RTDB_KEY_MAX_BYTES is actually exceeded.
export function toRtdbKey(firestoreId) {
  const sanitized = String(firestoreId).replace(/[.#$/[\]]/g, '_');
  if (utf8ByteLength(sanitized) <= RTDB_KEY_MAX_BYTES) return sanitized;
  const hash = shortHash(sanitized);
  const truncated = truncateToByteBudget(sanitized, RTDB_KEY_MAX_BYTES - hash.length - 1);
  return `${truncated}_${hash}`;
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
  // bulkCreate/deleteMany/delete) — every other entity (SystemLog, User,
  // PriceAlert, ...) is returned completely untouched.
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
      // Achado na auditoria pós-3a (item 169 addendum): nenhuma das 3
      // entidades das rodadas 1/2 usa delete() singular em produção — só
      // deleteMany() — então este método nunca precisou de mirror até agora.
      // A rodada 3b introduz MonitoredAsset, e Assets.jsx remove um ativo via
      // delete(id) singular (não deleteMany) — sem este wrapper, um ativo
      // removido do Firestore ficaria pra sempre no espelho RTDB. Ao
      // contrário de deleteMany (que só espelha se o Firestore devolveu os
      // docs deletados), aqui não há ambiguidade: se entity.delete(id) não
      // lançou, o doc já não existe mais no Firestore — espelhar a remoção é
      // sempre correto.
      async delete(id) {
        const result = await entity.delete(id);
        safeMirrorCall(mirrorRemove, rtdbPath, id);
        return result;
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
