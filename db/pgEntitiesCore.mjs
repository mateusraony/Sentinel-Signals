// Adaptador Postgres/Neon compartilhado — Fase 4 do plano de migração
// (/root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md). Mesma
// forma de chamada de src/api/entities.js's `backend`
// (entities.<Nome>.{list,filter,get,set,create,createUnique,update,delete,
// bulkCreate,deleteMany}, locks, tradeOps) — o objetivo é que
// server/routes/*.js e, numa fase futura, scripts/adminEntities.js possam
// trocar de backend sem os ~20 arquivos consumidores saberem a diferença.
//
// **ESM, não CJS** (revisão da 1ª tentativa de desenho): as funções puras de
// que este módulo depende (`opTransition.js`, `assertNoUndefinedFields.js`,
// `deepMergeFirestore.js`) só existem como ESM (o `package.json` raiz é
// `"type": "module"`), e um `.cjs` não pode `require()` um módulo ESM
// estaticamente. `server/index.js` (CommonJS) consome este arquivo via
// `import()` dinâmico dentro de cada handler assíncrono — ver o comentário
// em server/index.js. `scripts/adminEntities.js` (ESM, empacotado por
// esbuild) importaria normalmente quando essa fase chegar.
//
// Backend real em produção desde o cutover (2026-09-12) — `src/api/
// entities.js` (browser) e `scripts/adminEntities.js` (cron) chamam isto
// de verdade; `src/api/entitiesFirestoreLegacy.js` preserva a versão
// Firestore só como referência de rollback.
import pg from 'pg';
import {
  canApplyTransition,
  clampMonotonicStop,
  stopAdvanceCandidateWon,
  isTerminalStatus,
  planTradeOpCreationSql,
  buildActiveOpsAnchorId,
  TRADE_OP_STATUSES,
} from '../src/lib/opTransition.js';
import { assertNoUndefinedFields } from '../src/lib/assertNoUndefinedFields.js';
import { deepMergeFirestore } from '../src/lib/deepMergeFirestore.js';
import { classifyFilter } from '../src/lib/queryFilters.js';

// Re-exportado para server/routes/tradeOps.js — assim as rotas HTTP
// carregam TUDO que precisam (backend, ENTITY_TABLES, TRADE_OP_STATUSES)
// de um único `import()` dinâmico, em vez de um 2º import separado só
// para esta constante.
export { TRADE_OP_STATUSES };

// Nome lógico (o que `backend.entities.<Nome>` usa hoje) → tabela real +
// colunas tipadas (as mesmas de db/schema.sql). Único registro — a rota
// genérica de entidades (server/routes/entities.js) importa ESTE mapa para
// decidir o que é uma coleção válida, em vez de manter um 2º registro
// separado (simplificação sobre o `server/entityRegistry.js` do desenho
// original do plano — mesmo raciocínio de "reuse antes de criar").
// TradingviewWebhookEvent e ScannerLock ficam de fora de propósito: o
// primeiro é server-only (nunca passa por `backend.entities` nem hoje no
// Firestore — só `server/index.js` toca a coleção real via SDK direto); o
// segundo tem funções dedicadas (`acquireScanLock`/`releaseScanLock`) por
// causa da semântica de lock, não de CRUD.
export const ENTITY_TABLES = Object.freeze({
  MonitoredAsset: { table: 'monitored_assets', columns: ['symbol', 'is_active', 'smc_enabled', 'created_date'] },
  AssetState: { table: 'asset_states', columns: ['asset_id', 'timeframe', 'created_date'] },
  SignalEvent: { table: 'signal_events', columns: ['symbol', 'timeframe', 'signal_type', 'source', 'notified', 'asset_id', 'created_date'] },
  TradeOperation: { table: 'trade_operations', columns: ['symbol', 'asset_id', 'status', 'side', 'current_stop', 'cascade', 'hierarchical_cascade', 'created_date'] },
  PriceAlert: { table: 'price_alerts', columns: ['created_date'] },
  SystemLog: { table: 'system_logs', columns: ['level', 'created_date'] },
  User: { table: 'users', columns: ['role', 'email', 'created_at'] },
  VerificationTask: { table: 'verification_tasks', columns: ['priority', 'status', 'asset_id', 'timeframe', 'created_date'] },
  StrategyConfig: { table: 'strategy_config', columns: ['updated_at'] },
  TelegramFilters: { table: 'telegram_filters', columns: ['updated_at'] },
});

