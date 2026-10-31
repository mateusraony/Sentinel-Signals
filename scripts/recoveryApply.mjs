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
  buildRecoveryDiff, buildRecoveryTags, formatRecoverySummary, fingerprint, clipSummaryForTelegram,
} from '../src/lib/recovery/recoveryReplay.js';
import { readSnapshot, planRecovery, preloadAndValidate, simulateInMemory, assertSignalsCover, RECOVERY_ARTIFACT_VERSION } from './recoveryDryRun.mjs';
import { seriesFingerprint } from './recoveryMarketDataProvider.js';

export const APPLY_LOCK_TTL_MS = 40 * 60 * 1000;
export const MAX_APPROVAL_AGE_MS = 24 * 60 * 60 * 1000;
export const LOCK_NAMES = Object.freeze(['full-scan', 'price-check']);
/** Prazo para o envio do resumo ao Telegram (um fetch sem prazo travaria o fim do job). */
export const SUMMARY_SEND_TIMEOUT_MS = 60 * 1000;
/** Margem do prazo por ativo: o próximo só começa se o MAIOR tempo de ativo já medido (x1,5) ainda cabe. */
const ASSET_TIME_MARGIN = 1.5;
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
  // Tentativas de escrita (antes da chamada): se uma escrita falhar na rede o efeito é ambíguo,
  // e o lado seguro é dizer "parou no meio". Escrita de SystemLog (log) não conta.
  const stats = { attempted: 0 };
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
        if (name !== 'SystemLog') stats.attempted += 1;
        const out = await api[m](...a);
        if (name !== 'SystemLog') journal.push({ entity: name, op: m, id: typeof a[0] === 'string' ? a[0] : null });
        return out;
      };
    }
    entities[name] = wrapped;
  }
  const tradeOps = {
    async createTradeOpIfNoneActive(...a) {
      stats.attempted += 1;
      const out = await real.tradeOps.createTradeOpIfNoneActive(...a);
      if (out?.created) journal.push({ entity: 'TradeOperation', op: 'create', id: a[1] });
      return out;
    },
    clearActiveOp: (...a) => real.tradeOps.clearActiveOp(...a),
    async transitionTradeOp(...a) {
      stats.attempted += 1;
      const out = await real.tradeOps.transitionTradeOp(...a);
      if (out?.applied) journal.push({ entity: 'TradeOperation', op: 'transition', id: a[0], to: a[2]?.status ?? null });
      return out;
    },
  };
  return { backend: { entities, tradeOps, assetStates: mem.assetStates, locks: real.locks, quota: real.quota }, journal, stats };
}

/** Linhas por id: usa `get` (Postgres) quando existe; senão uma leitura completa e filtra. */
export async function fetchByIds(api, ids) {
  if (!ids.length) return [];
  if (typeof api.get === 'function') {
    const rows = [];
    for (const id of ids) {
      const row = await api.get(id);
      if (row) rows.push(row);
    }
    return rows;
  }
  const wanted = new Set(ids);
  return (await api.list()).filter((r) => wanted.has(r.id));
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
  try {
    for (const name of LOCK_NAMES) {
      assertRealClock('pegar o lock');
      const ok = await locks.acquireScanLock(name, APPLY_LOCK_TTL_MS, holder);
      if (!ok) {
        await releaseLocks(locks, holder, got);
        throw new RecoveryAbort('lock_busy', `o lock "${name}" está com outro processo (scan ao vivo ou painel aberto?) — nada foi gravado`);
      }
      got.push(name);
    }
  } catch (error) {
    // Erro de rede na 2ª trava deixava a 1ª presa por 40 min (achado da auditoria de 31/10). Solta
    // todas (soltar o que não é nosso é inofensivo: a liberação confere o dono).
    if (!(error instanceof RecoveryAbort)) await releaseLocks(locks, holder, LOCK_NAMES);
    throw error;
  }
  return got;
}

