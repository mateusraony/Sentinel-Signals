// Shadow-mode counterpart to scripts/adminEntities.js — Fase 1 modo sombra
// prospectivo (docs/known-risks.md item 56 "Modo sombra"). Same
// backend.entities.<Name>.{list,filter,create,update,delete,bulkCreate,
// deleteMany} call shape, so src/lib/scanner.js runs completely unmodified
// (see scripts/build-scan-shadow.mjs, which aliases '@/api/entities' to
// this file only when bundling for the shadow workflow) — but every write
// lands in a Firestore collection PREFIXED with 'experimentalRf1hShadow',
// never the real production collections that scripts/adminEntities.js
// writes to.
//
// Deliberately NOT refactored to share code with adminEntities.js — same
// safe-duplication precedent already used by src/lib/__fixtures__/
// fakeBackend.js for tests: this file must never risk a regression on the
// real production write path just because someone edited it for the
// shadow experiment. The isolation this buys is verified by
// adminEntitiesShadowTripwire.test.js, which reads this file's own source
// text and fails if an unprefixed production collection name ever shows
// up as a db.collection(...) argument.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { canApplyTransition, clampMonotonicStop, stopAdvanceCandidateWon, isTerminalStatus, planTradeOpCreation } from '../src/lib/opTransition.js';

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
}
const db = getFirestore();

const SHADOW_PREFIX = 'experimentalRf1hShadow';

function applyFilters(collectionRef, filters = {}) {
  let q = collectionRef;
  Object.entries(filters).forEach(([field, value]) => {
    if (value === undefined) return;
    q = Array.isArray(value) ? q.where(field, 'in', value) : q.where(field, '==', value);
  });
  return q;
}

function applySort(q, sort) {
  if (!sort) return q;
  const descending = sort.startsWith('-');
  const field = descending ? sort.slice(1) : sort;
  return q.orderBy(field, descending ? 'desc' : 'asc');
}

function snapshotToArray(snapshot) {
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

let opCounts = { reads: 0, writes: 0 };
export function getAndResetOpCounts() {
  const counts = { ...opCounts };
  opCounts = { reads: 0, writes: 0 };
  return counts;
}

function createEntity(collectionName) {
  const col = () => db.collection(collectionName);

  return {
    async list(sort, limitCount) {
      let q = applySort(col(), sort);
      if (limitCount) q = q.limit(limitCount);
      const snapshot = await q.get();
      opCounts.reads += snapshot.docs.length;
      return snapshotToArray(snapshot);
    },

    async filter(filters = {}, sort, limitCount) {
      let q = applySort(applyFilters(col(), filters), sort);
      if (limitCount) q = q.limit(limitCount);
      const snapshot = await q.get();
      opCounts.reads += snapshot.docs.length;
      return snapshotToArray(snapshot);
    },

    async create(data) {
      const payload = { ...data, created_date: data.created_date || new Date().toISOString() };
      const ref = await col().add(payload);
      opCounts.writes += 1;
      return { id: ref.id, ...payload };
    },

    async createUnique(id, data) {
      const ref = col().doc(id);
      const payload = { ...data, created_date: data.created_date || new Date().toISOString() };
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) {
          return { created: false, existing: { id: snap.id, ...snap.data() } };
        }
        tx.set(ref, payload);
        return { created: true, doc: { id, ...payload } };
      });
    },

    async update(id, data) {
      await col().doc(id).update(data);
      opCounts.writes += 1;
      return { id, ...data };
    },

    async delete(id) {
      await col().doc(id).delete();
      opCounts.writes += 1;
    },

    async bulkCreate(items) {
      const batch = db.batch();
      const created = items.map((item) => {
        const ref = col().doc();
        const payload = { ...item, created_date: item.created_date || new Date().toISOString() };
        batch.set(ref, payload);
        return { id: ref.id, ...payload };
      });
      await batch.commit();
      opCounts.writes += created.length;
      return created;
    },

    async deleteMany(filters = {}) {
      const snapshot = await applyFilters(col(), filters).get();
      opCounts.reads += snapshot.docs.length;
      const batch = db.batch();
      snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();
      opCounts.writes += snapshot.docs.length;
    },
  };
}

// MonitoredAsset is the one entity scanner.js both READS and WRITES on
// every pass (scanAsset/scanAllAssetsInner write last_scan_at/scan_status/
// scan_error/scan_error_since bookkeeping, src/lib/scanner.js ~line 2991
// and ~3317 — confirmed the ONLY 2 write sites for this entity). Reads
// must hit the REAL monitoredAssets collection (the real, live list of
// monitored assets and their per-asset rf_period/rf_multiplier/smc_enabled
// config — the actual candidate universe this experiment is meant to
// observe). Writes must NEVER touch that collection — a shadow scan's
// last_scan_at/scan_status has zero value and would corrupt real
// production bookkeeping (e.g. falsely clearing/setting a stale-asset
// alert timer) if it landed there. So every write method here is an
// explicit, harmless no-op instead of a redirected write.
function createMonitoredAssetShadowEntity() {
  const real = createEntity('monitoredAssets');
  return {
    list: real.list,
    filter: real.filter,
    async create() { return null; },
    async createUnique() { return { created: false, existing: null }; },
    async update() { return null; },
    async delete() {},
    async bulkCreate() { return []; },
    async deleteMany() {},
  };
}

