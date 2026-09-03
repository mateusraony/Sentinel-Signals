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
import { ref, set as rtdbSet, update as rtdbUpdate, remove as rtdbRemove } from 'firebase/database';
import { db, rtdb } from '@/lib/firebaseClient';
import { strategyReviewerAgent } from '@/api/agents';
import { canApplyTransition, clampMonotonicStop, stopAdvanceCandidateWon, isTerminalStatus, planTradeOpCreation, buildActiveOpsAnchorId } from '@/lib/opTransition';
import { classifyFilter } from '@/lib/queryFilters';
import { toRtdbKey, createRtdbMirrorHelpers } from '@/lib/rtdbMirror';

// Firestore→RTDB read mirror (docs/known-risks.md item 152) — fire-and-forget,
// never awaited by the callers below, and always a no-op when RTDB isn't
// provisioned in this environment (rtdb === null, see firebaseClient.js).
// See src/lib/rtdbMirror.js for why the key is sanitized and why these
// helpers never throw.
function mirrorSet(rtdbPath, firestoreId, value) {
  if (!rtdb) return;
  rtdbSet(ref(rtdb, `${rtdbPath}/${toRtdbKey(firestoreId)}`), value)
    .catch((e) => console.warn(`[RTDB mirror] set falhou (${rtdbPath}/${firestoreId}), ignorado:`, e.message));
}
function mirrorUpdate(rtdbPath, firestoreId, patch) {
  if (!rtdb) return;
  rtdbUpdate(ref(rtdb, `${rtdbPath}/${toRtdbKey(firestoreId)}`), patch)
    .catch((e) => console.warn(`[RTDB mirror] update falhou (${rtdbPath}/${firestoreId}), ignorado:`, e.message));
}
function mirrorRemove(rtdbPath, firestoreId) {
  if (!rtdb) return;
  rtdbRemove(ref(rtdb, `${rtdbPath}/${toRtdbKey(firestoreId)}`))
    .catch((e) => console.warn(`[RTDB mirror] remove falhou (${rtdbPath}/${firestoreId}), ignorado:`, e.message));
}
const { withRtdbMirror, withCreateOpMirror, withTransitionOpMirror } = createRtdbMirrorHelpers({ mirrorSet, mirrorUpdate, mirrorRemove });