async function releaseLocks(locks, holder, names) {
  for (const name of names) {
    try { await locks.releaseScanLock(name, holder); } catch { /* o TTL libera sozinho */ }
  }
}

const BRT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const brt = (ms) => (Number.isFinite(ms) ? BRT.format(new Date(ms)).replace(',', '') : '—');

/** Linha de aviso das operações abertas que ficaram FORA da recuperação (ativo desativado / checagem pendente). */
export function formatOutOfScopeLine(list) {
  if (!list?.length) return null;
  const shown = list.slice(0, 8).map((o) => `${o.symbol} ${o.status} (${o.reason})`).join(', ');
  const more = list.length > 8 ? ` e mais ${list.length - 8}` : '';
  return `ATENÇÃO — ${list.length} operação(ões) ABERTA(S) ficaram FORA da recuperação e continuam paradas: ${shown}${more}.`;
}

/** Ids das duas pontas que divergem (lista da simulação + lista do banco real), sem repetir. */
function divergentIds(simRows, realRows) {
  const simById = new Map(simRows.map((r) => [r.id, r]));
  const realById = new Map(realRows.map((r) => [r.id, r]));
  const ids = new Set([...simById.keys(), ...realById.keys()]);
  return [...ids].filter((id) => fingerprint(simById.get(id) ?? null) !== fingerprint(realById.get(id) ?? null)).sort();
}

