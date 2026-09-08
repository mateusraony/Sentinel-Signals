// Substitui a leitura direta a Firestore de `loadOrCreateProfile`
// (src/lib/AuthContext.jsx) — Fase 5 do plano de migração Firestore→Neon.
// **Dark nesta PR**: AuthContext.jsx continua chamando o Firestore direto
// até o cutover; esta rota existe mas ninguém no browser a chama ainda.
//
// `createUnique` (create-if-absent atômico) substitui o par
// getDoc/setDoc do original — mesmo resultado observável (perfil criado com
// role:'user' no primeiro login), mas fecha de graça a pequena janela de
// corrida entre "ler que não existe" e "escrever" que o original tinha.
const express = require('express');
const { getPgCore, requireDatabaseUrl } = require('../pgCoreLoader');

function createMeRouter({ requireAuth }) {
  const router = express.Router();
  router.use(requireDatabaseUrl, requireAuth);

  router.get('/', async (req, res) => {
    try {
      const { backend } = await getPgCore();
      const existing = await backend.entities.User.get(req.uid);
      if (existing) {
        return res.json({ uid: req.uid, ...existing, email: req.userEmail ?? existing.email });
      }
      const result = await backend.entities.User.createUnique(req.uid, { role: 'user', email: req.userEmail ?? null });
      const profile = result.created ? result.doc : result.existing;
      res.json({ uid: req.uid, ...profile, email: req.userEmail ?? profile.email });
    } catch (e) {
      console.error('GET /api/me failed:', e.message);
      res.status(500).json({ error: 'Erro interno.' });
    }
  });

  return router;
}

module.exports = { createMeRouter };
