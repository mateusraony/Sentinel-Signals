// Test-only in-memory stand-in for src/api/entities.js's `backend` — same
// call shape (entities.<Name>.{list,filter,create,update,createUnique,
// delete,bulkCreate,deleteMany}, locks, tradeOps), but backed by plain Maps
// instead of Firestore. Reuses the REAL canApplyTransition/isTerminalStatus
// from src/lib/opTransition.js so transitionTradeOp enforces the exact same
// compare-and-set guard as production — only the storage is fake, not the
// decision. Lets scanner.js run completely unmodified against it (see
// scannerStateMachine.test.js), the same principle already used for the
// browser/cron split (src/api/entities.js vs scripts/adminEntities.js).
import { canApplyTransition, clampMonotonicStop, stopAdvanceCandidateWon, isTerminalStatus, planTradeOpCreation, buildActiveOpsAnchorId } from '../opTransition.js';
import { matchesFilter } from '../queryFilters.js';

const COLLECTIONS = [
  'MonitoredAsset', 'AssetState', 'SignalEvent', 'TradeOperation',
  'PriceAlert', 'SystemLog', 'User', 'VerificationTask',
];

function matches(doc, filters) {
  // Comparação delegada a src/lib/queryFilters.js — o MESMO módulo que
  // traduz o filtro para a query nativa no browser e no cron, para o fake
  // nunca divergir do operador real (known-risks item 133).
  return Object.entries(filters).every(([field, value]) => matchesFilter(field, value, doc[field]));
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

  async function createTradeOpIfNoneActive(assetId, docId, data, cascade) {
    const opStore = stores.TradeOperation;
    const anchorId = buildActiveOpsAnchorId(assetId, cascade);
    const pointerOpId = activeOps.get(anchorId) || null;
    const plan = planTradeOpCreation({
      pointerOpId,
      pointerOp: pointerOpId ? opStore.get(pointerOpId) || null : null,
      existingOp: opStore.get(docId) || null,
    });
    if (plan.action === 'blocked') return { created: false, existingId: pointerOpId };
    if (plan.pointer === 'set') activeOps.set(anchorId, docId);
    else if (plan.pointer === 'clear') activeOps.set(anchorId, null);
    if (plan.action === 'reuse') return { created: false, existing: opStore.get(docId) };
    const doc = { created_date: new Date().toISOString(), ...data, id: docId };
    opStore.set(docId, doc);
    return { created: true, doc };
  }

  async function clearActiveOp(assetId, tradeOpId, cascade) {
    const anchorId = buildActiveOpsAnchorId(assetId, cascade);
    if (activeOps.get(anchorId) === tradeOpId) activeOps.set(anchorId, null);
  }

  /**
   * @param {string} opId
   * @param {string} fromStatus
   * @param {object} patch
   * @param {{ assetId?: string, stopAdvanceMarkerField?: string, cascade?: string }} [options]
   */
  async function transitionTradeOp(opId, fromStatus, patch, { assetId, stopAdvanceMarkerField, cascade } = {}) {
    const opStore = stores.TradeOperation;
    const current = opStore.get(opId) || null;
    if (!canApplyTransition(current, fromStatus)) {
      return { applied: false, currentStatus: current ? current.status : null };
    }
    let safePatch = patch;
    if (patch.current_stop != null) {
      const clampedStop = clampMonotonicStop({ side: current.side, existingStop: current.current_stop, candidateStop: patch.current_stop });
      safePatch = { ...patch, current_stop: clampedStop };
      // docs/known-risks.md item 59 addendum — see src/api/entities.js's
      // mirror of this function for the full comment.
      if (stopAdvanceMarkerField && !stopAdvanceCandidateWon({
        clampedStop,
        candidateStop: patch.current_stop,
        candidateCandleTime: patch[stopAdvanceMarkerField],
        existingMarkerCandleTime: current[stopAdvanceMarkerField],
      })) {
        delete safePatch[stopAdvanceMarkerField];
      }
    }
    opStore.set(opId, { ...current, ...safePatch });
    const anchorId = buildActiveOpsAnchorId(assetId, cascade);
    if (isTerminalStatus(patch.status) && assetId && activeOps.get(anchorId) === opId) {
      activeOps.set(anchorId, null);
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
    _getActiveOp(assetId, cascade) {
      return activeOps.get(buildActiveOpsAnchorId(assetId, cascade)) ?? null;
    },
    _setActiveOp(assetId, tradeOpId, cascade) {
      activeOps.set(buildActiveOpsAnchorId(assetId, cascade), tradeOpId);
    },
  };
}