async function applyInner(deps, state) {
  const { liveBackend, workflows, workflowsError, entitiesTarget, getPineConfig, getPineConfigStatus, nowMs, runId, approved, approvedRunId, fetchSeries } = deps;
  const clock = deps.clock ?? Date.now;
  const deadlineMs = Number.isFinite(deps.deadlineMs) ? deps.deadlineMs : Infinity;
  assertRealClock('aplicar a recuperação');
  assertApproval({ approved, approvedRunId, nowMs });
  // Falha ao LER o estado dos workflows não é "o scan está ligado": mensagem própria (antes virava
  // "desative o scan" com ele já desligado — achado da auditoria de 31/10).
  if (workflowsError) {
    throw new RecoveryAbort('github_api', `não consegui conferir se o "Scheduled scan" e o "Backfill check" estão desativados (${workflowsError}) — nada foi gravado; rode de novo`);
  }
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
    // Reconfere o banco JÁ COM os locks (achado do Codex no PR #524): entre a 1ª conferência e a
    // tomada dos locks, um scan do navegador podia mudar o banco e soltar o lock — sem isto a
    // aplicação gravaria sobre um estado não aprovado e só perceberia DEPOIS de gravar.
    if (fingerprint(await readSnapshot(liveBackend)) !== approved.fingerprints.snapshot) {
      throw new RecoveryAbort('snapshot_changed', 'o banco mudou enquanto a recuperação se preparava (scan ou painel aberto?) — nada foi gravado; rode um novo teste a seco');
    }
    const apply = createApplyBackend(liveBackend, snapshot);
    for (const k of Object.keys(entitiesTarget)) delete entitiesTarget[k];
    Object.assign(entitiesTarget, apply.backend);
    // "Gravou" = alguma escrita foi TENTADA (diário do backend) ou o cursor foi escrito. Antes era
    // marcado aqui, antes de qualquer escrita, e uma falha logo no início dizia "parou no meio".
    state.stats = apply.stats;
    let startedMs = null;
    let longestAssetMs = 0;
    const perAsset = await runRecoveryReplay({
      assets: plan.assets, windows: plan.windows, pineConfig,
      // Prazo: só começa outro ativo se o maior tempo de ativo já medido (x1,5) ainda cabe.
      shouldStop: () => clock() + longestAssetMs * ASSET_TIME_MARGIN > deadlineMs,
      onAsset: async (asset) => {
        assertRealClock('renovar o lock');
        state.inFlight = asset.symbol;
        startedMs = clock();
        for (const name of held) {
          if (!(await locks.acquireScanLock(name, APPLY_LOCK_TTL_MS, holder))) throw new RecoveryAbort('lock_lost', `o lock "${name}" foi perdido no meio da aplicação`);
        }
      },
      // Cursor por ativo: uma nova recuperação começa DEPOIS do que já foi aplicado.
      onAssetDone: async (asset, w) => {
        assertRealClock('gravar o cursor');
        state.cursorWritten = true;
        await liveBackend.entities.MonitoredAsset.update(asset.id, { recovery_replayed_to: iso(w.toMs), recovery_run_id: runId });
        longestAssetMs = Math.max(longestAssetMs, clock() - startedMs);
        state.inFlight = null;
      },
    });

    const pendingIds = new Set(perAsset.filter((r) => r.pending).map((r) => r.assetId));
    const partial = pendingIds.size > 0;
    const pendingSymbols = perAsset.filter((r) => r.pending).map((r) => r.symbol);
    const symbolToId = new Map(plan.assets.map((a) => [a.symbol, a.id]));
    const assetOf = (row) => row.asset_id ?? symbolToId.get(row.symbol);
    // Parcial: só os ativos concluídos entram na conferência (os pendentes ainda não foram tocados).
    const inScope = (row) => !partial || !pendingIds.has(assetOf(row));

    // Conferência: o banco real tem que ter ficado igual à simulação em memória.
    const afterReal = await readSnapshot(liveBackend);
    const opsReal = byId(afterReal.TradeOperation.filter(inScope));
    const opsSim = byId(sim.after.TradeOperation.filter(inScope));
    // Sinais tocados lidos PELO ID (achado do Codex no PR #524): o retrato só traz os 5.000 mais
    // recentes, e um sinal tocado fora dessa janela viraria uma falsa "parou no meio".
    const touchedSignals = new Set([...sim.diff.signals.created, ...sim.diff.signals.changed.map((c) => c.after)].filter(inScope).map((s) => s.id));
    const sigReal = byId(await fetchByIds(liveBackend.entities.SignalEvent, [...touchedSignals]));
    const sigSim = byId(sim.after.SignalEvent.filter((s) => touchedSignals.has(s.id)));
    if (fingerprint(opsReal) !== fingerprint(opsSim) || fingerprint(sigReal) !== fingerprint(sigSim)) {
      // As duas pontas: operação/sinal que existe só no banco real também conta (antes só se olhava a simulação).
      const diverge = divergentIds(opsSim, opsReal);
      const divergeSignals = divergentIds(sigSim, sigReal);
      const parts = [];
      if (diverge.length) parts.push(`${diverge.length} operação(ões): ${diverge.slice(0, 5).join(', ')}`);
      if (divergeSignals.length) parts.push(`${divergeSignals.length} sinal(is): ${divergeSignals.slice(0, 5).join(', ')}`);
      throw new RecoveryAbort('verify_mismatch', `o banco ficou diferente da simulação em ${parts.join(' e ') || 'um ponto não identificado'}`, { diverge, divergeSignals });
    }

    const diffReal = buildRecoveryDiff(snapshot, afterReal);
    const tags = buildRecoveryTags({ diff: diffReal, runId, detectedAtMs: nowMs });
    // Banco gravado E conferido; se só a etiqueta falhar, o aviso é outro (os dados estão certos).
    const tagFailures = [];
    for (const t of tags) {
      try { await liveBackend.entities.TradeOperation.update(t.id, t.patch); } catch (e) { tagFailures.push(`${t.id}: ${e?.message ?? e}`); }
    }
    if (tagFailures.length) {
      throw new RecoveryAbort('tag_failed', `a etiqueta "Recuperada" falhou em ${tagFailures.length} de ${tags.length} operação(ões): ${tagFailures.slice(0, 3).join(' | ')}`, { tagFailures });
    }

    const outOfScopeOpen = plan.outOfScopeOpen;
    const lines = [];
    if (partial) {
      lines.push(`PARCIAL: o tempo da aplicação estava acabando, então ela parou ENTRE ativos. Concluídos: ${perAsset.filter((r) => !r.pending && !r.skipped).length}. Faltam (não foram tocados): ${pendingSymbols.join(', ')}.`);
      lines.push('Para os que faltam: rode um NOVO teste a seco (ele recomeça de onde cada ativo parou), leia, e aplique de novo. NÃO religue o scan antes.');
      lines.push('');
    }
    lines.push(formatRecoverySummary({ diff: diffReal, windowFromMs: plan.windowFromMs, windowToMs: plan.windowToMs, mode: partial ? 'APLICADO PARCIALMENTE no banco' : 'APLICADO no banco' }));
    const outLine = formatOutOfScopeLine(outOfScopeOpen);
    if (outLine) lines.push(outLine);

    return {
      ok: true, mode: 'apply', runId, approvedRunId: String(approvedRunId), nowMs, partial, pending: pendingSymbols,
      windowFromMs: plan.windowFromMs, windowToMs: plan.windowToMs, assets: perAsset, outOfScopeOpen,
      diff: diffReal, tags, journal: apply.journal,
      before: snapshot.TradeOperation.filter((o) => diffReal.ops.changed.some((c) => c.id === o.id)),
      summary: lines.join('\n'),
    };
  } finally {
    await releaseLocks(locks, holder, held);
  }
}

