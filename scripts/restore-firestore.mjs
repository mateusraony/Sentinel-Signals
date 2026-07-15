// Manual restore for a backup produced by scripts/backup-firestore.mjs.
// Deliberately NOT automated/triggered by any workflow — see
// docs/restore-firestore.md for the full procedure. Requires explicit
// confirmation before writing anything, unless --dry-run is passed.
import { readFile } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const COLLECTION_NAME_MAP = {
  MonitoredAsset: 'monitoredAssets',
  AssetState: 'assetStates',
  SignalEvent: 'signalEvents',
  TradeOperation: 'tradeOperations',
  PriceAlert: 'priceAlerts',
  StrategyConfig: 'strategyConfig',
};

async function main() {
  const filePath = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');

  if (!filePath) {
    console.error('Uso: node scripts/restore-firestore.mjs <caminho-do-backup.json> [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const snapshot = JSON.parse(await readFile(filePath, 'utf-8'));
  const entries = Object.entries(snapshot.collections || {}).filter(([, docs]) => Array.isArray(docs) && docs.length > 0);

  if (entries.length === 0) {
    console.log('Nada para restaurar (arquivo vazio ou sem coleções reconhecidas).');
    return;
  }

  console.log(`Backup de ${snapshot.taken_at || 'data desconhecida'}:`);
  for (const [name, docs] of entries) {
    const collectionName = COLLECTION_NAME_MAP[name];
    if (!collectionName) {
      console.log(`  ${name}: IGNORADO (coleção não reconhecida)`);
      continue;
    }
    console.log(`  ${name} -> ${collectionName}: ${docs.length} documento(s)`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nada foi escrito.');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nIsso vai SOBRESCREVER os documentos acima com os mesmos IDs do backup. Confirma? (digite "sim" para continuar) ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'sim') {
    console.log('Cancelado — nada foi escrito.');
    return;
  }

  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
  }
  const db = getFirestore();

  for (const [name, docs] of entries) {
    const collectionName = COLLECTION_NAME_MAP[name];
    if (!collectionName) continue;
    const col = db.collection(collectionName);
    let written = 0;
    for (const docData of docs) {
      const { id, ...data } = docData;
      if (!id) continue;
      await col.doc(id).set(data, { merge: false });
      written++;
    }
    console.log(`[restore] ${collectionName}: ${written} documento(s) restaurado(s)`);
  }

  console.log('\nRestauração concluída.');
}

main().catch((err) => {
  console.error('[restore] FAILED:', err);
  process.exitCode = 1;
});