async function acquireScanLock(lockName, ttlMs, holder) {
  const ref = db.collection(`${SHADOW_PREFIX}ScannerLocks`).doc(lockName);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    if (snap.exists && snap.data().expires_at > now) {
      return false;
    }
    tx.set(ref, { locked_by: holder, locked_at: now, expires_at: now + ttlMs });
    return true;
  });
}

async function releaseScanLock(lockName, holder) {
  const ref = db.collection(`${SHADOW_PREFIX}ScannerLocks`).doc(lockName);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().locked_by === holder) {
      tx.set(ref, { locked_by: null, locked_at: null, expires_at: 0 });
    }
  });
}

async function createTradeOpIfNoneActive(assetId, docId, data) {
  const activeRef = db.collection(`${SHADOW_PREFIX}AssetActiveOps`).doc(assetId);
  const opRef = db.collection(`${SHADOW_PREFIX}TradeOperations`).doc(docId);
  const payload = { ...data, created_date: data.created_date || new Date().toISOString() };
  return db.runTransaction(async (tx) => {
    const activeSnap = await tx.get(activeRef);
    const pointerOpId = (activeSnap.exists && activeSnap.data().active_trade_op_id) || null;
    const pointerSnap = pointerOpId && pointerOpId !== docId
      ? await tx.get(db.collection(`${SHADOW_PREFIX}TradeOperations`).doc(pointerOpId))
      : null;
    const opSnap = await tx.get(opRef);
    const existingOp = opSnap.exists ? opSnap.data() : null;
    const plan = planTradeOpCreation({
      pointerOpId,
      pointerOp: pointerOpId === docId
        ? existingOp
        : (pointerSnap && pointerSnap.exists ? pointerSnap.data() : null),
      existingOp,
    });
    if (plan.action === 'blocked') return { created: false, existingId: pointerOpId };
    if (plan.pointer === 'set') {
      tx.set(activeRef, { active_trade_op_id: opRef.id, updated_at: new Date().toISOString() });
    } else if (plan.pointer === 'clear') {
      tx.set(activeRef, { active_trade_op_id: null, updated_at: new Date().toISOString() });
    }
    if (plan.action === 'reuse') return { created: false, existing: { id: opRef.id, ...existingOp } };
    tx.set(opRef, payload);
    return { created: true, doc: { id: docId, ...payload } };
  });
}

async function clearActiveOp(assetId, tradeOpId) {
  const activeRef = db.collection(`${SHADOW_PREFIX}AssetActiveOps`).doc(assetId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(activeRef);
    if (snap.exists && snap.data().active_trade_op_id === tradeOpId) {
      tx.set(activeRef, { active_trade_op_id: null, updated_at: new Date().toISOString() });
    }
  });
}

async function transitionTradeOp(opId, fromStatus, patch, { assetId, stopAdvanceMarkerField } = {}) {
  const opRef = db.collection(`${SHADOW_PREFIX}TradeOperations`).doc(opId);
  const terminal = isTerminalStatus(patch.status);
  const activeRef = terminal && assetId ? db.collection(`${SHADOW_PREFIX}AssetActiveOps`).doc(assetId) : null;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(opRef);
    const activeSnap = activeRef ? await tx.get(activeRef) : null;
    const current = snap.exists ? { id: snap.id, ...snap.data() } : null;
    if (!canApplyTransition(current, fromStatus)) {
      return { applied: false, currentStatus: current ? current.status : null };
    }
    let safePatch = patch;
    if (patch.current_stop != null) {
      const clampedStop = clampMonotonicStop({ side: current.side, existingStop: current.current_stop, candidateStop: patch.current_stop });
      safePatch = { ...patch, current_stop: clampedStop };
      if (stopAdvanceMarkerField && !stopAdvanceCandidateWon({ clampedStop, candidateStop: patch.current_stop })) {
        delete safePatch[stopAdvanceMarkerField];
      }
    }
    tx.update(opRef, safePatch);
    if (activeRef && activeSnap && activeSnap.exists
        && activeSnap.data().active_trade_op_id === opId) {
      tx.set(activeRef, { active_trade_op_id: null, updated_at: new Date().toISOString() });
    }
    return { applied: true };
  });
}

export const backend = {
  entities: {
    MonitoredAsset: createMonitoredAssetShadowEntity(),
    AssetState: createEntity(`${SHADOW_PREFIX}AssetStates`),
    SignalEvent: createEntity(`${SHADOW_PREFIX}SignalEvents`),
    TradeOperation: createEntity(`${SHADOW_PREFIX}TradeOperations`),
    PriceAlert: createEntity(`${SHADOW_PREFIX}PriceAlerts`),
    SystemLog: createEntity(`${SHADOW_PREFIX}SystemLogs`),
    User: createEntity(`${SHADOW_PREFIX}Users`),
  },
  locks: { acquireScanLock, releaseScanLock },
  tradeOps: { createTradeOpIfNoneActive, clearActiveOp, transitionTradeOp },
  quota: { getAndResetOpCounts },
};
