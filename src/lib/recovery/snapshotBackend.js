// Replay de recuperação (docs/known-risks.md item 288) — a loja em memória do
// TESTE A SECO. Recebe um retrato do banco real ({ Entidade: [linhas] }) e devolve
// um `backend` com o MESMO formato de src/api/entities.js, para scanner.js rodar
// sem modificação. Nada aqui escreve no banco real: o retrato é copiado.
//
// Envolve createFakeBackend (mesma regra de CAS/criação de produção, de
// opTransition.js — precedente: scripts/backtestEntities.js) e fecha as lacunas
// de fidelidade que importam para recuperar operações REAIS:
//  1. a criação de operação decide como o POSTGRES (db/pgEntitiesCore.mjs:562-617):
//     lê TODAS as operações vivas do ativo e aplica planTradeOpCreationSql — o
//     falso usava um ponteiro por âncora, que fica vazio para operações vindas do
//     retrato e deixaria criar uma 2ª operação ao lado de uma ativa;
//  2. `update` de um id inexistente LANÇA, como no Postgres (o falso criava);
//  3. leituras devolvem CÓPIAS (o falso devolvia o objeto guardado);
//  4. `get(id)` existe (o falso não tinha);
//  5. toda escrita entra num DIÁRIO — é ele que o relatório e a comparação
//     teste-a-seco × aplicar usam;
//  6. id gerado para linha nova nunca colide com uma linha do retrato (o contador
//     do falso recomeça do zero e sobrescrevia, ex., "SystemLog_1" vindo do banco).
import { createFakeBackend } from '../__fixtures__/fakeBackend.js';
import { isTerminalStatus, planTradeOpCreationSql } from '../opTransition.js';
import { assertNoUndefinedFields } from '../assertNoUndefinedFields.js';

export const SNAPSHOT_ENTITIES = Object.freeze([
  'MonitoredAsset', 'AssetState', 'SignalEvent', 'TradeOperation',
  'VerificationTask', 'StrategyConfig', 'SystemLog', 'PriceAlert', 'TelegramFilters',
]);

const ENTITY_WRITE_METHODS = ['create', 'createUnique', 'update', 'delete', 'set', 'bulkCreate', 'deleteMany'];
const SELF_ID_METHODS = new Set(['update', 'create', 'bulkCreate']);
const ENTITY_READ_METHODS = ['list', 'filter'];

const clone = (v) => (v === undefined ? v : structuredClone(v));

/**
 * @param {Record<string, object[]>} snapshot  linhas por entidade (como vieram do banco)
 * @returns {{ backend: object, journal: object[], _fake: object }}
 */
