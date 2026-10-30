// Replay de recuperação (docs/known-risks.md item 288) — o modo APLICAR, como função testável.
// É a ÚNICA parte da recuperação que grava no banco real. Ordem das travas (qualquer uma para
// tudo ANTES de gravar):
//   1. aprovação: o número digitado pelo usuário é o do teste a seco do artefato, e ele é recente;
//   2. "Scheduled scan" e "Backfill check" desativados;
//   3. o banco é o MESMO que o teste a seco viu (impressão digital do retrato);
//   4. a configuração da estratégia é a MESMA;
//   5. as velas da janela aprovada são as MESMAS;
//   6. política estrita (decisão do usuário, 29/10): refaz a simulação em memória até AGORA e,
//      se aparecer operação nova, mudança de estado ou sinal que o teste a seco não mostrou, para
//      e pede um novo teste a seco;
//   7. pega os locks "full-scan" e "price-check" (só com o relógio REAL).
// Depois: grava pelo MESMO motor (createTradeOpIfNoneActive / transitionTradeOp — nenhum 3º
// caminho de mutação), relê o banco e compara com a simulação, etiqueta (só metadado) e manda
// UMA mensagem no Telegram (sucesso ou falha). O backup do banco roda ANTES, no workflow.
import { createSnapshotBackend } from '../src/lib/recovery/snapshotBackend.js';
import {
  RecoveryAbort, assertRealClock, assertLiveScanPaused, assertStrategyConfigPresent, runRecoveryReplay,
  buildRecoveryDiff, buildRecoveryTags, formatRecoverySummary, fingerprint,
} from '../src/lib/recovery/recoveryReplay.js';
import { readSnapshot, planRecovery, preloadAndValidate, simulateInMemory, assertSignalsCover, RECOVERY_ARTIFACT_VERSION } from './recoveryDryRun.mjs';
import { seriesFingerprint } from './recoveryMarketDataProvider.js';

export const APPLY_LOCK_TTL_MS = 40 * 60 * 1000;
export const MAX_APPROVAL_AGE_MS = 24 * 60 * 60 * 1000;
export const LOCK_NAMES = Object.freeze(['full-scan', 'price-check']);
const SCAN_STATUS_KEYS = new Set(['last_scan_at', 'scan_status', 'scan_error', 'scan_error_since']);
const WRITE_METHODS = ['create', 'createUnique', 'update', 'delete', 'set', 'bulkCreate', 'deleteMany'];
const iso = (ms) => new Date(ms).toISOString();
const byId = (rows) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));

/** O que conta para a política estrita: operação nova, mudança de estado e sinal novo. */
export function diffEvents(diff) {
  const ev = [];
  for (const op of diff.ops.created) ev.push(`operação nova ${op.id} (${op.status})`);
  for (const c of diff.ops.changed) if (c.before.status !== c.after.status) ev.push(`${c.id}: ${c.before.status} → ${c.after.status}`);
  for (const s of diff.signals.created) ev.push(`sinal novo ${s.id}`);
  return ev.sort();
}

/**
 * Backend do modo aplicar: banco REAL para tudo, exceto AssetState (em memória, semeado pelo
 * retrato — igual ao teste a seco e à checagem retroativa) e os campos de status do scan no
 * MonitoredAsset (o replay não é um scan ao vivo). O diário registra o que foi gravado.
 */
export function createApplyBackend(real, snapshot) {
  const { backend: mem } = createSnapshotBackend({ AssetState: snapshot.AssetState || [] });
  const journal = [];
  const entities = {};
  for (const [name, api] of Object.entries(real.entities)) {
    if (name === 'AssetState') { entities[name] = mem.entities.AssetState; continue; }
    const wrapped = {};
    for (const m of Object.keys(api)) if (typeof api[m] === 'function') wrapped[m] = (...a) => api[m](...a);
    for (const m of WRITE_METHODS) {
      if (typeof api[m] !== 'function') continue;
      wrapped[m] = async (...a) => {
        if (name === 'MonitoredAsset' && m === 'update' && Object.keys(a[1] || {}).every((k) => SCAN_STATUS_KEYS.has(k))) {
          return { id: a[0], ...a[1] };
        }
        const out = await api[m](...a);
        if (name !== 'SystemLog') journal.push({ entity: name, op: m, id: typeof a[0] === 'string' ? a[0] : null });
        return out;
      };
    }
    entities[name] = wrapped;
  }
  const tradeOps = {
    async createTradeOpIfNoneActive(...a) {
      const out = await real.tradeOps.createTradeOpIfNoneActive(...a);
      if (out?.created) journal.push({ entity: 'TradeOperation', op: 'create', id: a[1] });
      return out;
    },
    clearActiveOp: (...a) => real.tradeOps.clearActiveOp(...a),
    async transitionTradeOp(...a) {
      const out = await real.tradeOps.transitionTradeOp(...a);
      if (out?.applied) journal.push({ entity: 'TradeOperation', op: 'transition', id: a[0], to: a[2]?.status ?? null });
      return out;
    },
  };
  return { backend: { entities, tradeOps, assetStates: mem.assetStates, locks: real.locks, quota: real.quota }, journal };
}

