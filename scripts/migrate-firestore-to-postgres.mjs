// One-time Firestore→Postgres data migration (Fase 7 do plano de migração
// Firestore→Neon, /root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md).
//
// Lê cada coleção de negócio DIRETO do firebase-admin/firestore (não passa
// pelo adaptador Firestore sendo substituído — src/api/entities.js/
// scripts/adminEntities.js's `backend` — que não tem cursor de paginação e
// reintroduziria a abstração que este script existe para aposentar) e
// escreve em Postgres via db/pgEntitiesCore.mjs's `bulkImportEntity`
// (upsert, preserva o id original do documento — evita remapear
// referências cruzadas como `asset_id` entre coleções).
//
// **Não é o cutover em si.** src/api/entities.js (Firestore) continua
// sendo o backend real até a fase de execução do cutover (fase 10 do
// plano) — rodar isto só preenche/atualiza a instância Postgres para ela
// poder ser validada (scripts/verify-postgres-migration.mjs) e promovida
// depois. Idempotente/rerunnable: cada página faz upsert (`ON CONFLICT DO
// UPDATE`), então rodar de novo (ex.: validação contra um branch de teste
// do Neon, ou uma 2ª rodada mais próxima do cutover real) sempre converge
// para o snapshot ATUAL do Firestore.
//
// Paginação real por cursor de documento (`FieldPath.documentId()` +
// `startAfter`), não um único list() gigante — lição já paga em produção
// nesta sessão (docs/known-risks.md item 152 addendum: um list() sem
// limite em SystemLog leu ~49.700 documentos NUM SÓ REQUEST, quase a cota
// diária inteira do plano Spark, e derrubou o próximo scan agendado). Uma
// migração real de TODO o histórico ainda vai custar ~a mesma leitura
// total contra a cota — não tem como migrar tudo por menos que ler tudo —
// mas paginar evita um único request gigante (timeout, pico de memória) e
// deixa o custo visível/interrompível página a página. Rodar isto é
// inerentemente uma operação de "custo alto, uma vez", prevista para a
// janela de manutenção do cutover — não é rotina, não tem workflow
// agendado.
//
// Escopo: as 8 coleções "plurais" + os 2 documentos singleton (`current`)
// registrados em ENTITY_TABLES (o mesmo registro que server/routes/
// entities.js usa) — as mesmas entidades que passam por `backend.entities`
// hoje. Fora de propósito, mesmo raciocínio já documentado em
// db/pgEntitiesCore.mjs: `tradingviewWebhookEvents` (log de dedup só de
// auditoria — nenhum consumidor depende do histórico, só do id no momento
// do recebimento) e `scannerLocks` (estado de execução efêmero — "quem
// está rodando agora" não tem sentido carregado de um backend pro outro).
// `agentConversations` (Strategy Reviewer pausado) e as 3 coleções
// `experimentalRf1hShadow*` (shadow A/B) também ficam de fora — decisão de
// escopo já registrada no plano ("Decisões de escopo desta rodada").
//
// Rodar manualmente: `DATABASE_URL=... FIREBASE_SERVICE_ACCOUNT_JSON=...
// node scripts/migrate-firestore-to-postgres.mjs`.
import { FieldPath } from 'firebase-admin/firestore';
import { db } from './adminEntities.js';
import { bulkImportEntity, closePool } from '../db/pgEntitiesCore.mjs';
import { toPlainValue } from './firestorePlainValue.mjs';
import { forceExit } from './scanTimeout.mjs';

const PAGE_SIZE = 500;

// Coleção Firestore (plural) → nome lógico da entidade (ENTITY_TABLES) —
// mesma tabela de referência do CLAUDE.md raiz (schema-reference/*.jsonc).
export const COLLECTION_ENTITIES = {
  monitoredAssets: 'MonitoredAsset',
  assetStates: 'AssetState',
  signalEvents: 'SignalEvent',
  tradeOperations: 'TradeOperation',
  priceAlerts: 'PriceAlert',
  systemLogs: 'SystemLog',
  users: 'User',
  verificationTasks: 'VerificationTask',
};

// Documentos singleton (id fixo 'current') — sem coleção "plural" pra
// paginar, um único get() cada.
export const SINGLETON_DOCS = {
  strategyConfig: 'StrategyConfig',
  telegramFilters: 'TelegramFilters',
};

