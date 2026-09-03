// One-time Firestore→RTDB copy (docs/known-risks.md item 152 addendum) —
// closes the "cold start" gap that caused the 2026-09-03 incident: the live
// mirror (src/lib/rtdbMirror.js, wired into scripts/adminEntities.js) only
// writes a document to RTDB when it's created/updated/transitioned AGAIN
// after the mirror went live. A CLOSED TradeOperation never gets touched
// again, so it would stay invisible in RTDB forever without this — and even
// an ACTIVE one is invisible until its next real transition. This script
// reads the CURRENT state of every mirrored collection from Firestore (the
// source of truth) and writes it into RTDB directly, once.
//
// Run manually (.github/workflows/backfill-rtdb.yml, workflow_dispatch) —
// never on the scheduled ~5min cadence. Safe to re-run: each doc is a full
// overwrite keyed by its own (sanitized) id, so running it twice just
// refreshes RTDB to whatever Firestore says right now — never introduces
// staleness or drift beyond an ordinary read-then-write race, the same as
// any other read of a live collection.
//
// Deliberately plain Node ESM (no esbuild bundling, unlike run-scan.mjs) —
// adminEntities.js and rtdbMirror.js only use relative imports, so this
// script runs directly with `node scripts/backfill-rtdb.mjs`.
import { backend, rtdb } from './adminEntities.js';
import { RTDB_MIRRORED_ENTITIES, toRtdbKey } from '../src/lib/rtdbMirror.js';
import { forceExit } from './scanTimeout.mjs';

// A single multi-path update() per chunk is one RTDB round-trip for up to
// CHUNK_SIZE docs, instead of one round-trip per doc — the same reasoning
// scanner.js's writeBatch already applies on the Firestore side.
const CHUNK_SIZE = 500;

// Exported for scripts/backfill-rtdb.test.js — the rest of main() is a thin
// wrapper (loop + forceExit) that, like run-scan.mjs/run-backfill-check.mjs,
// isn't unit-tested directly in this repo's convention; the real chunking/
// key-sanitization/collection-mapping logic here is.
export async function backfillCollection(entityName, rtdbPath) {
  const docs = await backend.entities[entityName].list();
  console.log(`[backfill-rtdb] ${entityName}: ${docs.length} documento(s) lido(s) do Firestore`);

  for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
    const chunk = docs.slice(i, i + CHUNK_SIZE);
    const updates = {};
    chunk.forEach((doc) => {
      updates[`${rtdbPath}/${toRtdbKey(doc.id)}`] = doc;
    });
    await rtdb.ref().update(updates);
  }
  console.log(`[backfill-rtdb] ${entityName}: ${docs.length} documento(s) escrito(s) no RTDB`);
}

async function main() {
  if (!rtdb) {
    throw new Error(
      'FIREBASE_DATABASE_URL não está setada — nada a fazer (o RTDB ainda não foi provisionado neste ambiente).'
    );
  }
  const started = Date.now();
  // Iterates RTDB_MIRRORED_ENTITIES instead of a hardcoded list — a
  // collection added to the live mirror later is automatically covered
  // here too, no second place to remember to update.
  for (const [entityName, rtdbPath] of Object.entries(RTDB_MIRRORED_ENTITIES)) {
    await backfillCollection(entityName, rtdbPath);
  }
  console.log(`[backfill-rtdb] concluído em ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

// Guarded (unlike run-scan.mjs/run-backfill-check.mjs) so this file can be
// `import`ed for testing backfillCollection without also auto-running main()
// — `node scripts/backfill-rtdb.mjs` still runs it exactly the same as before.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main()
    .then(() => forceExit(0))
    .catch((err) => {
      // forceExit também no caminho de sucesso E de erro (docs/known-risks.md
      // item 152) — mesmo motivo do fix em run-scan.mjs: firebase-admin/database
      // mantém uma conexão WebSocket persistente que impede o processo de
      // encerrar sozinho.
      console.error('[backfill-rtdb] FAILED:', err);
      forceExit(1);
    });
}
