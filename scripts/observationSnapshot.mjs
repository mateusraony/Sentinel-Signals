// Modo de observação sem banco, fase O1 (docs/known-risks.md item 299): o RETRATO do estado que o vigia da O2 lê quando o Postgres está fora do ar.
//
// Módulo PURO (sem import, travado por scripts/observationTripwire.test.js): só decide O QUE entra no retrato, o que é recusado e o tamanho.
// Quem lê o banco é scripts/observationPublish.mjs; quem grava no Realtime Database é scripts/observationStore.mjs.
//
// Por que uma LISTA FECHADA de campos: o retrato guarda entrada, stop e alvos de operações REAIS num nó do RTDB que só o Admin SDK alcança.
// Copiar "a linha inteira" levaria junto campos que o vigia não usa (anotações, snapshot de decisão, qualquer campo futuro) e aumentaria o que
// fica exposto se um dia uma regra do RTDB for aberta por engano. Só valores primitivos curtos passam; objeto, vetor e Date ficam de fora.

export const SNAPSHOT_VERSION = 1;

/** As duas situações de uma operação que ainda precisa de vigia. As terminais (STOP_HIT, TP2_HIT, INVALIDATED, CLOSED) nunca entram. */
export const LIVE_STATUSES = Object.freeze(['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE']);

/** Campos de `TradeOperation` que a O2 usa para decidir stop e alvo (mesmos nomes que `priceCheckActiveOpsInner` lê em src/lib/scanner.js). */
export const OPERATION_FIELDS = Object.freeze([
  'id', 'asset_id', 'symbol', 'side', 'status', 'cascade', 'hierarchical_cascade',
  'entry_price', 'initial_stop', 'current_stop', 'tp1', 'tp2', 'tp1_hit', 'tp2_hit', 'tp1_hit_at',
  'partial_percent', 'tp2_cap_disabled', 'exit_mode', 'market_source', 'signal_timeframe', 'timeframe',
  'entry_candle_time_15m', 'entry_candle_time_5m', 'entry_candle_time_4h', 'candle_close_time', 'created_date',
]);

/** Campos de `MonitoredAsset` que o vigia usa (só identificar o ativo). */
export const ASSET_FIELDS = Object.freeze(['id', 'symbol', 'display_name', 'is_active']);

/** Teto de operações vivas: acima disso o retrato é RECUSADO (cortar deixaria o vigia cego sem avisar). */
export const MAX_OPERATIONS = 100;
/** Teto do retrato inteiro, em bytes do JSON. O RTDB grátis tem 1 GB, mas um retrato só cresce por erro. */
export const MAX_SNAPSHOT_BYTES = 200_000;

const MAX_TEXT = 100;
const SCAN_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SIDES = Object.freeze(['BUY', 'SELL']);
const CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;

/** Valor primitivo seguro: texto (cortado), número finito (senão null), booleano ou null. Qualquer outra coisa não passa. */
function primitive(v) {
  if (v === null) return { ok: true, value: null };
  if (typeof v === 'string') return { ok: true, value: v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v };
  if (typeof v === 'number') return { ok: true, value: Number.isFinite(v) ? v : null };
  if (typeof v === 'boolean') return { ok: true, value: v };
  return { ok: false };
}

/** Copia só os campos da lista que existem na linha e têm valor primitivo. Nunca altera a linha. */
export function pickFields(row, fields) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  for (const campo of fields) {
    if (!Object.prototype.hasOwnProperty.call(row, campo)) continue;
    const p = primitive(row[campo]);
    if (p.ok) out[campo] = p.value;
  }
  return out;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isText = (v) => typeof v === 'string' && v.length > 0;

/** A operação tem o mínimo para o vigia decidir? (identificação, lado e os preços de entrada, stop e 1º alvo; 2º alvo ou a trava dele.) */
function isUsableOperation(o) {
  return isText(o.id) && isText(o.symbol) && SIDES.includes(o.side) && LIVE_STATUSES.includes(o.status)
    && isNum(o.entry_price) && isNum(o.current_stop) && isNum(o.tp1)
    && (isNum(o.tp2) || o.tp2_cap_disabled === true);
}

function pickTelegramFilters(filters) {
  if (!filters || typeof filters !== 'object' || !Array.isArray(filters.sources)) return null;
  const sources = filters.sources.filter((s) => typeof s === 'string' && s.length > 0 && s.length <= 30).slice(0, 20);
  return sources.length > 0 ? { sources } : null;
}

/**
 * Monta o retrato. Nunca lança: entrada ruim vira `{ ok: false, reason }`.
 * @param {{ operations: object[], assets: object[], telegramFilters?: object|null, nowMs: number, scanId?: string|null }} entrada
 * @returns {{ ok: true, snapshot: object, bytes: number } | { ok: false, reason: string }}
 */
export function buildSnapshot({ operations, assets, telegramFilters = null, nowMs, scanId = null } = {}) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return { ok: false, reason: 'relogio_invalido' };
  if (!Array.isArray(operations) || !Array.isArray(assets)) return { ok: false, reason: 'entrada_invalida' };

  const vivas = operations.filter((o) => o && typeof o === 'object' && LIVE_STATUSES.includes(o.status));
  if (vivas.length > MAX_OPERATIONS) return { ok: false, reason: 'muitas_operacoes' };

  const operacoes = [];
  let descartadas = 0;
  for (const bruta of vivas) {
    const o = pickFields(bruta, OPERATION_FIELDS);
    if (isUsableOperation(o)) operacoes.push(o);
    else descartadas += 1; // viva mas sem o mínimo: nunca some em silêncio, a O2 avisa que há operação fora do retrato
  }

  const ativos = assets
    .map((a) => pickFields(a, ASSET_FIELDS))
    .filter((a) => isText(a.id) && isText(a.symbol));

  const snapshot = {
    version: SNAPSHOT_VERSION,
    snapshot_at: new Date(nowMs).toISOString(),
    scan_id: typeof scanId === 'string' && SCAN_ID_RE.test(scanId) ? scanId : null,
    counts: { operations: operacoes.length, assets: ativos.length },
    dropped_operations: descartadas,
    telegram_filters: pickTelegramFilters(telegramFilters),
    operations: operacoes,
    assets: ativos,
  };

  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
  if (bytes > MAX_SNAPSHOT_BYTES) return { ok: false, reason: 'retrato_grande_demais' };
  return { ok: true, snapshot, bytes };
}

/** O erro é o de prazo estourado de `withTimeout` (scripts/scanTimeout.mjs)? */
export function isTimeoutError(err) {
  return /^Timeout:/.test(String(err?.message ?? ''));
}

/**
 * Rótulo SEGURO de uma falha, para o log (PÚBLICO) e para o resultado: o código do erro, ou o nome, ou "timeout"; nunca a mensagem
 * (a de um erro do Postgres ou do Firebase pode trazer endereço, URL do projeto e até credencial).
 */
export function safeErrorCode(err) {
  if (isTimeoutError(err)) return 'timeout';
  if (typeof err?.code === 'string' && CODE_RE.test(err.code)) return err.code;
  if (typeof err?.name === 'string' && CODE_RE.test(err.name)) return err.name;
  return 'erro_desconhecido';
}

/** Deixa passar só um código curto e seguro; qualquer outra coisa vira "erro_desconhecido". */
export function safeCode(value) {
  return typeof value === 'string' && CODE_RE.test(value) ? value : 'erro_desconhecido';
}
