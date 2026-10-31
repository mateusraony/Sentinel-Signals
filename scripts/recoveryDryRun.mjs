// Replay de recuperação (docs/known-risks.md item 288) — o TESTE A SECO, como função
// testável. A CLI (scripts/run-recovery.mjs) só injeta as dependências reais (banco, API do
// GitHub, Binance) e imprime; os testes injetam falsos.
//
// O que garante que o teste a seco não grava nada no banco:
//  1. o retrato é lido por um proxy que LANÇA em qualquer escrita (readOnlyProxy);
//  2. o scanner roda contra a loja em memória (o alvo '@/api/entities' do bundle é trocado
//     por ela antes do replay);
//  3. a CLI usa DATABASE_URL_READONLY quando existe (role só com SELECT no Neon).
import { createSnapshotBackend, exportSnapshot, readOnlyProxy } from '../src/lib/recovery/snapshotBackend.js';
import {
  RecoveryAbort, resolveResumePoint, computeReplayWindow, stepForAsset, validateSeriesContinuity, TIMEFRAME_MS,
  assertLiveScanPaused, assertStrategyConfigPresent, assertRealClock, runRecoveryReplay, buildRecoveryDiff,
  buildRecoveryTags, formatRecoverySummary, fingerprint,
} from '../src/lib/recovery/recoveryReplay.js';
import { isTerminalStatus } from '../src/lib/opTransition.js';
import { preloadSeries, clearSeries, seriesFingerprint } from './recoveryMarketDataProvider.js';

// Entidades lidas inteiras. SignalEvent: só as mais recentes (a tabela cresce sem parar e o
// replay só precisa das que podem colidir com sinais da pausa — conferido por
// assertSignalsCover). SystemLog: fora (logs não decidem nada).
export const SNAPSHOT_FULL = Object.freeze(['MonitoredAsset', 'AssetState', 'TradeOperation', 'VerificationTask', 'StrategyConfig', 'TelegramFilters', 'PriceAlert']);
export const SIGNAL_SNAPSHOT_LIMIT = 5000;
export const RECOVERY_TIMEFRAMES = Object.freeze(['1d', '4h', '1h', '15m', '5m']);
/** Versão do artefato do teste a seco (o modo aplicar só aceita esta). */
export const RECOVERY_ARTIFACT_VERSION = 1;
const DAY_MS = TIMEFRAME_MS['1d'];

// Ordem canônica por id (achado do Codex no PR #523): o Postgres não garante a ordem das linhas
// sem ORDER BY, e a ordem muda a impressão digital E a ordem dos ativos no replay. Sem isto, o
// mesmo banco podia dar impressões diferentes e o modo aplicar recusaria à toa.
const byIdStable = (rows) => [...(rows || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));

export async function readSnapshot(liveBackend) {
  const ro = readOnlyProxy(liveBackend);
  const snap = await exportSnapshot(ro, SNAPSHOT_FULL);
  snap.SignalEvent = await ro.entities.SignalEvent.list('-created_date', SIGNAL_SNAPSHOT_LIMIT);
  snap.SystemLog = [];
  for (const k of Object.keys(snap)) snap[k] = byIdStable(snap[k]);
  return snap;
}

/** Os sinais lidos precisam alcançar 1 dia antes do início do replay (retry de 4h + folga). */
export function assertSignalsCover(signals, minFromMs, limit = SIGNAL_SNAPSHOT_LIMIT) {
  if (signals.length < limit) return;
  const times = signals.map((s) => Date.parse(s.created_date)).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : Infinity;
  if (!(oldest <= minFromMs - DAY_MS)) {
    throw new RecoveryAbort('snapshot_incomplete', `os ${limit} sinais mais recentes não chegam a 1 dia antes do início do replay — aumentar SIGNAL_SNAPSHOT_LIMIT`);
  }
}

export const rowsForAsset = (snap, assetId) => ({
  assetStates: snap.AssetState.filter((r) => r.asset_id === assetId),
  ops: snap.TradeOperation.filter((r) => r.asset_id === assetId),
  signals: snap.SignalEvent.filter((r) => r.asset_id === assetId),
  tasks: snap.VerificationTask.filter((r) => r.asset_id === assetId),
});

