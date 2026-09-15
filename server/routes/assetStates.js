// backend.assetStates.upsert (item 179) — upsert atômico de AssetState por
// (asset_id, timeframe), exposto via HTTP para o browser. Mesma forma de
// server/routes/locks.js/tradeOps.js: rota dedicada fora do CRUD genérico
// de server/routes/entities.js porque a semântica (upsert atômico por par,
// não por id) não é a de nenhum dos métodos genéricos já expostos ali.
const express = require('express');
const { getPgCore, requireDatabaseUrl } = require('../pgCoreLoader');

function createAssetStatesRouter({ requireAuth, requireOwner }) {
  const router = express.Router();
  router.use(requireDatabaseUrl, requireAuth, requireOwner);

  router.post('/upsert', async (req, res) => {
    const { assetId, timeframe, data } = req.body || {};
    if (typeof assetId !== 'string' || !assetId) {
      return res.status(400).json({ error: 'assetId é obrigatório.' });
    }
    if (typeof timeframe !== 'string' || !timeframe) {
      return res.status(400).json({ error: 'timeframe é obrigatório.' });
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'data precisa ser um objeto.' });
    }
    try {
      const { backend } = await getPgCore();
      const result = await backend.assetStates.upsert(assetId, timeframe, data);
      res.json(result);
    } catch (e) {
      console.error('POST /api/asset-states/upsert failed:', e.message);
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createAssetStatesRouter };