export function createSnapshotBackend(snapshot = {}) {
  const fake = createFakeBackend();
  const journal = [];
  const record = (entry) => { journal.push(clone(entry)); };

  for (const [name, rows] of Object.entries(snapshot)) {
    if (!SNAPSHOT_ENTITIES.includes(name)) throw new Error(`retrato: entidade desconhecida ${name}`);
    for (const row of rows || []) {
      if (!row?.id) throw new Error(`retrato: linha de ${name} sem id`);
      fake._seed(name, clone(row));
    }
  }
  // Retrato com 2 operações vivas no mesmo ativo (fora da convivência hierárquica permitida)
  // já é um estado corrompido: recuperar em cima dele só espalharia o erro.
  const liveByAsset = new Map();
  for (const op of snapshot.TradeOperation || []) {
    if (!op.asset_id || isTerminalStatus(op.status)) continue;
    liveByAsset.set(op.asset_id, [...(liveByAsset.get(op.asset_id) || []), op]);
  }
  for (const [assetId, ops] of liveByAsset) {
    if (ops.length < 2) continue;
    const coexist = ops.every((o) => o.hierarchical_cascade === true) && new Set(ops.map((o) => o.cascade)).size === ops.length;
    if (!coexist) throw new Error(`retrato: ${ops.length} operações ativas para o ativo ${assetId} — resolver antes de recuperar`);
  }

  // (6) ids próprios, conferidos contra a loja inteira.
  let seq = 0;
  const freshId = (name) => {
    let id;
    do { seq += 1; id = `${name}_rec_${seq}`; } while (fake._get(name, id) != null);
    return id;
  };
  const insert = (name, data) => {
    assertNoUndefinedFields(data, name);
    const id = freshId(name);
    const doc = { created_date: new Date().toISOString(), ...clone(data), id };
    fake._seed(name, doc);
    return doc;
  };

  const entities = {};
  for (const name of Object.keys(fake.entities)) {
    const raw = fake.entities[name];
    const wrapped = {};
    for (const m of ENTITY_READ_METHODS) wrapped[m] = async (...args) => clone(await raw[m](...args));
    wrapped.get = async (id) => clone(fake._get(name, id) ?? null);
    wrapped.update = async (id, data) => {
      if (fake._get(name, id) == null) throw new Error(`${name}.update: id inexistente ${id}`);
      const out = await raw.update(id, clone(data));
      record({ entity: name, op: 'update', id, data });
      return clone(out);
    };
    wrapped.create = async (data) => {
      const doc = insert(name, data);
      record({ entity: name, op: 'create', id: doc.id, data });
      return clone(doc);
    };
    wrapped.bulkCreate = async (items) => {
      (items || []).forEach((item) => assertNoUndefinedFields(item, name));
      const docs = (items || []).map((item) => insert(name, item));
      record({ entity: name, op: 'bulkCreate', ids: docs.map((d) => d.id), items });
      return clone(docs);
    };
    for (const m of ENTITY_WRITE_METHODS.filter((x) => !SELF_ID_METHODS.has(x))) {
      wrapped[m] = async (...args) => {
        const out = await raw[m](...args.map(clone));
        record({ entity: name, op: m, args });
        return clone(out);
      };
    }
    entities[name] = wrapped;
  }

  const tradeOps = {
    // Espelho de db/pgEntitiesCore.mjs createTradeOpIfNoneActive (a mesma regra pura).
    async createTradeOpIfNoneActive(assetId, docId, data, cascade) {
      const allOps = await fake.entities.TradeOperation.list();
      const activeRowsForAsset = allOps.filter((op) => op.asset_id === assetId && !isTerminalStatus(op.status));
      const existingOpById = fake._get('TradeOperation', docId) ?? null;
      const plan = planTradeOpCreationSql({ activeRowsForAsset, existingOpById, cascade, docId });
      if (plan.action === 'blocked') {
        const blocker = activeRowsForAsset.find((r) => r.id !== docId);
        return { created: false, existingId: blocker ? blocker.id : null };
      }
      if (plan.action === 'reuse') return { created: false, existing: clone(existingOpById) };
      const payload = { ...clone(data), created_date: data.created_date || new Date().toISOString() };
      assertNoUndefinedFields(payload, 'TradeOperation');
      const doc = { ...payload, id: docId };
      fake._seed('TradeOperation', doc);
      record({ entity: 'TradeOperation', op: 'createTradeOpIfNoneActive', id: docId, assetId, cascade, data: payload });
      return { created: true, doc: clone(doc) };
    },
    async clearActiveOp(assetId, tradeOpId, cascade) {
      await fake.tradeOps.clearActiveOp(assetId, tradeOpId, cascade);
      record({ entity: 'TradeOperation', op: 'clearActiveOp', id: tradeOpId, assetId, cascade });
    },
    async transitionTradeOp(opId, fromStatus, patch, options) {
      const out = await fake.tradeOps.transitionTradeOp(opId, fromStatus, clone(patch), options);
      if (out.applied) record({ entity: 'TradeOperation', op: 'transitionTradeOp', id: opId, fromStatus, patch: out.patch });
      return clone(out);
    },
  };

  const assetStates = {
    // Espelho de upsertAssetState (preserva o id da linha existente; linha nova ganha id próprio).
    async upsert(assetId, timeframe, data) {
      const payload = { ...clone(data), asset_id: assetId, timeframe };
      assertNoUndefinedFields(payload, 'AssetState');
      const all = await fake.entities.AssetState.list();
      const existing = all.find((d) => d.asset_id === assetId && d.timeframe === timeframe);
      const doc = existing ? { ...existing, ...payload, id: existing.id } : null;
      const out = doc ? fake._seed('AssetState', doc) : insert('AssetState', payload);
      record({ entity: 'AssetState', op: 'upsert', assetId, timeframe, data });
      return clone(out);
    },
  };

  const backend = {
    entities,
    tradeOps,
    assetStates,
    // Lock no teste a seco: sempre concedido (não há concorrência em memória). No modo
    // aplicar, o lock REAL é pego fora do relógio simulado (ver recoveryReplay.js).
    locks: fake.locks,
    quota: fake.quota,
  };
  return { backend, journal, _fake: fake };
}

/**
 * Lê todas as linhas das entidades do retrato a partir de um backend (real ou falso).
 * Usa só `list()` — nenhuma escrita.
 */
export async function exportSnapshot(backend, names = SNAPSHOT_ENTITIES) {
  const out = {};
  for (const name of names) {
    const api = backend?.entities?.[name];
    out[name] = api ? clone(await api.list()) : [];
  }
  return out;
}

/**
 * Embrulha um backend REAL para o teste a seco: qualquer tentativa de escrita lança.
 * Defesa em profundidade — o teste a seco lê o retrato e depois só usa a loja em memória.
 */
export function readOnlyProxy(backend) {
  const deny = (what) => async () => { throw new Error(`teste a seco: escrita proibida (${what})`); };
  const entities = {};
  for (const [name, api] of Object.entries(backend?.entities || {})) {
    const safe = {};
    for (const m of [...ENTITY_READ_METHODS, 'get']) if (typeof api[m] === 'function') safe[m] = (...a) => api[m](...a);
    for (const m of ENTITY_WRITE_METHODS) safe[m] = deny(`${name}.${m}`);
    entities[name] = safe;
  }
  return {
    entities,
    tradeOps: {
      createTradeOpIfNoneActive: deny('tradeOps.createTradeOpIfNoneActive'),
      clearActiveOp: deny('tradeOps.clearActiveOp'),
      transitionTradeOp: deny('tradeOps.transitionTradeOp'),
    },
    assetStates: { upsert: deny('assetStates.upsert') },
    locks: { acquireScanLock: deny('locks.acquireScanLock'), releaseScanLock: deny('locks.releaseScanLock') },
  };
}