/** Ativos a recuperar e a janela de cada um (o mesmo cálculo no teste a seco e no aplicar). */
export function planRecovery(snapshot, nowMs) {
  const active = snapshot.MonitoredAsset.filter((a) => a.is_active === true);
  // Ativo esperando a checagem retroativa fica de fora: ela cuida dele quando voltar a rodar.
  const pendingBackfill = active.filter((a) => a.backfill_check_status === 'pending');
  const assets = active.filter((a) => a.backfill_check_status !== 'pending');
  if (!assets.length) throw new RecoveryAbort('no_assets', 'nenhum ativo ativo para recuperar');
  const windows = {};
  const resume = {};
  for (const a of assets) {
    const stepMs = stepForAsset(a);
    const rp = resolveResumePoint({ asset: a, rows: rowsForAsset(snapshot, a.id), stepMs, nowMs });
    resume[a.id] = rp;
    windows[a.id] = computeReplayWindow({ fromMs: rp.fromMs, nowMs, stepMs, timeframes: RECOVERY_TIMEFRAMES });
  }
  const live = Object.values(windows).filter((w) => !w.empty);
  const windowFromMs = live.length ? Math.min(...live.map((w) => w.fromMs)) : nowMs;
  const windowToMs = live.length ? Math.max(...live.map((w) => w.toMs)) : nowMs;
  return { assets, pendingBackfill, windows, resume, windowFromMs, windowToMs, outOfScopeOpen: findOutOfScopeOpenOps(snapshot, assets) };
}

/**
 * Operações ABERTAS de ativos que a recuperação não reprocessa (ativo desativado, ou esperando a
 * checagem retroativa). Elas seguem paradas até alguém cuidar — o ao vivo só olha a última vela.
 * Antes o plano as omitia em silêncio (achado da auditoria de 31/10).
 */
export function findOutOfScopeOpenOps(snapshot, assets) {
  const inScope = new Set(assets.map((a) => a.id));
  const byAsset = new Map(snapshot.MonitoredAsset.map((a) => [a.id, a]));
  return snapshot.TradeOperation
    .filter((op) => !isTerminalStatus(op.status) && !inScope.has(op.asset_id))
    .map((op) => {
      const a = byAsset.get(op.asset_id);
      const reason = !a ? 'ativo não encontrado' : a.is_active !== true ? 'ativo desativado' : 'checagem retroativa pendente';
      return { id: op.id, symbol: op.symbol ?? a?.symbol ?? '?', status: op.status, reason };
    });
}

/** Baixa e confere TODAS as velas antes do relógio simulado. Vela faltando → para tudo. */
export async function preloadAndValidate(assets, windows, fetchSeries) {
  clearSeries();
  const gaps = [];
  const warmupShort = [];
  for (const a of assets) {
    const w = windows[a.id];
    if (w.empty) continue;
    for (const tf of RECOVERY_TIMEFRAMES) {
      const range = w.fetch[tf];
      const series = await preloadSeries(a.symbol, tf, range.fromMs, range.toMs, fetchSeries);
      const check = validateSeriesContinuity(series, TIMEFRAME_MS[tf], range);
      if (check.problems.length) gaps.push(`${a.symbol} ${tf}: ${check.problems.join('; ')}`);
      if (check.warmupShort) warmupShort.push(`${a.symbol} ${tf}`);
    }
  }
  if (gaps.length) throw new RecoveryAbort('candle_gaps', `velas faltando na Binance — nada foi simulado: ${gaps.slice(0, 5).join(' | ')}`, { gaps });
  return { warmupShort };
}

/** O replay inteiro numa loja em memória semeada pelo retrato. Nada vai ao banco. */
export async function simulateInMemory({ snapshot, plan, pineConfig, entitiesTarget }) {
  const { backend, journal } = createSnapshotBackend(snapshot);
  for (const k of Object.keys(entitiesTarget)) delete entitiesTarget[k];
  Object.assign(entitiesTarget, backend);
  const perAsset = await runRecoveryReplay({ assets: plan.assets, windows: plan.windows, pineConfig });
  const after = await exportSnapshot(backend);
  return { perAsset, after, journal, diff: buildRecoveryDiff(snapshot, after) };
}

/**
 * @param {{ liveBackend: object, workflows: object[], entitiesTarget: object, getPineConfig: Function,
 *   getPineConfigStatus: Function, nowMs: number, runId: string, fetchSeries?: Function }} deps
 */
