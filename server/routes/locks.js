// backend.locks (Fase 5 do plano de migração Firestore→Neon). **Dark
// nesta PR.**
const express = require('express');
const { getPgCore, requireDatabaseUrl } = require('../pgCoreLoader');

function createLocksRouter({ requireAuth }) {
  const router = express.Router();
  router.use(requireDatabaseUrl, requireAuth);

  router.post('/acquire', async (req, res) => {
    const { lockName, ttlMs, holder } = req.body || {};
    if (typeof lockName !== 'string' || !lockName) return res.status(400).json({ error: 'lockName é obrigatório.' });
    if (typeof holder !== 'string' || !holder) return res.status(400).json({ error: 'holder é obrigatório.' });
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) return res.status(400).json({ error: 'ttlMs precisa ser um número positivo.' });
    try {
      const { backend } = await getPgCore();
      const acquired = await backend.locks.acquireScanLock(lockName, ttlMs, holder);
      res.json({ acquired });
    } catch (e) {
      console.error('POST /api/locks/acquire failed:', e.message);
      res.status(500).json({ error: 'Erro interno.' });
    }
  });

  router.post('/release', async (req, res) => {
    const { lockName, holder } = req.body || {};
    if (typeof lockName !== 'string' || !lockName) return res.status(400).json({ error: 'lockName é obrigatório.' });
    if (typeof holder !== 'string' || !holder) return res.status(400).json({ error: 'holder é obrigatório.' });
    try {
      const { backend } = await getPgCore();
      await backend.locks.releaseScanLock(lockName, holder);
      res.json({ ok: true });
    } catch (e) {
      console.error('POST /api/locks/release failed:', e.message);
      res.status(500).json({ error: 'Erro interno.' });
    }
  });

  return router;
}

module.exports = { createLocksRouter };