const wroteSomething = (state) => Boolean(state.cursorWritten || (state.stats?.attempted ?? 0) > 0);

/** Texto da falha para o relatório e para a única mensagem do Telegram. */
export function formatApplyFailure(err, wrote) {
  const msg = err?.message ?? String(err);
  if (err?.code === 'tag_failed') {
    return [
      'A recuperação foi GRAVADA e CONFERIDA (o banco bate com a simulação), mas a etiqueta "Recuperada" falhou em parte das operações.',
      `Motivo: ${msg}`,
      'Os dados estão certos. NÃO rode de novo e NÃO religue o scan: sem a etiqueta, as operações recuperadas entrariam nas estatísticas ao vivo. Chame o Claude para só etiquetar.',
    ].join('\n');
  }
  if (err?.code === 'apply_timeout') {
    if (!wrote) return `Recuperação NÃO aplicada — o tempo esgotou ANTES de gravar qualquer coisa.\nMotivo: ${msg}\nNada foi gravado. Rode um novo teste a seco.`;
    return [
      'ATENÇÃO: o TEMPO ESGOTOU no meio da aplicação — parte já foi gravada no banco.',
      `Motivo: ${msg}`,
      'NÃO rode de novo e NÃO religue o scan. Chame o Claude. As travas (locks) se soltam sozinhas em até 40 min. O backup feito logo antes está no repositório privado de backups.',
    ].join('\n');
  }
  if (!wrote) {
    return `Recuperação NÃO aplicada — nada foi gravado no banco.\nMotivo: ${msg}`;
  }
  return [
    'ATENÇÃO: a recuperação parou NO MEIO — parte já foi gravada no banco.',
    `Motivo: ${msg}`,
    'NÃO rode de novo e NÃO religue o scan. O backup feito logo antes está no repositório privado de backups.',
  ].join('\n');
}

