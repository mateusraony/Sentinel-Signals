// Replay de recuperação depois de uma queda longa do banco (docs/known-risks.md
// item 288). O ao vivo só olha a ÚLTIMA vela fechada: depois de dias parado ele
// fecharia operações no preço de hoje (Time Stop pelo relógio, scanner.js
// barsOpen = Date.now() − entrada), não veria stop/alvo tocados no meio da pausa
// e nunca criaria os sinais da pausa. Este módulo reexecuta o MESMO motor
// (scanAsset/persistScanResults, via runBacktest e o relógio simulado) vela a
// vela sobre a pausa, começando logo DEPOIS do último processamento de cada ativo.
//
// Nada aqui muda scanner.js nem backtestEngine.js, e nada aqui cria um 3º
// caminho de mutação de operação: o motor escreve pelos caminhos de sempre
// (createTradeOpIfNoneActive / transitionTradeOp). O teste a seco roda contra a
// loja em memória (snapshotBackend.js); o modo aplicar roda contra o banco real.
import { runBacktest, sliceClosedAsOf } from '../backtestEngine.js';

export const STEP_RF_MS = 15 * 60 * 1000;
export const STEP_SMC_MS = 5 * 60 * 1000;
export const MAX_GAP_DAYS = 30;

export const TIMEFRAME_MS = Object.freeze({
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
});

// Maior quantidade de velas que o scanner pede por timeframe (scanner.js:69,135-145:
// 1h 500, 4h 150 ou 500 com stop estrutural, 1d 150; 15m/5m nas confirmações).
// O aquecimento baixa isto + 50 velas ANTES do início do replay.
export const LIVE_FETCH_LIMITS = Object.freeze({ '1d': 150, '4h': 500, '1h': 500, '15m': 300, '5m': 300 });
const WARMUP_EXTRA_CANDLES = 50;

/** Erro de recuperação que o orquestrador mostra em português e que SEMPRE para tudo. */
export class RecoveryAbort extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RecoveryAbort';
    this.code = code;
    this.details = details;
  }
}

// Capturado no carregamento do módulo, antes de qualquer installSimClock.
const REAL_DATE = globalThis.Date;

/** Lock e escrita de cursor só com o relógio REAL (o lock usa Date.now() — sob relógio simulado nasceria vencido). */
export function assertRealClock(what = 'esta operação') {
  if (globalThis.Date !== REAL_DATE) {
    throw new RecoveryAbort('sim_clock_active', `${what} não pode rodar com o relógio simulado ligado`);
  }
}

const TS_KEY = /(_at|_date|_time)$/;
const parseMs = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

/** Maior carimbo de tempo (campos *_at / *_date / *_time) de um conjunto de linhas. */
export function latestTimestamp(rows) {
  let best = null;
  for (const row of rows || []) {
    for (const [k, v] of Object.entries(row || {})) {
      if (!TS_KEY.test(k)) continue;
      const ms = parseMs(v);
      if (ms != null && (best == null || ms > best)) best = ms;
    }
  }
  return best;
}

export function stepForAsset(asset) {
  return asset?.smc_enabled ? STEP_SMC_MS : STEP_RF_MS;
}

/**
 * Onde o replay de um ativo começa. É o PRIMEIRO passo estritamente depois do último
 * processamento do MOTOR: o maior entre `last_scan_at` (gravado por toda passada do scan,
 * cron ou navegador) e `recovery_replayed_to` (gravado pela própria recuperação).
 * Começar ANTES disso é perigoso: reprocessar uma vela anterior ao último avanço de
 * stop pode gerar um STOP falso (a guarda do scanner é por igualdade de vela).
 *
 * Só marcadores do MOTOR contam (achado do Codex no PR #522): um carimbo escrito pelo
 * painel — ex. `reviewed_at` de uma tarefa revisada depois da volta do banco — empurraria
 * o início para depois da pausa e o replay pularia stops/alvos/sinais EM SILÊNCIO. Escritas
 * do price-check logo depois do último scan também não empurram: o replay repete a mesma
 * vela que o próximo scan ao vivo repetiria (mesmo comportamento do ao vivo).
 * `rows` fica só para o relatório (último carimbo visto em cada tipo de linha).
 * @param {{ asset: object, rows?: { assetStates?: object[], ops?: object[], signals?: object[], tasks?: object[] },
 *   stepMs?: number, nowMs: number, maxGapDays?: number }} params
 * @returns {{ fromMs: number, lastProcessedMs: number, latestRowWrite: number | null }}
 */
