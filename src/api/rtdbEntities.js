// Realtime Database READ adapter (docs/known-risks.md item 152, rodadas
// 2+3a+3b) — mirrors the reduced subset of backend.entities.<Name>'s shape
// ({list, filter}) that the dashboard's hot polling reads actually use.
// AssetState/SignalEvent/TradeOperation (createRtdbReadEntity) push
// filtering/sorting to the RTDB server via 3 recognized shapes: order+limit
// ("-created_date", N), a single-field range ({ created_date: { gte, lt } },
// MonthlyReport.jsx), and a single-field equality ({ asset_id: 'BTCUSDT' },
// RFHistoryChart.jsx). MonitoredAsset/VerificationTask (rodada 3b,
// createRtdbWholeNodeReadEntity below) are small enough (tens/low hundreds
// of docs, not thousands) that fetching the WHOLE node and doing everything
// — equality filters (any number of fields, `undefined` meaning "no
// constraint", same as classifyFilter()), sort, limit — in memory is cheap
// and always correct, with no RTDB .indexOn to keep in sync as new call
// sites appear.
// Every call is fire-and-forget-free (normal awaited reads) but NEVER mutates —
// all writes/mutations continue exclusively through backend.entities/
// backend.tradeOps (Firestore), never through this module. See
// .claude/rules/firestore-concurrency.md: this stays the only place pages
// import firebase/database from, same discipline already applied to
// firebase/firestore.
//
// "Recognize the exact shape, else fall through to Firestore" — same spirit
// as isAssetStateHotPathQuery in scripts/adminEntitiesBackfillCache.js.
// Introducing this module can never regress correctness: an unrecognized
// filter shape gets today's behavior (a real Firestore read via the
// `fallbackEntity` passed in), never an incomplete/wrong RTDB result. RTDB
// not provisioned in this environment (rtdb === null) falls back the same way.
import { ref, get, query, orderByChild, limitToLast, startAt, endBefore, equalTo } from 'firebase/database';
import { rtdb } from '@/lib/firebaseClient';
import { backend } from '@/api/entities';

function sortField(sort) {
  return sort ? (sort.startsWith('-') ? sort.slice(1) : sort) : null;
}

function isDescending(sort) {
  return Boolean(sort && sort.startsWith('-'));
}

function valuesOf(snapshot) {
  const val = snapshot.val();
  return val ? Object.values(val) : [];
}

function withOrder(items, sort) {
  return isDescending(sort) ? items.reverse() : items;
}

// Sort (by an arbitrary field, ASC or DESC via the "-field" convention) and
// slice, entirely in JS — used wherever the RTDB query itself can't do the
// ordering server-side (a post-equalTo() result, or the whole-node mode
// below). Always operates on a NEW array (never mutates the input).
function sortAndLimitInMemory(items, sort, limitCount) {
  let result = items;
  if (sort) {
    const field = sortField(sort);
    result = [...result].sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0));
    if (isDescending(sort)) result.reverse();
  }
  if (limitCount) result = result.slice(0, limitCount);
  return result;
}

// { field: { gte, lt } } — exactly the shape src/lib/queryFilters.js's
// classifyFilter() calls 'range', restricted to a SINGLE filtered field
// (MonthlyReport.jsx's { created_date: { gte, lt } } is the only caller).
// A 2nd field or an array/`in` value isn't recognized here — a plain scalar
// value is recognized separately, by singleFieldEqualityShape below — RTDB
// has no composite index for AssetState/SignalEvent/TradeOperation, so an
// unrecognized shape falls through rather than risk silently returning a
// partial/wrong result.
function singleFieldRangeShape(filters) {
  const keys = Object.keys(filters);
  if (keys.length !== 1) return null;
  const [field] = keys;
  const value = filters[field];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const valueKeys = Object.keys(value);
  if (valueKeys.length === 0 || !valueKeys.every((k) => k === 'gte' || k === 'lt')) return null;
  return { field, gte: value.gte, lt: value.lt };
}

// { field: scalarValue } — single-field EQUALITY, the shape
// RFHistoryChart.jsx uses (`{ asset_id: asset.id }`). Distinct from
// singleFieldRangeShape (whose value is always a { gte, lt } object) — a
// plain scalar (string/number/boolean) means "equals", not "range". null,
// arrays (Firestore `in`) and any other object value are NOT recognized here
// on purpose — those fall through to Firestore below, same safety net as
// every other unrecognized shape in this module.
//
// `undefined` is excluded on purpose too, and separately from `null`:
// classifyFilter() (src/lib/queryFilters.js:83) — the same rule
// backend.entities.<Name>.filter() obeys on the Firestore side — treats an
// `undefined`-valued key as "no constraint on this field", not "equals
// undefined" (that's how Verification.jsx builds
// `{ status: statusFilter !== 'all' ? statusFilter : undefined }`). Without
// this guard, that exact shape would be misread as a real equality filter
// and crash calling equalTo(undefined) against the RTDB SDK instead of
// falling through to Firestore, which honors the "no constraint" meaning.
function singleFieldEqualityShape(filters) {
  const keys = Object.keys(filters);
  if (keys.length !== 1) return null;
  const [field] = keys;
  const value = filters[field];
  if (value === undefined || value === null || typeof value === 'object') return null;
  return { field, value };
}

