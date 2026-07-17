// Node/GitHub Actions counterpart to src/api/entities.js — same
// backend.entities.<Name>.{list,filter,create,update,delete,bulkCreate,
// deleteMany} call shape, but backed by firebase-admin (trusted server
// credentials, bypasses Firestore security rules) instead of the browser
// client SDK. This lets src/lib/scanner.js run unmodified in both places —
// see scripts/build-scan.mjs, which aliases '@/api/entities' to this file
// only when bundling for the scheduled scan job.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
// Relative (not '@/') so esbuild bundles it for the cron without the Vite alias
// — see scripts/build-scan.mjs (it only rewrites '@/api/entities').
import { canApplyTransition, isTerminalStatus, planTradeOpCreation } from '../src/lib/opTransition.js';

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
}
const db = getFirestore();

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

// Mirrors the same counter in src/api/entities.js — see that file for why
// (rough daily Firestore quota extrapolation, docs/known-risks.md item 13).
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

    // Atomic create-if-absent using a deterministic document id — mirrors
    // src/api/entities.js's createUnique so scanner.js's dedup logic behaves
    // identically whether it runs in the browser or in this cron job.
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

// Mirrors src/api/entities.js's acquireScanLock/releaseScanLock — same
// scannerLocks/{lockName} shape, using the Admin SDK's transaction API.
async function acquireScanLock(lockName, ttlMs, holder) {
  const ref = db.collection('scannerLocks').doc(lockName);
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
  const ref = db.collection('scannerLocks').doc(lockName);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().locked_by === holder) {
      tx.set(ref, { locked_by: null, locked_at: null, expires_at: 0 });
    }
  });
}

// Mirrors src/api/entities.js's createTradeOpIfNoneActive/clearActiveOp —
// same assetActiveOps/{assetId} tracking doc, so the entry idempotency
// guarantee is identical whether scanner.js runs in the browser or here.
async function createTradeOpIfNoneActive(assetId, docId, data) {
  const activeRef = db.collection('assetActiveOps').doc(assetId);
  const opRef = db.collection('tradeOperations').doc(docId);
  const payload = { ...data, created_date: data.created_date || new Date().toISOString() };
  return db.runTransaction(async (tx) => {
    // Reads precede writes; the pointed op is read so an orphan pointer (op
    // gone or terminal) never blocks the asset — decision shared with the
    // client adapter via planTradeOpCreation.
    const activeSnap = await tx.get(activeRef);
    const pointerOpId = (activeSnap.exists && activeSnap.data().active_trade_op_id) || null;
    const pointerSnap = pointerOpId && pointerOpId !== docId
      ? await tx.get(db.collection('tradeOperations').doc(pointerOpId))
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
  const activeRef = db.collection('assetActiveOps').doc(assetId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(activeRef);
    if (snap.exists && snap.data().active_trade_op_id === tradeOpId) {
      tx.set(activeRef, { active_trade_op_id: null, updated_at: new Date().toISOString() });
    }
  });
}

// Mirrors src/api/entities.js's transitionTradeOp — same compare-and-set on
// status + same in-transaction clear of assetActiveOps on terminal states,
// using the Admin SDK's transaction API. The decision itself lives in the
// shared src/lib/opTransition.js, so browser and cron can never disagree.
async function transitionTradeOp(opId, fromStatus, patch, { assetId } = {}) {
  const opRef = db.collection('tradeOperations').doc(opId);
  const terminal = isTerminalStatus(patch.status);
  const activeRef = terminal && assetId ? db.collection('assetActiveOps').doc(assetId) : null;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(opRef);
    const activeSnap = activeRef ? await tx.get(activeRef) : null;
    const current = snap.exists ? { id: snap.id, ...snap.data() } : null;
    if (!canApplyTransition(current, fromStatus)) {
      return { applied: false, currentStatus: current ? current.status : null };
    }
    tx.update(opRef, patch);
    if (activeRef && activeSnap && activeSnap.exists
        && activeSnap.data().active_trade_op_id === opId) {
      tx.set(activeRef, { active_trade_op_id: null, updated_at: new Date().toISOString() });
    }
    return { applied: true };
  });
}

export const backend = {
  entities: {
    MonitoredAsset: createEntity('monitoredAssets'),
    AssetState: createEntity('assetStates'),
    SignalEvent: createEntity('signalEvents'),
    TradeOperation: createEntity('tradeOperations'),
    PriceAlert: createEntity('priceAlerts'),
    SystemLog: createEntity('systemLogs'),
    User: createEntity('users'),
  },
  locks: { acquireScanLock, releaseScanLock },
  tradeOps: { createTradeOpIfNoneActive, clearActiveOp, transitionTradeOp },
  quota: { getAndResetOpCounts },
};

export { FieldValue };