const TERMINAL_STATUSES_SQL = "('STOP_HIT','TP2_HIT','INVALIDATED','CLOSED')";

let pool = null;
// Lazy + reset-able (não um singleton fixo no top-level): os testes de
// integração trocam TEST_DATABASE_URL por execução; um pool cacheado cedo
// demais amarraria todo o processo Node a uma única connection string.
export function getPool(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL não está setada.');
  }
  if (!pool || pool.__connectionString !== databaseUrl) {
    pool = new pg.Pool({ connectionString: databaseUrl });
    pool.__connectionString = databaseUrl;
  }
  return pool;
}

// Só para os testes fecharem a conexão de forma limpa entre suites.
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function docFromRow(row) {
  if (!row) return null;
  return { id: row.id, ...row.data };
}

// Postgres não tem placeholder (`$1`) para NOME de coluna/campo — só para
// VALOR — então `field` sempre acaba interpolado como texto na string SQL
// (abaixo, em `columnExpr`). `field` vem de fora (chaves de `?filters=`/
// `sort` na rota HTTP, JSON.parse do corpo da requisição): sem esta
// validação, um nome de campo malicioso (ex.: `foo') OR 1=1; --`) seria
// injeção de SQL de verdade — achado do sentinel-security-review desta
// fase. Todo nome de campo legítimo neste app é snake_case/camelCase
// simples (mesma convenção usada em TODO o resto do repositório) — rejeita
// qualquer coisa fora disso, nunca tenta escapar.
const SAFE_FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function assertSafeFieldName(field) {
  if (typeof field !== 'string' || !SAFE_FIELD_NAME.test(field)) {
    throw new Error(`Nome de campo inválido: "${field}".`);
  }
}

// `data->>'campo'` devolve TEXT — sem cast explícito, comparar contra um
// number/boolean do JS nunca bate (ex.: '75' = 75 numericamente funciona
// via coerção implícita do Postgres em texto vs. numeric? NÃO — precisa do
// cast). Campos tipados (coluna real) não precisam de cast: o driver `pg`
// serializa o parâmetro e o Postgres compara nos tipos nativos da coluna.
function columnExpr(columns, field) {
  assertSafeFieldName(field);
  return columns.includes(field) ? `"${field}"` : `(data->>'${field}')`;
}
function maybeCast(columns, field, sampleValue) {
  const expr = columnExpr(columns, field);
  if (columns.includes(field)) return expr;
  if (typeof sampleValue === 'number') return `(${expr})::numeric`;
  if (typeof sampleValue === 'boolean') return `(${expr})::boolean`;
  return expr;
}

// Traduz o MESMO contrato de filtro que src/lib/queryFilters.js define para
// os outros 2 backends (Firestore browser/admin) + o fake de testes — nunca
// reimplementa a semântica, só o SQL que a expressa.
function buildWhereClause(columns, filters, params) {
  const clauses = [];
  for (const [field, rawValue] of Object.entries(filters || {})) {
    const parsed = classifyFilter(field, rawValue);
    if (parsed.kind === 'skip') continue;
    if (parsed.kind === 'eq') {
      params.push(parsed.operand);
      clauses.push(`${maybeCast(columns, field, parsed.operand)} = $${params.length}`);
    } else if (parsed.kind === 'in') {
      params.push(parsed.operand);
      const sample = parsed.operand[0];
      clauses.push(`${maybeCast(columns, field, sample)} = ANY($${params.length})`);
    } else if (parsed.kind === 'range') {
      for (const { operator, operand } of parsed.ranges) {
        params.push(operand);
        clauses.push(`${maybeCast(columns, field, operand)} ${operator} $${params.length}`);
      }
    }
  }
  return clauses;
}

function buildOrderClause(columns, sort) {
  if (!sort) return '';
  const descending = sort.startsWith('-');
  const field = descending ? sort.slice(1) : sort;
  return ` ORDER BY ${columnExpr(columns, field)} ${descending ? 'DESC' : 'ASC'}`;
}