function assertApproval({ approved, approvedRunId, nowMs }) {
  if (!approved || approved.version !== RECOVERY_ARTIFACT_VERSION || approved.mode !== 'dry-run' || approved.ok !== true) {
    throw new RecoveryAbort('approval_invalid', 'o resultado do teste a seco aprovado não foi encontrado ou está incompleto');
  }
  if (!/^\d+$/.test(String(approvedRunId ?? '')) || String(approved.runId) !== String(approvedRunId)) {
    throw new RecoveryAbort('approval_mismatch', `o número digitado (${approvedRunId}) não é o do teste a seco baixado (${approved.runId})`);
  }
  if (nowMs - approved.nowMs > MAX_APPROVAL_AGE_MS) {
    throw new RecoveryAbort('approval_too_old', 'o teste a seco tem mais de 24 h — rode um novo e aplique logo depois de ler');
  }
}

async function acquireLocks(locks, holder) {
  const got = [];
  for (const name of LOCK_NAMES) {
    assertRealClock('pegar o lock');
    const ok = await locks.acquireScanLock(name, APPLY_LOCK_TTL_MS, holder);
    if (!ok) {
      await releaseLocks(locks, holder, got);
      throw new RecoveryAbort('lock_busy', `o lock "${name}" está com outro processo (scan ao vivo ou painel aberto?) — nada foi gravado`);
    }
    got.push(name);
  }
  return got;
}

async function releaseLocks(locks, holder, names) {
  for (const name of names) {
    try { await locks.releaseScanLock(name, holder); } catch { /* o TTL libera sozinho */ }
  }
}

async function applyInner(deps, state) {
  const { liveBackend, workflows, entitiesTarget, getPineConfig, getPineConfigStatus, nowMs, runId, approved, approvedRunId, fetchSeries } = deps;
  assertRealClock('aplicar a recuperação');
  assertApproval({ approved, approvedRunId, nowMs });
  assertLiveScanPaused(workflows);

  const snapshot = await readSnapshot(liveBackend);
  if (fingerprint(snapshot) !== approved.fingerprints.snapshot) {
    throw new RecoveryAbort('snapshot_changed', 'o banco mudou desde o teste a seco (alguém mexeu ou o scan rodou) — rode um novo teste a seco');
  }
  const configRow = snapshot.StrategyConfig.find((r) => r.id === 'current') ?? null;
  const pineConfig = await getPineConfig();
  assertStrategyConfigPresent({ row: configRow, status: getPineConfigStatus() });
  if (fingerprint(configRow) !== approved.fingerprints.config) {
    throw new RecoveryAbort('config_changed', 'a configuração da estratégia mudou desde o teste a seco — rode um novo teste a seco');
  }

  const plan = planRecovery(snapshot, nowMs);
  for (const a of plan.assets) {
    if (plan.windows[a.id].fromMs !== approved.windows?.[a.id]?.fromMs) {
      throw new RecoveryAbort('plan_changed', `${a.symbol}: o início do replay não é o do teste a seco — rode um novo teste a seco`);
    }
  }
  assertSignalsCover(snapshot.SignalEvent, plan.windowFromMs);
  await preloadAndValidate(plan.assets, plan.windows, fetchSeries);
  if (seriesFingerprint(approved.windowToMs) !== approved.fingerprints.candles) {
    throw new RecoveryAbort('candles_changed', 'as velas da janela aprovada vieram diferentes da Binance — rode um novo teste a seco');
  }

  // Política estrita: a simulação até AGORA tem que mostrar exatamente os mesmos eventos.
  const sim = await simulateInMemory({ snapshot, plan, pineConfig, entitiesTarget });
  const seen = diffEvents(approved.diff);
  const now = diffEvents(sim.diff);
  if (fingerprint(now) !== fingerprint(seen)) {
    const novos = now.filter((e) => !seen.includes(e));
    const sumiram = seen.filter((e) => !now.includes(e));
    throw new RecoveryAbort('tail_changed', `aconteceu algo que o teste a seco não mostrou — rode um novo teste a seco. Novo: ${novos.join('; ') || '—'}. Não aconteceu mais: ${sumiram.join('; ') || '—'}`, { novos, sumiram });
  }

  const holder = `recovery_${runId}`;
  const locks = liveBackend.locks;
  const held = await acquireLocks(locks, holder);
  try {
    const apply = createApplyBackend(liveBackend, snapshot);
    for (const k of Object.keys(entitiesTarget)) delete entitiesTarget[k];
    Object.assign(entitiesTarget, apply.backend);
    state.wrote = true;
    const perAsset = await runRecoveryReplay({
      assets: plan.assets, windows: plan.windows, pineConfig,
      onAsset: async () => {
        assertRealClock('renovar o lock');
        for (const name of held) {
          if (!(await locks.acquireScanLock(name, APPLY_LOCK_TTL_MS, holder))) throw new RecoveryAbort('lock_lost', `o lock "${name}" foi perdido no meio da aplicação`);
        }
      },
      // Cursor por ativo: uma nova recuperação começa DEPOIS do que já foi aplicado.
      onAssetDone: async (asset, w) => {
        assertRealClock('gravar o cursor');
        await liveBackend.entities.MonitoredAsset.update(asset.id, { recovery_replayed_to: iso(w.toMs), recovery_run_id: runId });
      },
    });

    // Conferência: o banco real tem que ter ficado igual à simulação em memória.
    const afterReal = await readSnapshot(liveBackend);
    const opsReal = byId(afterReal.TradeOperation);
    const opsSim = byId(sim.after.TradeOperation);
    const touchedSignals = new Set([...sim.diff.signals.created, ...sim.diff.signals.changed.map((c) => c.after)].map((s) => s.id));
    const sigReal = byId(afterReal.SignalEvent.filter((s) => touchedSignals.has(s.id)));
    const sigSim = byId(sim.after.SignalEvent.filter((s) => touchedSignals.has(s.id)));
    if (fingerprint(opsReal) !== fingerprint(opsSim) || fingerprint(sigReal) !== fingerprint(sigSim)) {
      const realById = new Map(opsReal.map((o) => [o.id, o]));
      const diverge = opsSim.filter((o) => fingerprint(o) !== fingerprint(realById.get(o.id) ?? null)).map((o) => o.id);
      throw new RecoveryAbort('verify_mismatch', `o banco ficou diferente da simulação em ${diverge.length} operação(ões): ${diverge.slice(0, 5).join(', ')}`, { diverge });
    }

    const diffReal = buildRecoveryDiff(snapshot, afterReal);
    const tags = buildRecoveryTags({ diff: diffReal, runId, detectedAtMs: nowMs });
    for (const t of tags) await liveBackend.entities.TradeOperation.update(t.id, t.patch);

    return {
      ok: true, mode: 'apply', runId, approvedRunId: String(approvedRunId), nowMs,
      windowFromMs: plan.windowFromMs, windowToMs: plan.windowToMs, assets: perAsset,
      diff: diffReal, tags, journal: apply.journal,
      before: snapshot.TradeOperation.filter((o) => diffReal.ops.changed.some((c) => c.id === o.id)),
      summary: formatRecoverySummary({ diff: diffReal, windowFromMs: plan.windowFromMs, windowToMs: plan.windowToMs, mode: 'APLICADO no banco' }),
    };
  } finally {
    await releaseLocks(locks, holder, held);
  }
}

