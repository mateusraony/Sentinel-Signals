// Verificação pós-migração Firestore→Postgres (Fase 7 do plano de migração,
// /root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md) — roda
// DEPOIS de scripts/migrate-firestore-to-postgres.mjs, antes de qualquer
// decisão de promover Postgres a backend real (fase 10 do plano).
//
// Confirma, por coleção: (1) contagem de linhas igual; (2) checksum
// determinístico igual (hash sha256 do JSON canônico de cada documento,
// concatenado em ordem de `id` — pega qualquer divergência de CONTEÚDO que
// a contagem sozinha não pegaria, ex.: um campo perdido/alterado na
// conversão). Para `TradeOperation` especificamente — o P0 mais crítico do
// motor de trading (.claude/rules/trading-engine.md) — também roda
// `groupActiveOpsByAsset` (função pura, sem mudança nenhuma) contra os
// dois datasets e compara a contagem de grupos duplicados: a migração não
// pode introduzir (nem remover) uma duplicata de operação ativa por ativo
// que não estivesse já lá na origem.
//
// Read-only nos dois lados — nunca escreve em Firestore nem em Postgres.
// Mesmo custo de leitura da migração em si (não tem como verificar sem ler
// tudo de novo) — rodar na mesma janela de manutenção do cutover, não como
// rotina agendada.
//
// Rodar manualmente: `DATABASE_URL=... FIREBASE_SERVICE_ACCOUNT_JSON=...
// node scripts/verify-postgres-migration.mjs`.
import { createHash } from 'node:crypto';
import { FieldPath } from 'firebase-admin/firestore';
import { db } from './adminEntities.js';
import { backend, closePool } from '../db/pgEntitiesCore.mjs';
import { canonicalJson, toPlainValue } from './firestorePlainValue.mjs';
import { groupActiveOpsByAsset } from '../src/lib/opTransition.js';
import { COLLECTION_ENTITIES, SINGLETON_DOCS, LIST_LIMIT_OVERRIDES } from './migrate-firestore-to-postgres.mjs';
import { forceExit } from './scanTimeout.mjs';

const PAGE_SIZE = 500;

// Exported for scripts/verify-postgres-migration.test.js.
export async function readFirestoreCollection(firestoreCollection) {
  const items = [];
  let cursor = null;
  for (;;) {
    let query = db.collection(firestoreCollection).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    snapshot.docs.forEach((docSnap) => items.push({ id: docSnap.id, ...toPlainValue(docSnap.data()) }));
    if (snapshot.docs.length < PAGE_SIZE) break;
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
  return items;
}

// Variante limitada de readFirestoreCollection — só os N mais recentes por
// `created_date` (mesma LIST_LIMIT_OVERRIDES de migrate-firestore-to-
// postgres.mjs). A verificação fica, honestamente, restrita a essa fatia —
// não é "SystemLog inteiro bate", é "os N mais recentes batem", exatamente
// o que foi migrado.
export async function readFirestoreCollectionRecent(firestoreCollection, limit) {
  const snapshot = await db.collection(firestoreCollection).orderBy('created_date', 'desc').limit(limit).get();
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...toPlainValue(docSnap.data()) }));
}

export async function readFirestoreSingleton(firestoreCollection, docId) {
  const snap = await db.collection(firestoreCollection).doc(docId).get();
  return snap.exists ? [{ id: snap.id, ...toPlainValue(snap.data()) }] : [];
}

// Determinístico independente da ordem de chegada — ordena por `id` antes
// de concatenar, então o mesmo conjunto de documentos sempre produz o mesmo
// hash dos dois lados, não importa a ordem em que Firestore/Postgres os
// devolveram.
export function checksumDocs(items) {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const hash = createHash('sha256');
  for (const item of sorted) hash.update(canonicalJson(item));
  return hash.digest('hex');
}