// Extrai, de um payload JS, os valores que vão em colunas tipadas (na MESMA
// ordem de `columns`) — a coluna `data` sempre leva o payload inteiro
// (campos tipados duplicados ali também, ver o cabeçalho de db/schema.sql).
function typedValues(columns, payload) {
  return columns.map((col) => (payload[col] === undefined ? null : payload[col]));
}

function createEntity(entityName) {
  const { table, columns } = ENTITY_TABLES[entityName];

  async function filter(filters = {}, sort, limitCount) {
    const params = [];
    const where = buildWhereClause(columns, filters, params);
    const sql = `SELECT id, data FROM ${table}`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + buildOrderClause(columns, sort)
      + (limitCount ? ` LIMIT ${Number(limitCount)}` : '');
    const { rows } = await getPool().query(sql, params);
    return rows.map(docFromRow);
  }

  async function list(sort, limitCount) {
    return filter({}, sort, limitCount);
  }

  async function get(id) {
    const { rows } = await getPool().query(`SELECT id, data FROM ${table} WHERE id = $1`, [id]);
    return rows[0] ? docFromRow(rows[0]) : null;
  }

  // Upsert por id com MERGE RECURSIVO (setDoc(...,{merge:true}) do
  // Firestore) — só StrategyConfig/TelegramFilters usam isto hoje. Não dá
  // pra expressar merge recursivo arbitrário só com o operador `||` do
  // JSONB (raso) — lê o valor atual, mescla em JS com a MESMA função usada
  // pelo fake de testes, escreve de volta, tudo numa transação.
  async function set(id, data) {
    assertNoUndefinedFields(data, entityName);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT data FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      const merged = deepMergeFirestore(rows[0]?.data || {}, data);
      const cols = typedValues(columns, merged);
      const setCols = columns.map((c, i) => `"${c}" = $${i + 3}`).join(', ');
      await client.query(
        `INSERT INTO ${table} (id, ${columns.map((c) => `"${c}"`).join(', ')}, data)
         VALUES ($1, ${columns.map((_, i) => `$${i + 3}`).join(', ')}, $2)
         ON CONFLICT (id) DO UPDATE SET data = $2${setCols ? `, ${setCols}` : ''}`,
        [id, JSON.stringify(merged), ...cols]
      );
      await client.query('COMMIT');
      return { id, ...data };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function create(data) {
    const payload = { ...data, created_date: data.created_date || nowIso() };
    assertNoUndefinedFields(payload, entityName);
    const id = crypto.randomUUID();
    const cols = typedValues(columns, payload);
    await getPool().query(
      `INSERT INTO ${table} (id, ${columns.map((c) => `"${c}"`).join(', ')}, data)
       VALUES ($1, ${columns.map((_, i) => `$${i + 3}`).join(', ')}, $2)`,
      [id, JSON.stringify(payload), ...cols]
    );
    return { id, ...payload };
  }

  // create-if-absent atômico por id determinístico — o `ON CONFLICT DO
  // NOTHING` é o que serializa 2 chamadores concorrentes (browser + cron)
  // disputando a MESMA dedup key, equivalente à transação do Firestore.
  async function createUnique(id, data) {
    const payload = { ...data, created_date: data.created_date || nowIso() };
    assertNoUndefinedFields(payload, entityName);
    const cols = typedValues(columns, payload);
    const { rows } = await getPool().query(
      `INSERT INTO ${table} (id, ${columns.map((c) => `"${c}"`).join(', ')}, data)
       VALUES ($1, ${columns.map((_, i) => `$${i + 3}`).join(', ')}, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, data`,
      [id, JSON.stringify(payload), ...cols]
    );
    if (rows.length > 0) {
      return { created: true, doc: docFromRow(rows[0]) };
    }
    const existing = await get(id);
    return { created: false, existing };
  }

  async function update(id, data) {
    assertNoUndefinedFields(data, entityName);
    const presentTypedCols = columns.filter((c) => data[c] !== undefined);
    const params = [id, JSON.stringify(data)];
    const setCols = presentTypedCols.map((c) => {
      params.push(data[c]);
      return `"${c}" = $${params.length}`;
    }).join(', ');
    await getPool().query(
      `UPDATE ${table} SET data = data || $2${setCols ? `, ${setCols}` : ''} WHERE id = $1`,
      params
    );
    return { id, ...data };
  }

  async function del(id) {
    await getPool().query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  }

  async function bulkCreate(items) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const created = [];
      for (const item of items) {
        const payload = { ...item, created_date: item.created_date || nowIso() };
        assertNoUndefinedFields(payload, entityName);
        const id = crypto.randomUUID();
        const cols = typedValues(columns, payload);
        await client.query(
          `INSERT INTO ${table} (id, ${columns.map((c) => `"${c}"`).join(', ')}, data)
           VALUES ($1, ${columns.map((_, i) => `$${i + 3}`).join(', ')}, $2)`,
          [id, JSON.stringify(payload), ...cols]
        );
        created.push({ id, ...payload });
      }
      await client.query('COMMIT');
      return created;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Devolve os docs deletados (mesmo contrato de src/api/entities.js's
  // deleteMany hoje) — SELECT antes do DELETE, mesma transação.
  async function deleteMany(filters = {}) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const params = [];
      const where = buildWhereClause(columns, filters, params);
      const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const { rows } = await client.query(`SELECT id, data FROM ${table}${whereSql}`, params);
      await client.query(`DELETE FROM ${table}${whereSql}`, params);
      await client.query('COMMIT');
      return rows.map(docFromRow);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { list, filter, get, set, create, createUnique, update, delete: del, bulkCreate, deleteMany };
}

// --- Importação em massa (Fase 7 do plano de migração,
// scripts/migrate-firestore-to-postgres.mjs) ------------------------------

// Diferente de bulkCreate() (que sempre GERA um id novo — pensado para
// escrita ao vivo, nunca para migração), esta função PRESERVA o id de cada
// item: é o que a migração real precisa (ver o plano, "Design de schema
// Postgres" — reaproveitar o ID do documento Firestore tal como está evita
// remapear referências cruzadas como `asset_id` entre coleções). Upsert
// completo (`ON CONFLICT DO UPDATE`), não "insere se ainda não existir": a
// migração pode rodar mais de uma vez contra o mesmo Postgres antes do
// cutover real (ex.: validação contra um branch de teste do Neon, ou uma
// 2ª rodada mais próxima do cutover) — cada rodada deve convergir para o
// snapshot ATUAL do Firestore, nunca deixar uma linha desatualizada
// silenciosamente por trás de um "já existe, ignorado".
//
// Nunca toca `active_ops_anchor` (só existe em `trade_operations`, fora de
// `columns` de propósito — ver ENTITY_TABLES.TradeOperation acima): essa
// coluna só é escrita pelas 2 transações do CAS
// (createTradeOpIfNoneActive/transitionTradeOp) e existe só para o índice
// único parcial pegar a corrida de criação CONCORRENTE (2 chamadores
// inserindo ao mesmo tempo quando nenhuma linha existe ainda). A decisão
// de bloqueio do CAS lê `status`/`asset_id`/`cascade`/`hierarchical_cascade`
// direto da tabela (`planTradeOpCreationSql`), nunca a âncora — uma
// operação ativa migrada com âncora NULL já bloqueia corretamente uma
// nova criação para o mesmo ativo (o `SELECT ... FOR UPDATE WHERE
// asset_id = $1 AND status NOT IN (terminal)` encontra essa linha
// normalmente). Nada a reconstruir aqui.
export async function bulkImportEntity(entityName, items) {
  if (items.length === 0) return { upserted: 0 };
  const { table, columns } = ENTITY_TABLES[entityName];
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const { id, ...rest } = item;
      if (!id) throw new Error(`bulkImportEntity(${entityName}): item sem id.`);
      assertNoUndefinedFields(rest, entityName);
      const cols = typedValues(columns, rest);
      const setCols = columns.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
      await client.query(
        `INSERT INTO ${table} (id, ${columns.map((c) => `"${c}"`).join(', ')}, data)
         VALUES ($1, ${columns.map((_, i) => `$${i + 3}`).join(', ')}, $2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data${setCols ? `, ${setCols}` : ''}`,
        [id, JSON.stringify(rest), ...cols]
      );
    }
    await client.query('COMMIT');
    return { upserted: items.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- tradingview_webhook_events (server-only) -----------------------------
// Equivalente Postgres da transação de dedup do webhook TradingView
// (`server/index.js`'s `POST /webhook/tradingview`, hoje: `db.runTransaction`
// lê o doc por `signal_id`, devolve `false` se já existe, senão grava e
// devolve `true`). `tradingviewWebhookEvents`/`tradingview_webhook_events`
// foi deliberadamente excluída de `ENTITY_TABLES` (ver `db/schema.sql`:
// "server-only, nunca passa pela rota genérica nem por `backend.entities`")
// — por isso esta função não reusa `createEntity`, é o único ponto de
// escrita dessa tabela. `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING
// id` é atômico sob concorrência real (2 requisições simultâneas com o
// mesmo `signal_id`, ex.: retry do TradingView): o Postgres garante que só
// uma `INSERT` "ganha" a linha (`RETURNING id` devolve 1 linha), a outra
// recebe zero linhas — sem precisar de transação explícita nem de `SELECT
// ... FOR UPDATE` prévio, ao contrário do CAS de `TradeOperation` acima
// (aqui não há decisão além de "já existe ou não").
//
// Item 4b do runbook de cutover (docs/claude/postgres-cutover-runbook.md)
// — **já chamada de verdade por `server/index.js`'s `POST /webhook/
// tradingview`** desde o cutover (2026-09-12); a transação Firestore
// original foi removida.
export async function insertWebhookEventIfNew(id, data) {
  assertNoUndefinedFields(data, 'TradingviewWebhookEvent');
  const { rows } = await getPool().query(
    `INSERT INTO tradingview_webhook_events (id, source, received_at, data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, data.source ?? null, data.received_at ?? nowIso(), JSON.stringify(data)]
  );
  return { created: rows.length > 0 };
}

// --- Locks (scannerLocks → scanner_locks) ---------------------------------

async function acquireScanLock(lockName, ttlMs, holder) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT expires_at FROM scanner_locks WHERE id = $1 FOR UPDATE', [lockName]);
    const now = Date.now();
    if (rows[0] && Number(rows[0].expires_at) > now) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO scanner_locks (id, locked_by, locked_at, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET locked_by = $2, locked_at = $3, expires_at = $4`,
      [lockName, holder, now, now + ttlMs]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function releaseScanLock(lockName, holder) {
  await getPool().query(
    'UPDATE scanner_locks SET locked_by = NULL, locked_at = NULL, expires_at = 0 WHERE id = $1 AND locked_by = $2',
    [lockName, holder]
  );
}

// --- tradeOps (o CAS redesenhado — ver a seção "Redesenho do CAS em
// Postgres" do plano, revisada por sentinel-council-review) --------------

const TRADE_OPS_COLUMNS = ENTITY_TABLES.TradeOperation.columns;

function tradeOpTypedValues(payload) {
  return typedValues(TRADE_OPS_COLUMNS, payload);
}

async function createTradeOpIfNoneActive(assetId, docId, data, cascade) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: activeRows } = await client.query(
      `SELECT id, status, cascade, hierarchical_cascade FROM trade_operations
       WHERE asset_id = $1 AND status NOT IN ${TERMINAL_STATUSES_SQL} FOR UPDATE`,
      [assetId]
    );
    const { rows: existingRows } = await client.query('SELECT id, data FROM trade_operations WHERE id = $1', [docId]);
    const existingOpById = existingRows[0] ? docFromRow(existingRows[0]) : null;

    const plan = planTradeOpCreationSql({ activeRowsForAsset: activeRows, existingOpById, cascade, docId });

    if (plan.action === 'blocked') {
      await client.query('ROLLBACK');
      const blocker = activeRows.find((r) => r.id !== docId);
      return { created: false, existingId: blocker ? blocker.id : null };
    }
    if (plan.action === 'reuse') {
      await client.query('ROLLBACK');
      return { created: false, existing: existingOpById };
    }

    const payload = { ...data, created_date: data.created_date || nowIso() };
    assertNoUndefinedFields(payload, 'TradeOperation');
    const anchor = buildActiveOpsAnchorId(assetId, cascade);
    const cols = tradeOpTypedValues(payload);
    try {
      await client.query(
        `INSERT INTO trade_operations
           (id, ${TRADE_OPS_COLUMNS.map((c) => `"${c}"`).join(', ')}, active_ops_anchor, data)
         VALUES ($1, ${TRADE_OPS_COLUMNS.map((_, i) => `$${i + 4}`).join(', ')}, $2, $3)`,
        [docId, anchor, JSON.stringify(payload), ...cols]
      );
    } catch (err) {
      // 23505 = unique_violation em trade_operations_active_anchor_uq — a
      // corrida que o índice existe para fechar (ver db/concurrency.test.js):
      // outra transação venceu entre o SELECT...FOR UPDATE acima (que não
      // trava linha nenhuma quando o asset ainda não tem NENHUMA op ativa) e
      // este INSERT. Tratado como "perdeu a corrida", nunca como exceção.
      if (err.code === '23505') {
        await client.query('ROLLBACK');
        return { created: false, existingId: null };
      }
      throw err;
    }
    await client.query('COMMIT');
    return { created: true, doc: { id: docId, ...payload } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// No-op documentado — sem ponteiro (`assetActiveOps`) não há nada para
// limpar; `active_ops_anchor` é limpo dentro de `transitionTradeOp` no MESMO
// UPDATE que grava um status terminal. Mantém a assinatura para
// `scanner.js` continuar chamando sem modificação (regra P0: scanner.js não
// muda entre backends).
async function clearActiveOp(_assetId, _tradeOpId, _cascade) {
  // Intencionalmente vazio.
}

async function transitionTradeOp(opId, fromStatus, patch, { stopAdvanceMarkerField } = {}) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, data FROM trade_operations WHERE id = $1 FOR UPDATE', [opId]);
    const current = rows[0] ? docFromRow(rows[0]) : null;
    if (!canApplyTransition(current, fromStatus)) {
      await client.query('ROLLBACK');
      return { applied: false, currentStatus: current ? current.status : null };
    }

    let safePatch = patch;
    if (patch.current_stop != null) {
      const clampedStop = clampMonotonicStop({ side: current.side, existingStop: current.current_stop, candidateStop: patch.current_stop });
      safePatch = { ...patch, current_stop: clampedStop };
      if (stopAdvanceMarkerField && !stopAdvanceCandidateWon({
        clampedStop,
        candidateStop: patch.current_stop,
        candidateCandleTime: patch[stopAdvanceMarkerField],
        existingMarkerCandleTime: current[stopAdvanceMarkerField],
      })) {
        delete safePatch[stopAdvanceMarkerField];
      }
    }
    assertNoUndefinedFields(safePatch, 'TradeOperation');

    const presentTypedCols = TRADE_OPS_COLUMNS.filter((c) => safePatch[c] !== undefined);
    const params = [opId, JSON.stringify(safePatch)];
    const setParts = presentTypedCols.map((c) => {
      params.push(safePatch[c]);
      return `"${c}" = $${params.length}`;
    });
    if (isTerminalStatus(safePatch.status)) {
      setParts.push('active_ops_anchor = NULL');
    }
    await client.query(
      `UPDATE trade_operations SET data = data || $2${setParts.length ? `, ${setParts.join(', ')}` : ''} WHERE id = $1`,
      params
    );
    await client.query('COMMIT');
    return { applied: true, patch: safePatch };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Postgres/Neon não tem teto diário de operações — não há cota para
// contar. Mantido como stub (sempre zero) só para o consumidor genérico
// `backend.quota.getAndResetOpCounts()` não precisar de um caminho especial
// por backend.
function getAndResetOpCounts() {
  return { reads: 0, writes: 0 };
}

export const backend = {
  entities: Object.fromEntries(Object.keys(ENTITY_TABLES).map((name) => [name, createEntity(name)])),
  locks: { acquireScanLock, releaseScanLock },
  tradeOps: { createTradeOpIfNoneActive, clearActiveOp, transitionTradeOp },
  quota: { getAndResetOpCounts },
};