export function resolveResumePoint({ asset, rows = {}, stepMs = stepForAsset(asset), nowMs, maxGapDays = MAX_GAP_DAYS }) {
  if (!Number.isFinite(nowMs)) throw new RecoveryAbort('bad_input', 'resolveResumePoint: nowMs obrigatório');
  const candidates = [
    parseMs(asset?.last_scan_at),
    parseMs(asset?.recovery_replayed_to),
  ].filter((v) => v != null);
  if (!candidates.length) {
    throw new RecoveryAbort('no_resume_point', `${asset?.symbol ?? asset?.id}: sem nenhum registro de último processamento`);
  }
  const lastProcessedMs = Math.max(...candidates);
  if (lastProcessedMs > nowMs) {
    throw new RecoveryAbort('future_timestamp', `${asset?.symbol ?? asset?.id}: carimbo de tempo no futuro (${new Date(lastProcessedMs).toISOString()})`);
  }
  const gapDays = (nowMs - lastProcessedMs) / TIMEFRAME_MS['1d'];
  if (gapDays > maxGapDays) {
    throw new RecoveryAbort('gap_too_long', `${asset?.symbol ?? asset?.id}: pausa de ${gapDays.toFixed(1)} dias (limite ${maxGapDays})`);
  }
  const fromMs = (Math.floor(lastProcessedMs / stepMs) + 1) * stepMs;
  const latestRowWrite = latestTimestamp([...(rows.ops || []), ...(rows.signals || []), ...(rows.tasks || []), ...(rows.assetStates || [])]);
  return { fromMs, lastProcessedMs, latestRowWrite };
}

/**
 * Janela do replay e do aquecimento. `toMs` = último passo inteiro já fechado.
 * O aquecimento de cada timeframe começa (limite + 50) velas antes de `fromMs`.
 */
export function computeReplayWindow({ fromMs, nowMs, stepMs, timeframes = Object.keys(LIVE_FETCH_LIMITS) }) {
  const toMs = Math.floor(nowMs / stepMs) * stepMs;
  const fetch = {};
  for (const tf of timeframes) {
    const interval = TIMEFRAME_MS[tf];
    const limit = LIVE_FETCH_LIMITS[tf];
    if (!interval || !limit) throw new RecoveryAbort('bad_input', `timeframe desconhecido: ${tf}`);
    fetch[tf] = { fromMs: fromMs - (limit + WARMUP_EXTRA_CANDLES) * interval, toMs };
  }
  const empty = toMs < fromMs;
  return { fromMs, toMs, stepMs, empty, ticks: empty ? 0 : Math.floor((toMs - fromMs) / stepMs) + 1, fetch };
}

/**
 * Velas como o AO VIVO vê (docs/known-risks.md item 287): o ao vivo pede `limit` velas e a
 * última vem aberta, então calcula com `limit − 1` fechadas. sliceClosedAsOf daria `limit`.
 */
export function sliceLikeLive(series, asOfMs, limit) {
  if (limit == null) return sliceClosedAsOf(series, asOfMs);
  if (limit <= 1) return [];
  return sliceClosedAsOf(series, asOfMs, limit - 1);
}

/**
 * Confere uma série baixada: sem buraco entre velas e chegando até `toMs`.
 * Aquecimento menor que o pedido (ativo novo na corretora) NÃO é erro — o ao vivo
 * também teria menos velas — só é informado.
 * @returns {{ problems: string[], warmupShort: boolean }}
 */
export function validateSeriesContinuity(series, intervalMs, { fromMs, toMs }) {
  const problems = [];
  if (!Array.isArray(series) || series.length === 0) return { problems: ['nenhuma vela'], warmupShort: true };
  for (let i = 1; i < series.length; i += 1) {
    const diff = series[i].openTime - series[i - 1].openTime;
    if (diff !== intervalMs) {
      problems.push(`buraco entre ${new Date(series[i - 1].openTime).toISOString()} e ${new Date(series[i].openTime).toISOString()}`);
      if (problems.length >= 5) break;
    }
  }
  const lastEnd = series[series.length - 1].openTime + intervalMs;
  const needEnd = Math.floor(toMs / intervalMs) * intervalMs;
  if (lastEnd < needEnd) problems.push(`série termina em ${new Date(lastEnd).toISOString()}, antes de ${new Date(needEnd).toISOString()}`);
  return { problems, warmupShort: series[0].openTime > fromMs };
}

const DISABLED_STATES = new Set(['disabled_manually', 'disabled_inactivity']);
export const WORKFLOWS_THAT_MUST_BE_PAUSED = Object.freeze(['.github/workflows/scan.yml', '.github/workflows/backfill.yml']);