// Mesma lição já paga em produção (docs/known-risks.md item 152 addendum,
// incidente real de scripts/backfill-rtdb.mjs): `systemLogs` sozinho já
// mediu ~49.700 documentos — quase a cota diária INTEIRA do Firestore
// Spark (~50k leituras/dia). Migrar o histórico inteiro custaria a mesma
// leitura que já derrubou um scan agendado uma vez (paginar evita um único
// request gigante, mas não reduz a CONTAGEM de leituras cobradas). Como
// SystemLog é diagnóstico (nenhum consumidor de produção depende do
// histórico completo — só Logs.jsx/DebugLogButton.jsx, que já mostram no
// máximo 200/50 linhas), migrar só os mais recentes é seguro: mesmo limite
// de `backfill-rtdb.mjs`'s LIST_LIMIT_OVERRIDES.
export const LIST_LIMIT_OVERRIDES = {
  systemLogs: 2000,
};

function docToItem(docSnap) {
  return { id: docSnap.id, ...toPlainValue(docSnap.data()) };
}

// Exported for scripts/migrate-firestore-to-postgres.test.js — thin wrapper
// (paginação + chamada a bulkImportEntity) é a parte testável sem
// credenciais reais, mesma convenção de backfill-rtdb.mjs's
// backfillCollection.
export async function migrateCollection(firestoreCollection, entityName) {
  let cursor = null;
  let total = 0;
  for (;;) {
    let query = db.collection(firestoreCollection).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;

    const items = snapshot.docs.map(docToItem);
    await bulkImportEntity(entityName, items);
    total += items.length;
    console.log(`[migrate] ${firestoreCollection}: +${items.length} (${total} até agora)`);

    if (snapshot.docs.length < PAGE_SIZE) break;
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
  console.log(`[migrate] ${firestoreCollection}: concluído, ${total} documento(s)`);
  return total;
}

// Variante limitada de migrateCollection — só os N mais recentes por
// `created_date` (ver LIST_LIMIT_OVERRIDES acima), num único get() em vez
// de paginação exaustiva. Usada só para `systemLogs` hoje.
export async function migrateRecentCollection(firestoreCollection, entityName, limit) {
  const snapshot = await db.collection(firestoreCollection).orderBy('created_date', 'desc').limit(limit).get();
  const items = snapshot.docs.map(docToItem);
  if (items.length) await bulkImportEntity(entityName, items);
  console.log(`[migrate] ${firestoreCollection}: ${items.length} documento(s) migrado(s) (limitado aos ${limit} mais recentes)`);
  return items.length;
}

export async function migrateSingleton(firestoreCollection, docId, entityName) {
  const snap = await db.collection(firestoreCollection).doc(docId).get();
  if (!snap.exists) {
    console.log(`[migrate] ${firestoreCollection}/${docId}: não existe, pulado`);
    return 0;
  }
  await bulkImportEntity(entityName, [docToItem(snap)]);
  console.log(`[migrate] ${firestoreCollection}/${docId}: migrado`);
  return 1;
}

async function main() {
  const started = Date.now();
  const counts = {};
  for (const [collection, entityName] of Object.entries(COLLECTION_ENTITIES)) {
    const limit = LIST_LIMIT_OVERRIDES[collection];
    counts[collection] = limit
      ? await migrateRecentCollection(collection, entityName, limit)
      : await migrateCollection(collection, entityName);
  }
  for (const [collection, entityName] of Object.entries(SINGLETON_DOCS)) {
    counts[collection] = await migrateSingleton(collection, 'current', entityName);
  }
  const totalDocs = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`[migrate] concluído em ${((Date.now() - started) / 1000).toFixed(1)}s — ${totalDocs} documento(s) no total`);
  console.log('[migrate] por coleção:', JSON.stringify(counts, null, 2));
  await closePool();
}

// Guarded (mesmo padrão de backfill-rtdb.mjs) so this file can be `import`ed
// for testing migrateCollection/migrateSingleton without also auto-running
// main() — `node scripts/migrate-firestore-to-postgres.mjs` still runs it
// exactly the same.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main()
    .then(() => forceExit(0))
    .catch((err) => {
      // forceExit também no caminho de erro (docs/known-risks.md item 152) —
      // mesmo motivo de backfill-rtdb.mjs: firebase-admin/database (quando
      // FIREBASE_DATABASE_URL está setada) mantém uma conexão WebSocket
      // persistente que impede o processo de encerrar sozinho.
      console.error('[migrate] FAILED:', err);
      forceExit(1);
    });
}
