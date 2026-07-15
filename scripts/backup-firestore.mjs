// Daily Firestore backup (see .github/workflows/backup.yml). Reads the
// business-data collections via the Admin SDK (scripts/adminEntities.js —
// same service account already used by the scan cron) and writes a single
// JSON snapshot file. The official Firestore export/import requires a Cloud
// Storage bucket, which requires the Blaze plan — not an option here (see
// docs/known-risks.md item 14), so this is the free-tier-compatible
// alternative: commit the snapshot to a dedicated branch (see backup.yml).
//
// systemLogs and users are intentionally excluded — operational noise and
// anonymous-auth records, not data worth restoring in a disaster.
import { backend } from './adminEntities.js';

const COLLECTIONS = [
  'MonitoredAsset',
  'AssetState',
  'SignalEvent',
  'TradeOperation',
  'PriceAlert',
];

async function main() {
  const snapshot = { taken_at: new Date().toISOString(), collections: {} };

  for (const name of COLLECTIONS) {
    const docs = await backend.entities[name].list();
    snapshot.collections[name] = docs;
    console.log(`[backup] ${name}: ${docs.length} documento(s)`);
  }

  // strategyConfig/current is a singleton doc, not queried via .list() in
  // the admin adapter (see adminEntities.js) — fetched directly instead.
  const { getFirestore } = await import('firebase-admin/firestore');
  const db = getFirestore();
  const strategyConfigSnap = await db.collection('strategyConfig').doc('current').get();
  snapshot.collections.StrategyConfig = strategyConfigSnap.exists
    ? [{ id: strategyConfigSnap.id, ...strategyConfigSnap.data() }]
    : [];
  console.log(`[backup] StrategyConfig: ${snapshot.collections.StrategyConfig.length} documento(s)`);

  const outPath = process.argv[2] || 'backup.json';
  const fs = await import('node:fs/promises');
  await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`[backup] salvo em ${outPath}`);
}

main().catch((err) => {
  console.error('[backup] FAILED:', err);
  process.exitCode = 1;
});