/** O scan ao vivo e a checagem retroativa PRECISAM estar desligados (o replay não pode concorrer com eles). */
export function assertLiveScanPaused(workflows, required = WORKFLOWS_THAT_MUST_BE_PAUSED) {
  const byPath = new Map((workflows || []).map((w) => [w.path, w.state]));
  const active = required.filter((p) => !DISABLED_STATES.has(byPath.get(p)));
  if (active.length) {
    throw new RecoveryAbort('live_scan_active', `desative antes no GitHub (Actions → workflow → "…" → Disable workflow): ${active.join(', ')}`, { active });
  }
}

/**
 * Sem StrategyConfig o scanner cai nos valores padrão SEM avisar (adminPineConfig.js) — nunca recuperar assim.
 * @param {{ row?: object | null, status?: { degraded?: boolean } | null }} [params]
 */
export function assertStrategyConfigPresent({ row, status } = {}) {
  if (!row) throw new RecoveryAbort('strategy_config_missing', 'StrategyConfig "current" não existe no banco — o replay usaria valores padrão');
  if (status?.degraded) throw new RecoveryAbort('strategy_config_degraded', 'configuração da estratégia em modo degradado — o replay não cria operação assim');
}

// runBacktest só usa o `backend` recebido para LER todas as operações no fim (relatório).
// O replay não usa esse relatório; o stub evita varrer a tabela inteira de produção.
const REPORT_BACKEND_STUB = Object.freeze({ entities: { TradeOperation: { filter: async () => [] } } });

// runBacktest exige toMs > fromMs, mas uma pausa curta pode deixar UM passo só (fromMs === toMs).
// O laço é `for (t = fromMs; t <= toMs; t += step)`: com toMs + 1 ms ele roda exatamente o passo
// fromMs e nada mais (o passo seguinte já passa de toMs + 1).
export function runBacktestTo(window) {
  return window.toMs > window.fromMs ? window.toMs : window.fromMs + 1;
}

/**
 * Roda o replay ativo por ativo (um runBacktest por ativo, cada um com a sua janela).
 * Para tudo na primeira falha de integridade (falha de busca/erro de scan no meio do replay).
 * `onAsset`/`onAssetDone` rodam FORA do relógio simulado (antes/depois de cada runBacktest) —
 * é onde o modo aplicar renova o lock e grava o cursor do ativo.
 * @param {{ assets: object[], windows: Record<string, object>, pineConfig?: object, onAsset?: Function, onAssetDone?: Function, runBacktestImpl?: Function }} opts
 */
export async function runRecoveryReplay({ assets, windows, pineConfig = {}, onAsset, onAssetDone, runBacktestImpl = runBacktest }) {
  const results = [];
  for (const asset of assets) {
    const w = windows?.[asset.id];
    if (!w || w.empty) {
      results.push({ assetId: asset.id, symbol: asset.symbol, skipped: true });
      continue;
    }
    if (onAsset) await onAsset(asset, w);
    const report = await runBacktestImpl({
      assets: [asset], backend: REPORT_BACKEND_STUB, fromMs: w.fromMs, toMs: runBacktestTo(w), stepMs: w.stepMs, pineConfig,
    });
    const integrity = report?.dataIntegrity;
    if (integrity && integrity.valid === false) {
      throw new RecoveryAbort('replay_integrity', `${asset.symbol}: o replay teve falha de busca ou erro de scan — nada deve ser aplicado`, { assetId: asset.id, integrity });
    }
    const done = { assetId: asset.id, symbol: asset.symbol, fromMs: w.fromMs, toMs: w.toMs, ticks: w.ticks, integrity: integrity ?? null };
    results.push(done);
    if (onAssetDone) await onAssetDone(asset, w, done);
  }
  return results;
}

const stableStringify = (v) => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
};