function raceTimeout(promise, ms, makeError) {
  promise.catch(() => {}); // a promessa perdedora não pode virar rejeição sem dono
  if (!Number.isFinite(ms)) return promise;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(makeError()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {{ liveBackend: object, workflows: object[], workflowsError?: string, entitiesTarget: object, getPineConfig: Function,
 *   getPineConfigStatus: Function, nowMs: number, runId: string, approved: object, approvedRunId: string,
 *   fetchSeries?: Function, sendSummary: (text: string) => Promise<boolean>,
 *   timeoutMs?: number, deadlineMs?: number, clock?: () => number }} deps
 *   `deadlineMs`: instante em que NÃO se começa outro ativo (parada limpa). `timeoutMs`: tempo máximo
 *   da aplicação inteira (parada dura, com mensagem e relatório).
 */
export async function runApply(deps) {
  const state = { cursorWritten: false, stats: null, inFlight: null };
  const clock = deps.clock ?? Date.now;
  const startedMs = clock();
  let outcome;
  try {
    outcome = await raceTimeout(applyInner(deps, state), deps.timeoutMs, () => {
      const min = Math.round((clock() - startedMs) / 60000);
      const where = state.inFlight ? ` durante o ativo ${state.inFlight}` : '';
      return Object.assign(new Error(`a aplicação passou do tempo máximo (${min} min)${where}`), { code: 'apply_timeout' });
    });
  } catch (error) {
    const wrote = wroteSomething(state);
    outcome = { ok: false, mode: 'apply', error, code: error?.code ?? null, wrote, summary: formatApplyFailure(error, wrote) };
  }
  try {
    outcome.telegramSent = await raceTimeout(
      Promise.resolve().then(() => deps.sendSummary(clipSummaryForTelegram(outcome.summary))),
      SUMMARY_SEND_TIMEOUT_MS, () => new Error('envio ao Telegram passou do prazo'),
    );
  } catch {
    outcome.telegramSent = false;
  }
  return outcome;
}

/** Título e "próximo passo" do relatório, conforme o resultado. */
function failureTitle(outcome) {
  if (outcome.code === 'tag_failed') return '## Recuperação — GRAVADA E CONFERIDA, FALTA ETIQUETAR';
  if (outcome.code === 'apply_timeout') return outcome.wrote ? '## Recuperação — TEMPO ESGOTADO NO MEIO' : '## Recuperação — NÃO APLICADA (tempo esgotado)';
  return outcome.wrote ? '## Recuperação — PAROU NO MEIO' : '## Recuperação — NÃO APLICADA';
}

/** Relatório do modo aplicar (Job Summary). */
export function formatApplyMarkdown(outcome) {
  const L = [];
  if (!outcome.ok) {
    L.push(failureTitle(outcome));
    L.push('');
    L.push('```');
    L.push(outcome.summary);
    L.push('```');
    if (outcome.code) L.push(`Código: \`${outcome.code}\``);
    L.push('');
    L.push(`Mensagem no Telegram: ${telegramLine(outcome)}`);
    return L.join('\n');
  }
  L.push(outcome.partial ? '## Recuperação — APLICADA PARCIALMENTE' : '## Recuperação — APLICADA no banco');
  L.push('');
  L.push(`Teste a seco aprovado: \`${outcome.approvedRunId}\` · período ${brt(outcome.windowFromMs)} a ${brt(outcome.windowToMs)} (Brasília)`);
  L.push('');
  L.push('```');
  L.push(outcome.summary);
  L.push('```');
  L.push('');
  L.push(`Mensagem no Telegram: ${telegramLine(outcome)}`);
  L.push('');
  if (outcome.partial) {
    L.push(`**Próximo passo:** NÃO religue o scan ainda. Faltam: ${outcome.pending.join(', ')}. Rode um novo teste a seco, leia, e aplique de novo — o roteiro está em \`docs/claude/recovery-runbook.md\`.`);
  } else {
    L.push('**Próximo passo — religar logo, nesta ordem:** (1) o workflow "Scheduled scan", (2) o job do cron-job.org (a cada 15 min), (3) o workflow "Backfill check". As velas entre o fim desta aplicação e o 1º scan ao vivo não são reprocessadas, então não deixe passar horas. Roteiro: `docs/claude/recovery-runbook.md`.');
  }
  return L.join('\n');
}

function telegramLine(outcome) {
  return outcome.telegramSent
    ? 'enviada'
    : 'NÃO enviada (o envio falhou: segredos do Telegram ausentes, rede ou recusa do Telegram — veja o log do passo "Aplicar a recuperação"; o resumo completo está acima)';
}