function createRtdbReadEntity(rtdbPath, fallbackEntity) {
  return {
    async list(sort, limitCount) {
      if (!rtdb) return fallbackEntity.list(sort, limitCount);
      if (!sort && !limitCount) {
        const snapshot = await get(ref(rtdb, rtdbPath));
        return valuesOf(snapshot);
      }
      const constraints = [orderByChild(sortField(sort))];
      if (limitCount) constraints.push(limitToLast(limitCount));
      const snapshot = await get(query(ref(rtdb, rtdbPath), ...constraints));
      return withOrder(valuesOf(snapshot), sort);
    },

    async filter(filters = {}, sort, limitCount) {
      if (!rtdb) return fallbackEntity.filter(filters, sort, limitCount);
      if (Object.keys(filters).length === 0) return this.list(sort, limitCount);

      const range = singleFieldRangeShape(filters);
      if (range) {
        const constraints = [orderByChild(range.field)];
        if (range.gte !== undefined) constraints.push(startAt(range.gte));
        if (range.lt !== undefined) constraints.push(endBefore(range.lt));
        if (limitCount) constraints.push(limitToLast(limitCount));
        const snapshot = await get(query(ref(rtdb, rtdbPath), ...constraints));
        return withOrder(valuesOf(snapshot), sort);
      }

      const equality = singleFieldEqualityShape(filters);
      if (equality) {
        const snapshot = await get(query(ref(rtdb, rtdbPath), orderByChild(equality.field), equalTo(equality.value)));
        // equalTo já devolve o conjunto exato (nunca parcial) — mas o RTDB não
        // combina esse filtro com uma ordenação por OUTRO campo no servidor,
        // então sort/limit acontecem aqui, em memória, sobre um conjunto já
        // pequeno (o próprio propósito do filtro de igualdade é estreitar).
        return sortAndLimitInMemory(valuesOf(snapshot), sort, limitCount);
      }

      return fallbackEntity.filter(filters, sort, limitCount);
    },
  };
}

// { campo: valor, ... } — igualdade de N campos, cada um um valor escalar
// OU `undefined` (mesma convenção de classifyFilter(), src/lib/
// queryFilters.js:83 — "sem filtro nesse campo", não "igual a undefined").
// `null` e qualquer valor objeto/array (range {gte,lt}, Firestore `in`) NÃO
// são suportados aqui — o chamador cai no fallback Firestore antes mesmo de
// buscar o nó inteiro, mesma disciplina de singleFieldEqualityShape acima.
function isSupportedWholeNodeFilters(filters) {
  return Object.values(filters).every((value) => value === undefined || (value !== null && typeof value !== 'object'));
}

function matchesEqualityFilters(item, filters) {
  return Object.entries(filters).every(([field, value]) => value === undefined || item[field] === value);
}

// Modo "nó inteiro": para MonitoredAsset/VerificationTask (rodada 3b, item
// 169) — coleções pequenas o bastante (dezenas/poucas centenas de docs, não
// milhares) que buscar a árvore INTEIRA do RTDB e filtrar/ordenar/cortar em
// memória é barato e sempre correto, sem precisar de `.indexOn` nem de um
// reconhecedor de formato de query por campo (createRtdbReadEntity acima) —
// que precisaria crescer a cada novo call site com um formato de filtro
// diferente. `list()` sem argumentos já usa exatamente esse padrão hoje
// (AssetState/SignalEvent/TradeOperation, quando sort/limit ausentes); aqui
// ele é o ÚNICO modo, sempre.
function createRtdbWholeNodeReadEntity(rtdbPath, fallbackEntity) {
  async function fetchAll() {
    const snapshot = await get(ref(rtdb, rtdbPath));
    return valuesOf(snapshot);
  }
  return {
    async list(sort, limitCount) {
      if (!rtdb) return fallbackEntity.list(sort, limitCount);
      return sortAndLimitInMemory(await fetchAll(), sort, limitCount);
    },
    async filter(filters = {}, sort, limitCount) {
      if (!rtdb) return fallbackEntity.filter(filters, sort, limitCount);
      if (!isSupportedWholeNodeFilters(filters)) return fallbackEntity.filter(filters, sort, limitCount);
      const items = await fetchAll();
      const filtered = items.filter((item) => matchesEqualityFilters(item, filters));
      return sortAndLimitInMemory(filtered, sort, limitCount);
    },
  };
}

export const rtdbEntities = {
  AssetState: createRtdbReadEntity('assetStates', backend.entities.AssetState),
  MonitoredAsset: createRtdbWholeNodeReadEntity('monitoredAssets', backend.entities.MonitoredAsset),
  SignalEvent: createRtdbReadEntity('signalEvents', backend.entities.SignalEvent),
  TradeOperation: createRtdbReadEntity('tradeOperations', backend.entities.TradeOperation),
  VerificationTask: createRtdbWholeNodeReadEntity('verificationTasks', backend.entities.VerificationTask),
};