export async function runDryRun({ liveBackend, workflows, entitiesTarget, getPineConfig, getPineConfigStatus, nowMs, runId, fetchSeries }) {
  assertRealClock('o teste a seco');
  assertLiveScanPaused(workflows);

  const snapshot = await readSnapshot(liveBackend);
  const configRow = snapshot.StrategyConfig.find((r) => r.id === 'current') ?? null;
  const pineConfig = await getPineConfig();
  assertStrategyConfigPresent({ row: configRow, status: getPineConfigStatus() });

  const plan = planRecovery(snapshot, nowMs);
  assertSignalsCover(snapshot.SignalEvent, plan.windowFromMs);
  const { warmupShort } = await preloadAndValidate(plan.assets, plan.windows, fetchSeries);

  const sim = await simulateInMemory({ snapshot, plan, pineConfig, entitiesTarget });
  const tags = buildRecoveryTags({ diff: sim.diff, runId, detectedAtMs: nowMs });
  const fingerprints = {
    snapshot: fingerprint(snapshot),
    candles: seriesFingerprint(plan.windowToMs),
    config: fingerprint(configRow),
    journal: fingerprint(sim.journal),
  };
  return {
    version: RECOVERY_ARTIFACT_VERSION, ok: true, mode: 'dry-run', runId, nowMs, windowFromMs: plan.windowFromMs, windowToMs: plan.windowToMs,
    assets: sim.perAsset, windows: plan.windows, resume: plan.resume,
    pendingBackfill: plan.pendingBackfill.map((a) => a.symbol),
    outOfScopeOpen: plan.outOfScopeOpen,
    smcAssets: plan.assets.filter((a) => a.smc_enabled).map((a) => a.symbol),
    warmupShort, diff: sim.diff, tags, fingerprints, journal: sim.journal,
    summary: formatRecoverySummary({ diff: sim.diff, windowFromMs: plan.windowFromMs, windowToMs: plan.windowToMs, mode: 'teste a seco' }),
  };
}

const BRT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const brt = (ms) => (Number.isFinite(ms) ? BRT.format(new Date(ms)).replace(',', '') : '—');
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');

/** Relatório do teste a seco em português (Job Summary). */
export function formatDryRunMarkdown(result) {
  const L = [];
  L.push('## Recuperação após pausa do banco — TESTE A SECO');
  L.push('');
  L.push('**Nada foi gravado no banco.** Isto é a simulação do que a recuperação faria.');
  L.push('');
  L.push('| Ativo | Último processamento | Reprocessa de | até | Passos |');
  L.push('|---|---|---|---|---:|');
  for (const a of result.assets) {
    if (a.skipped) { L.push(`| ${cell(a.symbol)} | — | nada a reprocessar | — | 0 |`); continue; }
    L.push(`| ${cell(a.symbol)} | ${brt(result.resume[a.assetId]?.lastProcessedMs)} | ${brt(a.fromMs)} | ${brt(a.toMs)} | ${a.ticks} |`);
  }
  L.push('');
  L.push('```');
  L.push(result.summary);
  L.push('```');
  const warn = [];
  if (result.pendingBackfill.length) warn.push(`Ficaram de fora (esperando a checagem retroativa): ${result.pendingBackfill.join(', ')}`);
  if (result.outOfScopeOpen?.length) warn.push(`Operações ABERTAS que a recuperação NÃO reprocessa (continuam paradas até alguém cuidar): ${result.outOfScopeOpen.map((o) => `${o.symbol} ${o.status} (${o.reason})`).join(', ')}`);
  if (result.smcAssets.length) warn.push(`Ativos com a cascata SMC (passo de 5 min): ${result.smcAssets.join(', ')}`);
  if (result.warmupShort.length) warn.push(`Histórico mais curto que o aquecimento pedido (ativo novo na corretora — o ao vivo também teria menos velas): ${result.warmupShort.join(', ')}`);
  if (warn.length) { L.push(''); L.push('**Avisos:**'); for (const w of warn) L.push(`- ${w}`); }
  L.push('');
  L.push(`Impressões digitais (o modo aplicar confere que nada mudou): retrato \`${result.fingerprints.snapshot}\` · velas \`${result.fingerprints.candles}\` · configuração \`${result.fingerprints.config}\` · resultado \`${result.fingerprints.journal}\``);
  L.push('');
  L.push(`**Para aplicar depois de ler este relatório:** o número desta execução é \`${result.runId}\`.`);
  return L.join('\n');
}

/** Relatório quando o teste a seco PARA (qualquer trava ou erro). */
export function formatAbortMarkdown(err) {
  const L = ['## Recuperação após pausa do banco — TESTE A SECO PAROU', ''];
  L.push(`**Motivo:** ${err?.message ?? String(err)}`);
  if (err?.code) L.push(`Código: \`${err.code}\``);
  L.push('');
  L.push('Nada foi gravado no banco. Corrija o motivo acima e rode de novo.');
  return L.join('\n');
}