/** Impressão digital estável (FNV-1a 32 bits) — compara teste a seco × aplicar sem depender da ordem das chaves. */
export function fingerprint(value) {
  const s = stableStringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function diffRows(before = [], after = []) {
  const prev = new Map(before.map((r) => [r.id, r]));
  const created = [];
  const changed = [];
  for (const row of after) {
    const old = prev.get(row.id);
    if (!old) { created.push(row); continue; }
    const keys = [...new Set([...Object.keys(old), ...Object.keys(row)])]
      .filter((k) => stableStringify(old[k]) !== stableStringify(row[k])).sort();
    if (keys.length) changed.push({ id: row.id, before: old, after: row, changedKeys: keys });
  }
  const removed = before.filter((r) => !after.some((a) => a.id === r.id)).map((r) => r.id);
  return { created, changed, removed };
}

/** O que o replay mudou, entre o retrato de antes e o estado de depois. */
const OPEN_STATUSES = ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'];

export function buildRecoveryDiff(before, after) {
  return {
    // `openAfter`: TODAS as operações abertas depois do replay (inclusive as que ele não mexeu)
    // — o resumo fala da exposição real, não só do que mudou (achado do Codex no PR #522).
    ops: { ...diffRows(before.TradeOperation, after.TradeOperation), openAfter: (after.TradeOperation || []).filter((op) => OPEN_STATUSES.includes(op.status)) },
    signals: diffRows(before.SignalEvent, after.SignalEvent),
    tasks: diffRows(before.VerificationTask, after.VerificationTask),
  };
}

// Metadado de procedência — NUNCA status, stop, preço (lista fechada, como o backfill).
export const RECOVERY_TAG_KEYS = Object.freeze([
  'source', 'recovery_original_source', 'recovery_run_id', 'recovery_detected_at', 'recovery_entry_lag_ms',
]);

export function assertTagPatch(patch) {
  const extra = Object.keys(patch || {}).filter((k) => !RECOVERY_TAG_KEYS.includes(k));
  if (extra.length) throw new RecoveryAbort('tag_not_allowed', `etiqueta de recuperação com campo proibido: ${extra.join(', ')}`);
  return patch;
}

const entryRefMs = (op) => parseMs(op.entry_candle_time_15m) ?? parseMs(op.entry_candle_time_5m) ?? parseMs(op.candle_close_time) ?? parseMs(op.created_date);

/**
 * Etiquetas (só metadado) para as operações que o replay criou ou mexeu.
 * Novas: source 'recovery' (ficam fora das estatísticas ao vivo, decisão do usuário 29/10).
 * Antigas tocadas: só o id da recuperação (continuam contando como sempre).
 */
export function buildRecoveryTags({ diff, runId, detectedAtMs }) {
  const detectedIso = new Date(detectedAtMs).toISOString();
  const tags = [];
  for (const op of diff.ops.created) {
    const ref = entryRefMs(op);
    tags.push({ id: op.id, patch: assertTagPatch({
      source: 'recovery',
      recovery_original_source: op.source ?? null,
      recovery_run_id: runId,
      recovery_detected_at: detectedIso,
      recovery_entry_lag_ms: ref != null ? detectedAtMs - ref : null,
    }) });
  }
  for (const ch of diff.ops.changed) tags.push({ id: ch.id, patch: assertTagPatch({ recovery_run_id: runId }) });
  return tags;
}

const BRT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const brt = (msOrIso) => {
  const ms = parseMs(msOrIso);
  return ms == null ? '—' : BRT.format(new Date(ms)).replace(',', '');
};
const realTimeOf = (op) => op.stop_hit_real_time || op.tp2_hit_real_time || op.closed_at_real_time || op.tp1_hit_real_time || null;

/** Resumo em português simples (relatório do teste a seco e a única mensagem do Telegram). */
export function formatRecoverySummary({ diff, windowFromMs, windowToMs, mode = 'teste a seco' }) {
  const lines = [];
  lines.push(`Recuperação após pausa do banco (${mode})`);
  lines.push(`Período reprocessado: ${brt(windowFromMs)} a ${brt(windowToMs)} (horário de Brasília)`);
  const novas = diff.ops.created;
  const fechadas = diff.ops.changed.filter((c) => c.before.status !== c.after.status);
  const abertas = diff.ops.openAfter ?? [];
  lines.push(`Operações novas (deveriam ter aberto na pausa): ${novas.length}`);
  for (const op of novas) lines.push(`• ${op.symbol} ${op.side} — entrada ${op.entry_price} em ${brt(op.created_date)} — agora: ${op.status}`);
  lines.push(`Operações antigas que mudaram de estado: ${fechadas.length}`);
  for (const c of fechadas) lines.push(`• ${c.after.symbol} ${c.before.status} → ${c.after.status}${c.after.exit_price != null ? ` a ${c.after.exit_price}` : ''}${realTimeOf(c.after) ? ` (vela de ${brt(realTimeOf(c.after))})` : ''}`);
  lines.push(`Operações abertas depois da recuperação (todas, mexidas ou não): ${abertas.length}`);
  lines.push(`Sinais novos: ${diff.signals.created.length}`);
  return lines.join('\n');
}
