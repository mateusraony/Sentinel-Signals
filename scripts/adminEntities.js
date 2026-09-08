// Node/GitHub Actions counterpart to src/api/entities.js — Postgres/Neon
// backend (Fase 10 do plano de migração Firestore→Neon,
// /root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md). This
// lets src/lib/scanner.js run unmodified in both places — see
// scripts/build-scan.mjs/build-backfill.mjs, which alias '@/api/entities'
// to this file (by NAME, unchanged) when bundling for the scheduled scan/
// backfill-check jobs.
//
// Thin re-export of db/pgEntitiesCore.mjs — this file used to be a ~330
// line Firestore admin-SDK reimplementation (same shape, different
// backend); that version is preserved as scripts/adminEntitiesFirestoreLegacy.js
// for the 4 scripts that still need to talk to the REAL Firestore
// regardless of cutover status (backup-firestore.mjs, backfill-rtdb.mjs,
// migrate-firestore-to-postgres.mjs, verify-postgres-migration.mjs — see
// that file's header).
import { backend } from '../db/pgEntitiesCore.mjs';

export { backend };

// Mirrors the old adminEntities.js's separate named export (consumed by
// scripts/adminEntitiesBackfillCache.js/scripts/run-backfill-check.mjs) —
// same underlying function as backend.quota.getAndResetOpCounts, just also
// reachable without going through `backend`.
export const getAndResetOpCounts = backend.quota.getAndResetOpCounts;
