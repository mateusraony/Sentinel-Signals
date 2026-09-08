// Cliente HTTP para o backend Postgres/Neon (Fase 6 do plano de migração
// Firestore→Neon, /root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md).
// Preserva **exatamente** a forma externa de `backend` em src/api/entities.js
// (entities.<Nome>.{list,filter,get,set,create,createUnique,update,delete,
// bulkCreate,deleteMany}, locks, tradeOps, quota) — os ~20 arquivos
// consumidores trocam de import sem mudar nenhuma outra linha, no dia do
// cutover.
//
// **Dark neste arquivo** — nada em produção importa isto ainda.
// src/api/entities.js (Firestore) continua sendo o backend real.
//
// Cada método aqui é uma tradução fina para a rota HTTP equivalente já
// implementada (e dark) em server/routes/{entities,tradeOps,locks}.js —
// nenhuma lógica de negócio mora aqui, só a forma da chamada. Reusa
// `callBackend` (src/lib/apiBackend.js) para autenticação
// (Authorization: Bearer <idToken>) e tratamento de erro — o mesmo helper já
// usado por /api/telegram-notify e /api/backtest/*.
import { callBackend } from '@/lib/apiBackend';

function buildEntityQuery(filters, sort, limitCount) {
  const params = new URLSearchParams();
  if (filters && Object.keys(filters).length > 0) {
    params.set('filters', JSON.stringify(filters));
  }
  if (sort) params.set('sort', sort);
  if (limitCount) params.set('limit', String(limitCount));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// Mesma forma de chamada de createEntity() em src/api/entities.js — a
// diferença é que cada método vira uma requisição HTTP para
// server/routes/entities.js em vez de uma chamada ao SDK do Firestore.
function createEntity(collectionName) {
  const base = `/api/entities/${collectionName}`;
  return {
    async list(sort, limitCount) {
      return callBackend(`${base}${buildEntityQuery({}, sort, limitCount)}`, undefined, { method: 'GET' });
    },

    async filter(filters = {}, sort, limitCount) {
      return callBackend(`${base}${buildEntityQuery(filters, sort, limitCount)}`, undefined, { method: 'GET' });
    },

    // Retorna null para documento inexistente — mesmo contrato do
    // Firestore original (snap.exists() ? ... : null) — em vez de lançar.
    async get(id) {
      return callBackend(`${base}/${id}`, undefined, { method: 'GET', allow404: true });
    },

    async set(id, data) {
      return callBackend(`${base}/${id}/set`, data);
    },

    async create(data) {
      return callBackend(base, data);
    },

    async createUnique(id, data) {
      return callBackend(`${base}/${id}/unique`, data);
    },

    async update(id, data) {
      return callBackend(`${base}/${id}`, data, { method: 'PATCH' });
    },

    async delete(id) {
      await callBackend(`${base}/${id}`, undefined, { method: 'DELETE' });
    },

    async bulkCreate(items) {
      return callBackend(`${base}/bulk`, items);
    },

    async deleteMany(filters = {}) {
      return callBackend(`${base}/delete-many`, filters);
    },
  };
}

async function acquireScanLock(lockName, ttlMs, holder) {
  const result = await callBackend('/api/locks/acquire', { lockName, ttlMs, holder });
  return result.acquired;
}

async function releaseScanLock(lockName, holder) {
  await callBackend('/api/locks/release', { lockName, holder });
}

async function createTradeOpIfNoneActive(assetId, docId, data, cascade) {
  return callBackend('/api/trade-ops/create-if-none-active', { assetId, docId, data, cascade });
}

async function clearActiveOp(assetId, tradeOpId, cascade) {
  await callBackend('/api/trade-ops/clear-active', { assetId, tradeOpId, cascade });
}

/**
 * @param {string} opId
 * @param {string} fromStatus
 * @param {object} patch
 * @param {{ assetId?: string, stopAdvanceMarkerField?: string, cascade?: string }} [options]
 */
async function transitionTradeOp(opId, fromStatus, patch, { assetId, stopAdvanceMarkerField, cascade } = {}) {
  return callBackend(`/api/trade-ops/${opId}/transition`, { fromStatus, patch, assetId, stopAdvanceMarkerField, cascade });
}

// Contador de leitura/escrita do Firestore (docs/known-risks.md item 13) —
// não tem equivalente no Postgres/Neon (sem teto diário de operações, ver
// CLAUDE.md). Stub local que nunca sobe ao servidor, mesmo formato do stub
// em db/pgEntitiesCore.mjs's `backend.quota` — existe só para os ~20
// consumidores que fazem `backend.quota.getAndResetOpCounts()` continuarem
// funcionando sem checagem condicional de backend.
function getAndResetOpCounts() {
  return { reads: 0, writes: 0 };
}

// `agents` (Strategy Reviewer) fica de fora de propósito: `agentConversations`
// não é migrado nesta rodada (decisão de escopo do plano) e nenhum consumidor
// real usa `backend.agents` hoje — StrategyReviewer.jsx é placeholder pausado
// e não importa `backend` (ver CLAUDE.md, "Decisões intencionais").
export const backend = {
  entities: {
    MonitoredAsset: createEntity('MonitoredAsset'),
    AssetState: createEntity('AssetState'),
    SignalEvent: createEntity('SignalEvent'),
    TradeOperation: createEntity('TradeOperation'),
    PriceAlert: createEntity('PriceAlert'),
    SystemLog: createEntity('SystemLog'),
    // Bloqueada na rota genérica de propósito (server/entityCollectionGuard.js
    // — isolamento "dono only" de users/{uid}); mantida aqui só por forma —
    // qualquer chamada real lançaria 403. Perfil do próprio usuário usa
    // GET /api/me (fora deste adaptador — AuthContext.jsx no cutover).
    User: createEntity('User'),
    VerificationTask: createEntity('VerificationTask'),
    StrategyConfig: createEntity('StrategyConfig'),
    TelegramFilters: createEntity('TelegramFilters'),
  },
  locks: { acquireScanLock, releaseScanLock },
  tradeOps: { createTradeOpIfNoneActive, clearActiveOp, transitionTradeOp },
  quota: { getAndResetOpCounts },
};