/** Texto da falha para o relatório e para a única mensagem do Telegram. */
export function formatApplyFailure(err, wrote) {
  if (!wrote) {
    return `Recuperação NÃO aplicada — nada foi gravado no banco.\nMotivo: ${err?.message ?? String(err)}`;
  }
  return [
    'ATENÇÃO: a recuperação parou NO MEIO — parte já foi gravada no banco.',
    `Motivo: ${err?.message ?? String(err)}`,
    'NÃO rode de novo e NÃO religue o scan. O backup feito logo antes está no repositório privado de backups.',
  ].join('\n');
}

/**
 * @param {{ liveBackend: object, workflows: object[], entitiesTarget: object, getPineConfig: Function,
 *   getPineConfigStatus: Function, nowMs: number, runId: string, approved: object, approvedRunId: string,
 *   fetchSeries?: Function, sendSummary: (text: string) => Promise<boolean> }} deps
 */
export async function runApply(deps) {
  const state = { wrote: false };
  let outcome;
  try {
    outcome = await applyInner(deps, state);
  } catch (error) {
    outcome = { ok: false, mode: 'apply', error, code: error?.code ?? null, wrote: state.wrote, summary: formatApplyFailure(error, state.wrote) };
  }
  try {
    outcome.telegramSent = await deps.sendSummary(outcome.summary);
  } catch {
    outcome.telegramSent = false;
  }
  return outcome;
}

const BRT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const brt = (ms) => (Number.isFinite(ms) ? BRT.format(new Date(ms)).replace(',', '') : '—');

/** Relatório do modo aplicar (Job Summary). */
export function formatApplyMarkdown(outcome) {
  const L = [];
  if (!outcome.ok) {
    L.push(outcome.wrote ? '## Recuperação — PAROU NO MEIO' : '## Recuperação — NÃO APLICADA');
    L.push('');
    L.push('```');
    L.push(outcome.summary);
    L.push('```');
    if (outcome.code) L.push(`Código: \`${outcome.code}\``);
    return L.join('\n');
  }
  L.push('## Recuperação — APLICADA no banco');
  L.push('');
  L.push(`Teste a seco aprovado: \`${outcome.approvedRunId}\` · período ${brt(outcome.windowFromMs)} a ${brt(outcome.windowToMs)} (Brasília)`);
  L.push('');
  L.push('```');
  L.push(outcome.summary);
  L.push('```');
  L.push('');
  L.push(`Mensagem no Telegram: ${outcome.telegramSent ? 'enviada' : 'NÃO enviada (confira os segredos do Telegram)'}`);
  L.push('');
  L.push('**Próximo passo:** religar o "Scheduled scan" e o cron-job.org (a cada 15 min), nesta ordem, logo depois — o roteiro está em `docs/claude/recovery-runbook.md`.');
  return L.join('\n');
}
