// O CAS redesenhado, exposto via HTTP (Fase 5 do plano de migração
// Firestore→Neon) — revisado por sentinel-council-review antes de existir
// (ver db/pgEntitiesCore.mjs e db/CLAUDE.md). **Dark nesta PR.**
const express = require('express');
const { getPgCore, requireDatabaseUrl } = require('../pgCoreLoader');
const { validateTradeOpPatch } = require('../tradeOpPatchGuard');

function createTradeOpsRouter({ requireAuth }) {
  const router = express.Router();
  router.use(requireDatabaseUrl, requireAuth);

  router.post('/create-if-none-active', async (req, res) => {
    const { assetId, docId, data, cascade } = req.body || {};
    if (typeof assetId !== 'string' || !assetId) {
      return res.status(400).json({ error: 'assetId é obrigatório.' });
    }
    if (typeof docId !== 'string' || !docId) {
      return res.status(400).json({ error: 'docId é obrigatório.' });
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'data precisa ser um objeto.' });
    }
    try {
      const { backend, TRADE_OP_STATUSES } = await getPgCore();
      if (data.status !== undefined && !TRADE_OP_STATUSES.includes(data.status)) {
        return res.status(400).json({ error: `status inválido: "${data.status}".` });
      }
      const result = await backend.tradeOps.createTradeOpIfNoneActive(assetId, docId, data, cascade);
      res.json(result);
    } catch (e) {
      console.error('POST /api/trade-ops/create-if-none-active failed:', e.message);
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/:id/transition', async (req, res) => {
    const { id } = req.params;
    const { fromStatus, patch, assetId, stopAdvanceMarkerField, cascade } = req.body || {};
    if (typeof fromStatus !== 'string' || !fromStatus) {
      return res.status(400).json({ error: 'fromStatus é obrigatório.' });
    }
    const patchError = validateTradeOpPatch(patch || {});
    if (patchError) {
      return res.status(400).json({ error: patchError });
    }
    try {
      const { backend, TRADE_OP_STATUSES } = await getPgCore();
      if (patch?.status !== undefined && !TRADE_OP_STATUSES.includes(patch.status)) {
        return res.status(400).json({ error: `status inválido: "${patch.status}".` });
      }
      const result = await backend.tradeOps.transitionTradeOp(id, fromStatus, patch || {}, { assetId, stopAdvanceMarkerField, cascade });
      res.json(result);
    } catch (e) {
      console.error(`POST /api/trade-ops/${id}/transition failed:`, e.message);
      res.status(400).json({ error: e.message });
    }
  });

  // No-op no backend (ver o comentário de clearActiveOp em
  // db/pgEntitiesCore.mjs) — a rota existe para o cliente HTTP não
  // precisar de um caso especial "esta chamada não faz nada no Postgres".
  router.post('/clear-active', async (req, res) => {
    try {
      const { backend } = await getPgCore();
      const { assetId, tradeOpId, cascade } = req.body || {};
      await backend.tradeOps.clearActiveOp(assetId, tradeOpId, cascade);
      res.json({ ok: true });
    } catch (e) {
      console.error('POST /api/trade-ops/clear-active failed:', e.message);
      res.status(500).json({ error: 'Erro interno.' });
    }
  });

  return router;
}

module.exports = { createTradeOpsRouter };