function buildQuery(collectionName, filters = {}, sort, limitCount) {
  const constraints = [];
  Object.entries(filters).forEach(([field, value]) => {
    // Array value -> Firestore 'in' (max 30 values); { gte: x } -> range
    // '>=' server-side. Ambos existem pelo mesmo motivo: filtrar no
    // servidor em vez de buscar documento para descartar no cliente
    // (cobrado por documento lido). Semântica compartilhada com o cron e o
    // fake em src/lib/queryFilters.js — ver known-risks item 133.
    const parsed = classifyFilter(field, value);
    if (parsed.kind === 'skip') return;
    if (parsed.kind === 'in') constraints.push(where(field, 'in', parsed.operand));
    else if (parsed.kind === 'range') parsed.ranges.forEach(({ operator, operand }) => constraints.push(where(field, operator, operand)));
    else constraints.push(where(field, '==', parsed.operand));
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
      const deleted = snapshotToArray(snapshot);
      const batch = writeBatch(db);
      snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();
      opCounts.writes += snapshot.docs.length;
      return deleted;
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
async function createTradeOpIfNoneActive(assetId, docId, data, cascade) {
  const activeRef = doc(db, 'assetActiveOps', buildActiveOpsAnchorId(assetId, cascade));
  const opRef = doc(db, 'tradeOperations', docId);
  const payload = { ...data, created_date: data.created_date || new Date().toISOString() };
  return runTransaction(db, async (tx) => {
    // All reads must precede writes in a Firestore transaction. The pointed
    // op is read too: a pointer whose op is gone or terminal is an orphan
    // (nothing else can clear it — the CAS rejects terminal ops) and must not
    // block the asset; planTradeOpCreation (shared with the admin adapter and
    // the test fake) makes that call.
    const activeSnap = await tx.get(activeRef);
    const pointerOpId = (activeSnap.exists() && activeSnap.data().active_trade_op_id) || null;
    const pointerSnap = pointerOpId && pointerOpId !== docId
      ? await tx.get(doc(db, 'tradeOperations', pointerOpId))
      : null;
    const opSnap = await tx.get(opRef);
    const existingOp = opSnap.exists() ? opSnap.data() : null;
    const plan = planTradeOpCreation({
      pointerOpId,
      pointerOp: pointerOpId === docId
        ? existingOp
        : (pointerSnap && pointerSnap.exists() ? pointerSnap.data() : null),
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

// Called when a TradeOperation reaches a terminal status (STOP_HIT, TP2_HIT,
// INVALIDATED, CLOSED) so the asset becomes eligible for a new entry again.
async function clearActiveOp(assetId, tradeOpId, cascade) {
  const activeRef = doc(db, 'assetActiveOps', buildActiveOpsAnchorId(assetId, cascade));
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(activeRef);
    if (snap.exists() && snap.data().active_trade_op_id === tradeOpId) {
      tx.set(activeRef, { active_trade_op_id: null, updated_at: new Date().toISOString() });
    }
  });
}

// Compare-and-set status write for a TradeOperation. Applies `patch` only if
// the op's status in Firestore still equals `fromStatus` (and isn't terminal),
// so a concurrent worker — the browser scan and the cron run under separate
// locks — can't clobber a newer state, resurrect a terminal op, or cause a
// duplicate notification (the caller gates notify on `applied`). When the patch
// lands a terminal status, `assetActiveOps/{assetId}` is cleared in the SAME
// transaction, closing the window where a crash between the status write and a
// separate clearActiveOp would strand the asset (blocking any new entry).
/**
 * @param {string} opId
 * @param {string} fromStatus
 * @param {object} patch
 * @param {{ assetId?: string, stopAdvanceMarkerField?: string, cascade?: string }} [options]
 */
async function transitionTradeOp(opId, fromStatus, patch, { assetId, stopAdvanceMarkerField, cascade } = {}) {
  const opRef = doc(db, 'tradeOperations', opId);
  const terminal = isTerminalStatus(patch.status);
  const activeRef = terminal && assetId ? doc(db, 'assetActiveOps', buildActiveOpsAnchorId(assetId, cascade)) : null;
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(opRef);
    // All reads must precede writes in a Firestore transaction.
    const activeSnap = activeRef ? await tx.get(activeRef) : null;
    /** @type {({ id: string, status?: string, side?: string, current_stop?: number } & Record<string, any>)|null} */
    const current = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    if (!canApplyTransition(current, fromStatus)) {
      return { applied: false, currentStatus: current ? current.status : null };
    }
    let safePatch = patch;
    if (patch.current_stop != null) {
      const clampedStop = clampMonotonicStop({ side: current.side, existingStop: current.current_stop, candidateStop: patch.current_stop });
      safePatch = { ...patch, current_stop: clampedStop };
      // docs/known-risks.md item 59 addendum — a losing candidate (clamped
      // away by a fresher value another worker already committed) must not
      // overwrite the candle-time marker with the candle IT read; that
      // would misidentify which candle produced the value actually stored.
      if (stopAdvanceMarkerField && !stopAdvanceCandidateWon({
        clampedStop,
        candidateStop: patch.current_stop,
        candidateCandleTime: patch[stopAdvanceMarkerField],
        existingMarkerCandleTime: current[stopAdvanceMarkerField],
      })) {
        delete safePatch[stopAdvanceMarkerField];
      }
    }
    tx.update(opRef, safePatch);
    if (activeRef && activeSnap && activeSnap.exists()
        && activeSnap.data().active_trade_op_id === opId) {
      tx.set(activeRef, { active_trade_op_id: null, updated_at: new Date().toISOString() });
    }
    return { applied: true, patch: safePatch };
  });
}

// SystemLog writes are pure observability (Debug Log/audit trail) — never
// load-bearing for trading state, and every caller in scanner.js already
// treats them as fire-and-forget (bare `await`, return value never read).
// Real incident (docs/known-risks.md item 138 addendum): a single SystemLog
// write failing (observed: a spurious ALREADY_EXISTS from an auto-ID
// create()/addDoc(), the documented gRPC-retry-after-lost-ack quirk) was
// propagating all the way up through persistScanResults and aborting the
// ENTIRE scan pass for that asset — discarding real signal-detection work
// and marking a healthy asset scan_status:'error' for hours. Wraps ONLY
// this entity's create/createUnique, never the generic createEntity()
// factory other entities share — a real TradeOperation/MonitoredAsset/
// SignalEvent write failure must keep throwing (see P0-h,
// .claude/rules/trading-engine.md).
// console.warn (not logWarn) is deliberate here, not a lint regression: this
// IS the SystemLog write path, and logger.js's logWarn ultimately calls back
// into backend.entities.SystemLog — importing it here would be circular.
function makeResilientLogEntity(entity) {
  return {
    ...entity,
    async create(data) {
      try {
        return await entity.create(data);
      } catch (e) {
        console.warn('[SystemLog] Falha ao gravar log (não crítico, ignorado):', e.message);
        return { id: null, ...data };
      }
    },
    async createUnique(id, data) {
      try {
        return await entity.createUnique(id, data);
      } catch (e) {
        console.warn('[SystemLog] Falha ao gravar log dedupado (não crítico, ignorado):', e.message);
        return { created: false, existing: null };
      }
    },
  };
}

export const backend = {
  entities: {
    MonitoredAsset: createEntity('monitoredAssets'),
    AssetState: withRtdbMirror('AssetState', createEntity('assetStates')),
    SignalEvent: createEntity('signalEvents'),
    TradeOperation: withRtdbMirror('TradeOperation', createEntity('tradeOperations')),
    PriceAlert: createEntity('priceAlerts'),
    SystemLog: makeResilientLogEntity(createEntity('systemLogs')),
    User: createEntity('users'),
    StrategyConfig: createEntity('strategyConfig'),
    TelegramFilters: createEntity('telegramFilters'),
    VerificationTask: createEntity('verificationTasks'),
  },
  agents: strategyReviewerAgent,
  locks: { acquireScanLock, releaseScanLock },
  tradeOps: {
    createTradeOpIfNoneActive: withCreateOpMirror(createTradeOpIfNoneActive),
    // clearActiveOp never touches tradeOperations — only the assetActiveOps
    // pointer — so it's deliberately never wrapped (docs/known-risks.md item 152).
    clearActiveOp,
    transitionTradeOp: withTransitionOpMirror(transitionTradeOp),
  },
  quota: { getAndResetOpCounts },
};
