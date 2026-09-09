// Migra E verifica cada coleção contra o MESMO snapshot do Firestore, sem
// reler o Firestore entre as duas etapas — corrige um achado real do Codex
// review no PR #334 (comentário em verify-postgres-migration.mjs:128):
// rodar scripts/migrate-firestore-to-postgres.mjs e scripts/verify-
// postgres-migration.mjs como 2 processos separados em sequência faz cada
// um ler o Firestore DE NOVO. O "ensaio" (item 6 do runbook de cutover,
// docs/claude/postgres-cutover-runbook.md) roda DE PROPÓSITO fora da
// janela de manutenção, com o cron ao vivo ainda ativo (~5min de
// cadência) — se ele escrever entre a leitura do migrate e a leitura do
// verify, a verificação compara contra um Firestore que já mudou e
// reporta divergência falsa mesmo com a migração correta. Pior ainda para
// coleções ATUALIZADAS em vez de criadas (AssetState/TradeOperation mudam
// a cada scan sem `created_date` novo) — um cutoff por `created_date` não
// pegaria isso, só um snapshot de verdade resolve.
//
// Corrigido lendo cada coleção do Firestore só UMA vez: escreve no
// Postgres e verifica contra o MESMO array em memória — a corrida deixa
// de existir por construção, não só encolhe. 100% reuso das peças já
// existentes/testadas (nenhuma lógica nova de leitura/comparação):
// readFirestoreCollection(Recent)/readFirestoreSingleton e
// compareDatasets/compareTradeOpDuplicates de verify-postgres-
// migration.mjs, bulkImportEntity de db/pgEntitiesCore.mjs,
// COLLECTION_ENTITIES/SINGLETON_DOCS/LIST_LIMIT_OVERRIDES de migrate-
// firestore-to-postgres.mjs.
//
// scripts/migrate-firestore-to-postgres.mjs e scripts/verify-postgres-
// migration.mjs continuam existindo e utilizáveis separadamente — no dia
// real do cutover o cron já está pausado (passo 1 do runbook antes dos
// passos 2/3), então a corrida não existe lá e rodar os dois scripts
// originais continua válido. Este script combinado é o que
// `.github/workflows/migrate-postgres.yml` (item 7) chama, porque é ele
// quem também serve o ensaio (item 6) com o cron tipicamente ativo — mais
// forte em qualquer um dos dois casos, nunca mais fraco.
//
// Rodar manualmente: `DATABASE_URL=... FIREBASE_SERVICE_ACCOUNT_JSON=...
// node scripts/migrate-and-verify-postgres.mjs`.
import { bulkImportEntity, backend, closePool } from '../db/pgEntitiesCore.mjs';
import { groupActiveOpsByAsset } from '../src/lib/opTransition.js';
import { COLLECTION_ENTITIES, SINGLETON_DOCS, LIST_LIMIT_OVERRIDES } from './migrate-firestore-to-postgres.mjs';
import { readFirestoreCollection, readFirestoreCollectionRecent, readFirestoreSingleton, compareDatasets, compareTradeOpDuplicates } from './verify-postgres-migration.mjs';
import { forceExit } from './scanTimeout.mjs';

