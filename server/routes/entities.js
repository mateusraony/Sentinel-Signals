// Rota HTTP genérica para o CRUD de entidades (Fase 5 do plano de migração
// Firestore→Neon) — o equivalente funcional do deny-by-default de
// `firestore.rules`: NUNCA consulta uma tabela livre, só as registradas em
// db/pgEntitiesCore.mjs's ENTITY_TABLES (nome fora do registro → 404), e
// nunca a coleção `User` (dono only — ver server/entityCollectionGuard.js).
// Chamada de verdade pelo browser desde o cutover (2026-09-12).
const express = require('express');
const { getPgCore, requireDatabaseUrl } = require('../pgCoreLoader');
const { checkCollectionAccess } = require('../entityCollectionGuard');

function createEntitiesRouter({ requireAuth }) {
  const router = express.Router();
  router.use(requireDatabaseUrl, requireAuth);

  function checkCollection(ENTITY_TABLES, collection, res) {
    const result = checkCollectionAccess(ENTITY_TABLES, collection);
    if (!result.allowed) {
      res.status(result.status).json({ error: result.error });
      return false;
    }
    return true;
  }

  function parseFilters(req, res) {
    if (!req.query.filters) return {};
    try {
      const parsed = JSON.parse(req.query.filters);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed;
    } catch {
      res.status(400).json({ error: 'filters precisa ser um objeto JSON válido.' });
      return null;
    }
  }

  router.get('/:collection', async (req, res) => {
    const { collection } = req.params;
    try {
      const { backend, ENTITY_TABLES } = await getPgCore();
      if (!checkCollection(ENTITY_TABLES, collection, res)) return;
      const filters = parseFilters(req, res);
      if (filters === null) return;
      const sort = typeof req.query.sort === 'string' ? req.query.sort : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        return res.status(400).json({ error: 'limit precisa ser um número positivo.' });
      }
      const rows = await backend.entities[collection].filter(filters, sort, limit);
      res.json(rows);
    } catch (e) {
      console.error(`GET /api/entities/${collection} failed:`, e.message);
      res.status(500).json({ error: 'Erro interno.' });
    }
  });

  router.get('/:collection/:id', async (req, res) => {
    const { collection, id } = req.params;
    try {
      const { backend, ENTITY_TABLES } = await getPgCore();
      if (!checkCollection(ENTITY_TABLES, collection, res)) return;
      const doc = await backend.entities[collection].get(id);
      if (!doc) return res.status(404).json({ error: 'Documento não encontrado.' });
      res.json(doc);
    } catch (e) {
      console.error(`GET /api/entities/${collection}/${id} failed:`, e.message);
      res.status(500).json({ error: 'Erro interno.' });
    }
  });

  router.post('/:collection', async (req, res) => {
    const { collection } = req.params;
    try {
      const { backend, ENTITY_TABLES } = await getPgCore();
      if (!checkCollection(ENTITY_TABLES, collection, res)) return;
      const doc = await backend.entities[collection].create(req.body || {});
      res.status(201).json(doc);
    } catch (e) {
      console.error(`POST /api/entities/${collection} failed:`, e.message);
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/:collection/bulk', async (req, res) => {
    const { collection } = req.params;
    try {
      const { backend, ENTITY_TABLES } = await getPgCore();
      if (!checkCollection(ENTITY_TABLES, collection, res)) return;
      const items = Array.isArray(req.body) ? req.body : req.body?.items;
      if (!Array.isArray(items)) return res.status(400).json({ error: 'Corpo precisa ser um array (ou { items: [...] }).' });
      const docs = await backend.entities[collection].bulkCreate(items);
      res.status(201).json(docs);
    } catch (e) {
      console.error(`POST /api/entities/${collection}/bulk failed:`, e.message);
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/:collection/delete-many', async (req, res) => {
    const { collection } = req.params;
    try {
      const { backend, ENTITY_TABLES } = await getPgCore();
      if (!checkCollection(ENTITY_TABLES, collection, res)) return;
      const deleted = await backend.entities[collection].deleteMany(req.body || {});
      res.json(deleted);
    } catch (e) {
      console.error(`POST /api/entities/${collection}/delete-many failed:`, e.message);
      res.status(500).json({ error: 'Erro interno.' });
    }
  });

  router.post('/:collection/:id/unique', async (req, res) => {
    const { collection, id } = req.params;
    try {
      const { backend, ENTITY_TABLES } = await getPgCore();
      if (!checkCollection(ENTITY_TABLES, collection, res)) return;
      const result = await backend.entities[collection].createUnique(id, req.body || {});
      res.json(result);
    } catch (e) {
      console.error(`POST /api/entities/${collection}/${id}/unique failed:`, e.message);
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/:collection/:id/set', async (req, res) => {
    const { collection, id } = req.params;
    try {
      const { backend, ENTITY_TABLES } = await getPgCore();
      if (!checkCollection(ENTITY_TABLES, collection, res)) return;
      const doc = await backend.entities[collection].set(id, req.body || {});
      res.json(doc);
    } catch (e) {
      console.error(`POST /api/entities/${collection}/${id}/set failed:`, e.message);
      res.status(400).json({ error: e.message });
    }
  });

  router.patch('/:collection/:id', async (req, res) => {
    const { collection, id } = req.params;
    try {
      const { backend, ENTITY_TABLES } = await getPgCore();
      if (!checkCollection(ENTITY_TABLES, collection, res)) return;
      const doc = await backend.entities[collection].update(id, req.body || {});
      res.json(doc);
    } catch (e) {
      console.error(`PATCH /api/entities/${collection}/${id} failed:`, e.message);
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/:collection/:id', async (req, res) => {
    const { collection, id } = req.params;
    try {
      const { backend, ENTITY_TABLES } = await getPgCore();
      if (!checkCollection(ENTITY_TABLES, collection, res)) return;
      await backend.entities[collection].delete(id);
      res.status(204).end();
    } catch (e) {
      console.error(`DELETE /api/entities/${collection}/${id} failed:`, e.message);
      res.status(500).json({ error: 'Erro interno.' });
    }
  });

  return router;
}

module.exports = { createEntitiesRouter };
