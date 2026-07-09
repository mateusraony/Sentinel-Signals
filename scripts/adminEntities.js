// Node/GitHub Actions counterpart to src/api/entities.js — same
// backend.entities.<Name>.{list,filter,create,update,delete,bulkCreate,
// deleteMany} call shape, but backed by firebase-admin (trusted server
// credentials, bypasses Firestore security rules) instead of the browser
// client SDK. This lets src/lib/scanner.js run unmodified in both places —
// see scripts/build-scan.mjs, which aliases '@/api/entities' to this file
// only when bundling for the scheduled scan job.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
}
const db = getFirestore();

function applyFilters(collectionRef, filters = {}) {
  let q = collectionRef;
  Object.entries(filters).forEach(([field, value]) => {
    if (value !== undefined) q = q.where(field, '==', value);
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

function createEntity(collectionName) {
  const col = () => db.collection(collectionName);

  return {
    async list(sort, limitCount) {
      let q = applySort(col(), sort);
      if (limitCount) q = q.limit(limitCount);
      return snapshotToArray(await q.get());
    },

    async filter(filters = {}, sort, limitCount) {
      let q = applySort(applyFilters(col(), filters), sort);
      if (limitCount) q = q.limit(limitCount);
      return snapshotToArray(await q.get());
    },

    async create(data) {
      const payload = { ...data, created_date: data.created_date || new Date().toISOString() };
      const ref = await col().add(payload);
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
      return { id, ...data };
    },

    async delete(id) {
      await col().doc(id).delete();
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
      return created;
    },

    async deleteMany(filters = {}) {
      const snapshot = await applyFilters(col(), filters).get();
      const batch = db.batch();
      snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();
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
    const activeSnap = await tx.get(activeRef);
    if (activeSnap.exists && activeSnap.data().active_trade_op_id) {
      return { created: false, existingId: activeSnap.data().active_trade_op_id };
    }
    const opSnap = await tx.get(opRef);
    if (opSnap.exists) {
      tx.set(activeRef, { active_trade_op_id: opRef.id, updated_at: new Date().toISOString() });
      return { created: false, existing: { id: opRef.id, ...opSnap.data() } };
    }
    tx.set(opRef, payload);
    tx.set(activeRef, { active_trade_op_id: opRef.id, updated_at: new Date().toISOString() });
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
  tradeOps: { createTradeOpIfNoneActive, clearActiveOp },
};

export { FieldValue };