// Mesmo tamanho de página de scripts/migrate-firestore-to-postgres.mjs —
// achado real por review externa (Codex, PR #337): bulkImportEntity abre 1
// única transação (BEGIN...COMMIT) pra TODOS os itens recebidos numa
// chamada. migrateCollection original chamava bulkImportEntity 1x POR
// PÁGINA (≤500 itens), então uma coleção grande nunca virava uma
// transação sem limite. Aqui a leitura do Firestore já acontece inteira em
// memória (é o que elimina a corrida de snapshot — ver o cabeçalho do
// arquivo), mas a ESCRITA no Postgres precisa continuar em lotes, senão
// uma coleção crescendo (signalEvents, tradeOperations) vira 1 transação
// gigante — arriscando estourar limite do Neon ou o timeout de 20min do
// workflow, e derrubando a migração INTEIRA da coleção numa falha parcial
// (em vez de só a última página, como antes).
const WRITE_CHUNK_SIZE = 500;

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// Exported for scripts/migrate-and-verify-postgres.test.js — lê o Firestore
// UMA vez (via readFirestoreCollection(Recent), mesma paginação de
// scripts/migrate-firestore-to-postgres.mjs's migrateCollection — os dois
// usam o mesmo cursor FieldPath.documentId()), escreve tudo no Postgres, e
// compara o array já em memória contra uma leitura fresca do Postgres (essa
// releitura é segura: nada além deste processo escreve no Postgres que
// acabou de popular).
export async function migrateAndVerifyCollection(firestoreCollection, entityName) {
  const limit = LIST_LIMIT_OVERRIDES[firestoreCollection];
  const firestoreItems = limit
    ? await readFirestoreCollectionRecent(firestoreCollection, limit)
    : await readFirestoreCollection(firestoreCollection);
  for (const page of chunk(firestoreItems, WRITE_CHUNK_SIZE)) {
    await bulkImportEntity(entityName, page);
  }

  const postgresItems = limit
    ? await backend.entities[entityName].list('-created_date', limit)
    : await backend.entities[entityName].list();
  const result = compareDatasets(firestoreItems, postgresItems);
  const ok = result.countMatch && result.checksumMatch;
  console.log(
    `[migrate-and-verify] ${entityName}${limit ? ` (${limit} mais recentes)` : ''}: `
    + `${firestoreItems.length} documento(s) migrado(s) — `
    + `contagem=${result.countMatch ? 'OK' : 'DIVERGE'} checksum=${result.checksumMatch ? 'OK' : 'DIVERGE'}`
  );
  return { entityName, ok, ...result, firestoreItems, postgresItems };
}

export async function migrateAndVerifySingleton(firestoreCollection, docId, entityName) {
  const firestoreItems = await readFirestoreSingleton(firestoreCollection, docId);
  if (firestoreItems.length) await bulkImportEntity(entityName, firestoreItems);

  const postgresDoc = await backend.entities[entityName].get(docId);
  const postgresItems = postgresDoc ? [postgresDoc] : [];
  const result = compareDatasets(firestoreItems, postgresItems);
  const ok = result.countMatch && result.checksumMatch;
  console.log(
    `[migrate-and-verify] ${entityName}/${docId}: ${firestoreItems.length} documento(s) migrado(s) — `
    + `contagem=${result.countMatch ? 'OK' : 'DIVERGE'} checksum=${result.checksumMatch ? 'OK' : 'DIVERGE'}`
  );
  return { entityName, ok, ...result, firestoreItems, postgresItems };
}

async function main() {
  const started = Date.now();
  const results = [];

  for (const [collection, entityName] of Object.entries(COLLECTION_ENTITIES)) {
    results.push(await migrateAndVerifyCollection(collection, entityName));
  }
  for (const [collection, entityName] of Object.entries(SINGLETON_DOCS)) {
    results.push(await migrateAndVerifySingleton(collection, 'current', entityName));
  }

  const tradeOpResult = results.find((r) => r.entityName === 'TradeOperation');
  let tradeOpDuplicateCheck = null;
  if (tradeOpResult) {
    tradeOpDuplicateCheck = compareTradeOpDuplicates(tradeOpResult.firestoreItems, tradeOpResult.postgresItems);
    console.log(
      `[migrate-and-verify] TradeOperation grupos duplicados: Firestore=${tradeOpDuplicateCheck.firestoreDuplicateGroups} `
      + `Postgres=${tradeOpDuplicateCheck.postgresDuplicateGroups} `
      + `${tradeOpDuplicateCheck.match ? 'OK' : 'DIVERGE'}`
    );
  }

  const allOk = results.every((r) => r.ok) && (!tradeOpDuplicateCheck || tradeOpDuplicateCheck.match);
  const totalDocs = results.reduce((a, r) => a + r.firestoreItems.length, 0);
  console.log(
    `[migrate-and-verify] concluído em ${((Date.now() - started) / 1000).toFixed(1)}s — `
    + `${totalDocs} documento(s) migrado(s) — ${allOk ? 'TUDO OK' : 'DIVERGÊNCIA ENCONTRADA'}`
  );
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
      console.error('[migrate-and-verify] FAILED:', err);
      forceExit(1);
    });
}
