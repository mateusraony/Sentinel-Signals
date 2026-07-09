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
};

export { FieldValue };
