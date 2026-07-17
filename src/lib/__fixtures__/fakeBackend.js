// Test-only in-memory stand-in for src/api/entities.js's `backend` — same
// call shape (entities.<Name>.{list,filter,create,update,createUnique,
// delete,bulkCreate,deleteMany}, locks, tradeOps), but backed by plain Maps
// instead of Firestore. Reuses the REAL canApplyTransition/isTerminalStatus
// from src/lib/opTransition.js so transitionTradeOp enforces the exact same
// compare-and-set guard as production — only the storage is fake, not the
// decision. Lets scanner.js run completely unmodified against it (see
// scannerStateMachine.test.js), the same principle already used for the
// browser/cron split (src/api/entities.js vs scripts/adminEntities.js).
import { canApplyTransition, isTerminalStatus, planTradeOpCreation } from '../opTransition.js';

const COLLECTIONS = [
  'MonitoredAsset', 'AssetState', 'SignalEvent', 'TradeOperation',
  'PriceAlert', 'SystemLog', 'User',
];

function matches(doc, filters) {
  return Object.entries(filters).every(([field, value]) => {
    if (value === undefined) return true;
    return Array.isArray(value) ? value.includes(doc[field]) : doc[field] === value;
  });
}

function applySort(arr, sort) {
  if (!sort) return arr;
  const descending = sort.startsWith('-');
  const field = descending ? sort.slice(1) : sort;
  const sorted = [...arr].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0));
  return descending ? sorted.reverse() : sorted;
}

export function createFakeBackend() {
  const stores = Object.fromEntries(COLLECTIONS.map((name) => [name, new Map()]));
  const activeOps = new Map(); // assetId -> tradeOpId | null
  let counter = 0;
  const nextId = (prefix) => `${prefix}_${++counter}`;

  function createEntity(name) {
    const store = stores[name];
    return {
      async list(sort, limitCount) {
        let arr = applySort([...store.values()], sort);
        if (limitCount) arr = arr.slice(0, limitCount);
        return arr;
      },
      async filter(filters = {}, sort, limitCount) {
        let arr = applySort([...store.values()].filter((d) => matches(d, filters)), sort);
        if (limitCount) arr = arr.slice(0, limitCount);
        return arr;
      },
      async create(data) {
        const id = nextId(name);
        const doc = { created_date: new Date().toISOString(), ...data, id };
        store.set(id, doc);
        return doc;
      },
      async createUnique(id, data) {
        if (store.has(id)) return { created: false, existing: store.get(id) };
        const doc = { created_date: new Date().toISOString(), ...data, id };
        store.set(id, doc);
        return { created: true, doc };
      },
      async update(id, data) {
        const doc = { ...(store.get(id) || {}), ...data, id };
        store.set(id, doc);
        return doc;
      },
      async delete(id) {
        store.delete(id);
      },
      async bulkCreate(items) {
        return items.map((item) => {
          const id = nextId(name);
          const doc = { created_date: new Date().toISOString(), ...item, id };
          store.set(id, doc);
          return doc;
        });
      },
      async deleteMany(filters = {}) {
        [...store.values()].filter((d) => matches(d, filters)).forEach((d) => store.delete(d.id));
      },
    };
  }

  async function acquireScanLock() {
    return true;
  }
  async function releaseScanLock() {}

  async function createTradeOpIfNoneActive(assetId, docId, data) {
    const opStore = stores.TradeOperation;
    const pointerOpId = activeOps.get(assetId) || null;
    const plan = planTradeOpCreation({
      pointerOpId,
      pointerOp: pointerOpId ? opStore.get(pointerOpId) || null : null,
      existingOp: opStore.get(docId) || null,
    });
    if (plan.action === 'blocked') return { created: false, existingId: pointerOpId };
    if (plan.pointer === 'set') activeOps.set(assetId, docId);
    else if (plan.pointer === 'clear') activeOps.set(assetId, null);
    if (plan.action === 'reuse') return { created: false, existing: opStore.get(docId) };
    const doc = { created_date: new Date().toISOString(), ...data, id: docId };
    opStore.set(docId, doc);
    return { created: true, doc };
  }

  async function clearActiveOp(assetId, tradeOpId) {
    if (activeOps.get(assetId) === tradeOpId) activeOps.set(assetId, null);
  }

  async function transitionTradeOp(opId, fromStatus, patch, { assetId } = {}) {
    const opStore = stores.TradeOperation;
    const current = opStore.get(opId) || null;
    if (!canApplyTransition(current, fromStatus)) {
      return { applied: false, currentStatus: current ? current.status : null };
    }
    opStore.set(opId, { ...current, ...patch });
    if (isTerminalStatus(patch.status) && assetId && activeOps.get(assetId) === opId) {
      activeOps.set(assetId, null);
    }
    return { applied: true };
  }

  return {
    entities: Object.fromEntries(COLLECTIONS.map((name) => [name, createEntity(name)])),
    locks: { acquireScanLock, releaseScanLock },
    tradeOps: { createTradeOpIfNoneActive, clearActiveOp, transitionTradeOp },
    quota: { getAndResetOpCounts: () => ({ reads: 0, writes: 0 }) },
    // Test-only escape hatch to seed/inspect docs directly without going
    // through the async entity API.
    _seed(name, doc) {
      stores[name].set(doc.id, doc);
      return doc;
    },
    _get(name, id) {
      return stores[name].get(id);
    },
    _getActiveOp(assetId) {
      return activeOps.get(assetId) ?? null;
    },
    _setActiveOp(assetId, tradeOpId) {
      activeOps.set(assetId, tradeOpId);
    },
  };
}