// Compara um par (Firestore, Postgres) já lido — pura, testável sem
// credenciais/conexão real.
export function compareDatasets(firestoreItems, postgresItems) {
  const countMatch = firestoreItems.length === postgresItems.length;
  const firestoreChecksum = checksumDocs(firestoreItems);
  const postgresChecksum = checksumDocs(postgresItems);
  return {
    firestoreCount: firestoreItems.length,
    postgresCount: postgresItems.length,
    countMatch,
    checksumMatch: firestoreChecksum === postgresChecksum,
    firestoreChecksum,
    postgresChecksum,
  };
}

// TradeOperation-specific: a mesma invariante que os dois loops mutadores
// do motor verificam ao vivo (.claude/rules/trading-engine.md, item 39.1) —
// aqui, contra os dois datasets INTEIROS, não um recorte por-scan.
export function compareTradeOpDuplicates(firestoreOps, postgresOps) {
  const firestoreGroups = groupActiveOpsByAsset(firestoreOps);
  const postgresGroups = groupActiveOpsByAsset(postgresOps);
  return {
    firestoreDuplicateGroups: firestoreGroups.duplicateGroups.size,
    postgresDuplicateGroups: postgresGroups.duplicateGroups.size,
    match: firestoreGroups.duplicateGroups.size === postgresGroups.duplicateGroups.size,
  };
}

async function verifyEntity(firestoreItems, entityName, limit) {
  const postgresItems = limit
    ? await backend.entities[entityName].list('-created_date', limit)
    : await backend.entities[entityName].list();
  const result = compareDatasets(firestoreItems, postgresItems);
  const ok = result.countMatch && result.checksumMatch;
  console.log(
    `[verify] ${entityName}${limit ? ` (${limit} mais recentes)` : ''}: Firestore=${result.firestoreCount} Postgres=${result.postgresCount} `
    + `contagem=${result.countMatch ? 'OK' : 'DIVERGE'} checksum=${result.checksumMatch ? 'OK' : 'DIVERGE'}`
  );
  return { entityName, ok, ...result, firestoreItems, postgresItems };
}

async function main() {
  const started = Date.now();
  const results = [];

  for (const [collection, entityName] of Object.entries(COLLECTION_ENTITIES)) {
    const limit = LIST_LIMIT_OVERRIDES[collection];
    const firestoreItems = limit
      ? await readFirestoreCollectionRecent(collection, limit)
      : await readFirestoreCollection(collection);
    results.push(await verifyEntity(firestoreItems, entityName, limit));
  }
  for (const [collection, entityName] of Object.entries(SINGLETON_DOCS)) {
    const firestoreItems = await readFirestoreSingleton(collection, 'current');
    results.push(await verifyEntity(firestoreItems, entityName));
  }

  const tradeOpResult = results.find((r) => r.entityName === 'TradeOperation');
  let tradeOpDuplicateCheck = null;
  if (tradeOpResult) {
    tradeOpDuplicateCheck = compareTradeOpDuplicates(tradeOpResult.firestoreItems, tradeOpResult.postgresItems);
    console.log(
      `[verify] TradeOperation grupos duplicados: Firestore=${tradeOpDuplicateCheck.firestoreDuplicateGroups} `
      + `Postgres=${tradeOpDuplicateCheck.postgresDuplicateGroups} `
      + `${tradeOpDuplicateCheck.match ? 'OK' : 'DIVERGE'}`
    );
  }

  const allOk = results.every((r) => r.ok) && (!tradeOpDuplicateCheck || tradeOpDuplicateCheck.match);
  console.log(`[verify] concluído em ${((Date.now() - started) / 1000).toFixed(1)}s — ${allOk ? 'TUDO OK' : 'DIVERGÊNCIA ENCONTRADA'}`);
  await closePool();
  if (!allOk) {
    throw new Error('Verificação encontrou divergência entre Firestore e Postgres — ver o log acima.');
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main()
    .then(() => forceExit(0))
    .catch((err) => {
      console.error('[verify] FAILED:', err);
      forceExit(1);
    });
}
