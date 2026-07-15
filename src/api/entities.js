import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit as fbLimit,
  writeBatch,
  runTransaction,
} from 'firebase/firestore';
import { db } from '@/lib/firebaseClient';
import { strategyReviewerAgent } from '@/api/agents';

function buildQuery(collectionName, filters = {}, sort, limitCount) {
  const constraints = [];
  Object.entries(filters).forEach(([field, value]) => {
    if (value === undefined) return;
    // Array value -> Firestore 'in' (max 30 values), so callers can filter
    // to a small set of statuses server-side instead of fetching every
    // document and filtering client-side (billed per document read).
    constraints.push(Array.isArray(value) ? where(field, 'in', value) : where(field, '==', value));
  });
  if (sort) {
    const descending = sort.startsWith('-');
    const field = descending ? sort.slice(1) : sort;
    constraints.push(orderBy(field, descending ? 'desc' : 'asc'));
  }
  if (limitCount) constraints.push(fbLimit(limitCount));
  return query(collection(db, collectionName), ...constraints);
}

function snapshotToArray(snapshot) {
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

// Rough, best-effort Firestore read/write counter — not exact (the
// transaction-based helpers below aren't instrumented, and this doesn't
// survive a process restart), but good enough to extrapolate a daily
// estimate and warn before the free Spark plan's daily quota is hit (see
// docs/known-risks.md item 13). Reads are counted per document returned,
// matching how Firestore actually bills a query.
let opCounts = { reads: 0, writes: 0 };
export function getAndResetOpCounts() {
  const counts = { ...opCounts };
  opCounts = { reads: 0, writes: 0 };
  return counts;
}

// Thin Firestore adapter preserving the backend.entities.<Name>.{list,filter,create,
// update,delete,bulkCreate,deleteMany} call shape used throughout the app.
function createEntity(collectionName) {
  return {
    async list(sort, limitCount) {
      const snapshot = await getDocs(buildQuery(collectionName, {}, sort, limitCount));
      opCounts.reads += snapshot.docs.length;
      return snapshotToArray(snapshot);
    },

    async filter(filters = {}, sort, limitCount) {
      const snapshot = await getDocs(buildQuery(collectionName, filters, sort, limitCount));
      opCounts.reads += snapshot.docs.length;
      return snapshotToArray(snapshot);
    },

    async get(id) {
      const snap = await getDoc(doc(db, collectionName, id));
      opCounts.reads += 1;
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    },

    // Upsert by id (merges with any existing fields) — used for singleton
    // config documents like strategyConfig/current.
    async set(id, data) {
      const ref = doc(db, collectionName, id);
      await setDoc(ref, data, { merge: true });
      opCounts.writes += 1;
      return { id, ...data };
    },

    async create(data) {
      const payload = { ...data, created_date: data.created_date || new Date().toISOString() };
      const ref = await addDoc(collection(db, collectionName), payload);
      opCounts.writes += 1;
      return { id: ref.id, ...payload };
    },

    // Atomic create-if-absent using a deterministic document id, so two
    // concurrent callers (browser + cron) racing on the same dedup key
    // can never both succeed — the transaction serializes the check.
    async createUnique(id, data) {
      const ref = doc(db, collectionName, id);
      const payload = { ...data, created_date: data.created_date || new Date().toISOString() };
      return runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) {
          return { created: false, existing: { id: snap.id, ...snap.data() } };
        }
        tx.set(ref, payload);
        return { created: true, doc: { id, ...payload } };
      });
    },

    async update(id, data) {
      await updateDoc(doc(db, collectionName, id), data);
      opCounts.writes += 1;
      return { id, ...data };
    },

    async delete(id) {
      await deleteDoc(doc(db, collectionName, id));
      opCounts.writes += 1;
    },

    async bulkCreate(items) {
      const batch = writeBatch(db);
      const created = items.map((item) => {
        const ref = doc(collection(db, collectionName));
        const payload = { ...item, created_date: item.created_date || new Date().toISOString() };
        batch.set(ref, payload);
        return { id: ref.id, ...payload };
      });
      await batch.commit();
      opCounts.writes += created.length;
      return created;
    },

    async deleteMany(filters = {}) {
      const snapshot = await getDocs(buildQuery(collectionName, filters));
      opCounts.reads += snapshot.docs.length;
      const batch = writeBatch(db);
      snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();
      opCounts.writes += snapshot.docs.length;
    },
  };
}

// Prevents two concurrent scan runs (browser auto-scan + GitHub Actions
// cron) from processing the same batch at once. `scannerLocks/{lockName}`
// holds `{ locked_by, locked_at, expires_at }`; acquisition is a transaction
// so the check-then-write can't race between two callers.
async function acquireScanLock(lockName, ttlMs, holder) {
  const ref = doc(db, 'scannerLocks', lockName);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    if (snap.exists() && snap.data().expires_at > now) {
      return false;
    }
    tx.set(ref, { locked_by: holder, locked_at: now, expires_at: now + ttlMs });
    return true;
  });
}

async function releaseScanLock(lockName, holder) {
  const ref = doc(db, 'scannerLocks', lockName);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists() && snap.data().locked_by === holder) {
      tx.set(ref, { locked_by: null, locked_at: null, expires_at: 0 });
    }
  });
}

// Firestore transactions can only read documents, not queries — so "does
// this asset already have an active TradeOperation" is tracked in a single
// side document (`assetActiveOps/{assetId}`) instead of a filtered query,
// which lets create-if-none-active be a single atomic transaction.
async function createTradeOpIfNoneActive(assetId, docId, data) {
  const activeRef = doc(db, 'assetActiveOps', assetId);
  const opRef = doc(db, 'tradeOperations', docId);
  const payload = { ...data, created_date: data.created_date || new Date().toISOString() };
  return runTransaction(db, async (tx) => {
    const activeSnap = await tx.get(activeRef);
    if (activeSnap.exists() && activeSnap.data().active_trade_op_id) {
      return { created: false, existingId: activeSnap.data().active_trade_op_id };
    }
    const opSnap = await tx.get(opRef);
    if (opSnap.exists()) {
      tx.set(activeRef, { active_trade_op_id: opRef.id, updated_at: new Date().toISOString() });
      return { created: false, existing: { id: opRef.id, ...opSnap.data() } };
    }
    tx.set(opRef, payload);
    tx.set(activeRef, { active_trade_op_id: opRef.id, updated_at: new Date().toISOString() });
    return { created: true, doc: { id: docId, ...payload } };
  });
}

// Called when a TradeOperation reaches a terminal status (STOP_HIT, TP2_HIT,
// INVALIDATED, CLOSED) so the asset becomes eligible for a new entry again.
async function clearActiveOp(assetId, tradeOpId) {
  const activeRef = doc(db, 'assetActiveOps', assetId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(activeRef);
    if (snap.exists() && snap.data().active_trade_op_id === tradeOpId) {
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
    StrategyConfig: createEntity('strategyConfig'),
  },
  agents: strategyReviewerAgent,
  locks: { acquireScanLock, releaseScanLock },
  tradeOps: { createTradeOpIfNoneActive, clearActiveOp },
  quota: { getAndResetOpCounts },
};
