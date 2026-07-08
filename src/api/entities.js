import {
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit as fbLimit,
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebaseClient';

function buildQuery(collectionName, filters = {}, sort, limitCount) {
  const constraints = [];
  Object.entries(filters).forEach(([field, value]) => {
    if (value !== undefined) constraints.push(where(field, '==', value));
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

// Thin Firestore adapter preserving the base44.entities.<Name>.{list,filter,create,
// update,delete,bulkCreate,deleteMany} call shape used throughout the app.
function createEntity(collectionName) {
  return {
    async list(sort, limitCount) {
      const snapshot = await getDocs(buildQuery(collectionName, {}, sort, limitCount));
      return snapshotToArray(snapshot);
    },

    async filter(filters = {}, sort, limitCount) {
      const snapshot = await getDocs(buildQuery(collectionName, filters, sort, limitCount));
      return snapshotToArray(snapshot);
    },

    async create(data) {
      const payload = { ...data, created_date: data.created_date || new Date().toISOString() };
      const ref = await addDoc(collection(db, collectionName), payload);
      return { id: ref.id, ...payload };
    },

    async update(id, data) {
      await updateDoc(doc(db, collectionName, id), data);
      return { id, ...data };
    },

    async delete(id) {
      await deleteDoc(doc(db, collectionName, id));
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
      return created;
    },

    async deleteMany(filters = {}) {
      const snapshot = await getDocs(buildQuery(collectionName, filters));
      const batch = writeBatch(db);
      snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();
    },
  };
}

export const base44 = {
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
