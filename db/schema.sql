-- Sentinel Signals — schema Postgres/Neon (migração de docs/known-risks.md,
-- plano em /root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md).
--
-- Padrão híbrido: cada coleção Firestore vira uma tabela com `id TEXT
-- PRIMARY KEY` (reaproveita o ID do documento tal como está — evita
-- remapear referências cruzadas como `asset_id` durante a migração de
-- dados), colunas tipadas reais só para os campos usados em `WHERE`/
-- `ORDER BY` hoje (os mesmos campos dos 16 índices compostos do
-- firestore.indexes.json) e uma coluna `data JSONB` com o documento
-- completo (os campos indexados são duplicados ali também, por
-- simplicidade — write-once, sem custo real). Um filtro por um campo
-- arbitrário (não indexado) cai em `data->>'campo'` — funciona sem índice,
-- equivalente a "Firestore sem índice composto para aquele filtro" hoje.
--
-- Datas: o repositório inteiro já usa string ISO8601 (`new
-- Date().toISOString()`) em vez do tipo Timestamp nativo do Firestore
-- (única exceção, `serverTimestamp()` em AuthContext.jsx, mapeada para
-- `timestamptz DEFAULT now()` abaixo) — por isso as colunas de data são
-- `timestamptz`, não texto.
--
-- Rodar via `db/migrate.mjs` (runner leve, sem ORM, tabela
-- `schema_migrations`) — nunca aplicar este arquivo à mão em produção.

-- ============================================================
-- monitoredAssets → monitored_assets
-- ============================================================
CREATE TABLE IF NOT EXISTS monitored_assets (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  is_active BOOLEAN,
  smc_enabled BOOLEAN,
  created_date TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS monitored_assets_symbol_idx ON monitored_assets (symbol);
CREATE INDEX IF NOT EXISTS monitored_assets_is_active_idx ON monitored_assets (is_active);

-- ============================================================
-- assetStates → asset_states
-- ============================================================
CREATE TABLE IF NOT EXISTS asset_states (
  id TEXT PRIMARY KEY,
  asset_id TEXT,
  timeframe TEXT,
  created_date TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
-- Não é UNIQUE: hoje o adaptador cria via ID auto-gerado (addDoc) e
-- localiza um estado existente por filter({asset_id, timeframe}) antes de
-- update() — check-then-write não atômico, não a chave primária, garante
-- (na prática) 1 doc por par. Porte fiel do comportamento atual, não uma
-- correção — ver docs/known-risks.md se isso virar um problema real.
CREATE INDEX IF NOT EXISTS asset_states_asset_timeframe_idx ON asset_states (asset_id, timeframe);

-- ============================================================
-- signalEvents → signal_events
-- ============================================================
CREATE TABLE IF NOT EXISTS signal_events (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  timeframe TEXT,
  signal_type TEXT,
  source TEXT,
  notified BOOLEAN,
  asset_id TEXT,
  created_date TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS signal_events_dashboard_idx
  ON signal_events (symbol, timeframe, signal_type, source, notified, created_date DESC);
CREATE INDEX IF NOT EXISTS signal_events_asset_source_tf_idx
  ON signal_events (asset_id, source, timeframe, created_date DESC);
CREATE INDEX IF NOT EXISTS signal_events_asset_created_idx
  ON signal_events (asset_id, created_date DESC);

-- ============================================================
-- tradeOperations → trade_operations
--
-- `active_ops_anchor` + o índice único parcial abaixo é o mecanismo do CAS
-- redesenhado (ver a seção "Redesenho do CAS em Postgres" do plano,
-- revisada por sentinel-council-review): substitui o documento-âncora
-- `assetActiveOps` do Firestore. Gravado como
-- buildActiveOpsAnchorId(asset_id, cascade) na criação (mesma função pura
-- de src/lib/opTransition.js) e limpo (NULL) no mesmo UPDATE que grava um
-- status terminal — um NULL nunca colide com outro NULL num índice único
-- (comportamento padrão do Postgres), então uma op terminal libera o
-- ativo automaticamente.
-- ============================================================
CREATE TABLE IF NOT EXISTS trade_operations (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  asset_id TEXT,
  status TEXT,
  side TEXT,
  current_stop NUMERIC,
  cascade TEXT,
  hierarchical_cascade BOOLEAN,
  active_ops_anchor TEXT,
  created_date TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS trade_operations_symbol_asset_status_idx
  ON trade_operations (symbol, asset_id, status);
CREATE INDEX IF NOT EXISTS trade_operations_asset_status_idx
  ON trade_operations (asset_id, status);
CREATE INDEX IF NOT EXISTS trade_operations_status_created_idx
  ON trade_operations (status, created_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS trade_operations_active_anchor_uq
  ON trade_operations (active_ops_anchor)
  WHERE status NOT IN ('STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED');

-- ============================================================
-- priceAlerts → price_alerts
-- ============================================================
CREATE TABLE IF NOT EXISTS price_alerts (
  id TEXT PRIMARY KEY,
  created_date TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS price_alerts_created_idx ON price_alerts (created_date DESC);

-- ============================================================
-- systemLogs → system_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS system_logs (
  id TEXT PRIMARY KEY,
  level TEXT,
  created_date TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS system_logs_created_idx ON system_logs (created_date DESC);
CREATE INDEX IF NOT EXISTS system_logs_level_idx ON system_logs (level);

-- ============================================================
-- users → users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, -- Firebase Auth uid
  role TEXT,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ============================================================
-- verificationTasks → verification_tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS verification_tasks (
  id TEXT PRIMARY KEY,
  priority TEXT,
  status TEXT,
  asset_id TEXT,
  timeframe TEXT,
  created_date TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS verification_tasks_priority_created_idx
  ON verification_tasks (priority, created_date DESC);
CREATE INDEX IF NOT EXISTS verification_tasks_status_priority_created_idx
  ON verification_tasks (status, priority, created_date DESC);
CREATE INDEX IF NOT EXISTS verification_tasks_status_created_idx
  ON verification_tasks (status, created_date DESC);
CREATE INDEX IF NOT EXISTS verification_tasks_asset_tf_status_idx
  ON verification_tasks (asset_id, timeframe, status);

-- ============================================================
-- tradingviewWebhookEvents → tradingview_webhook_events
-- Server-only (server/index.js, dedup do webhook) — nunca passa pela rota
-- genérica de entidades nem pelo backend.entities do browser/cron.
-- ============================================================
CREATE TABLE IF NOT EXISTS tradingview_webhook_events (
  id TEXT PRIMARY KEY, -- signal_id
  received_at TIMESTAMPTZ DEFAULT now(),
  source TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ============================================================
-- strategyConfig/current, telegramFilters/current → singletons
-- ============================================================
CREATE TABLE IF NOT EXISTS strategy_config (
  id TEXT PRIMARY KEY, -- sempre 'current'
  updated_at TIMESTAMPTZ DEFAULT now(),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS telegram_filters (
  id TEXT PRIMARY KEY, -- sempre 'current'
  updated_at TIMESTAMPTZ DEFAULT now(),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ============================================================
-- scannerLocks → scanner_locks
-- Schema pequeno e fixo (locks de scan) — sem coluna `data`, os 3 campos
-- já são o documento inteiro hoje (src/api/entities.js:
-- acquireScanLock/releaseScanLock).
-- ============================================================
CREATE TABLE IF NOT EXISTS scanner_locks (
  id TEXT PRIMARY KEY, -- lock name ('scan', 'price-check', ...)
  locked_by TEXT,
  locked_at BIGINT,   -- Date.now() ms, mesma convenção do adaptador atual
  expires_at BIGINT
);
