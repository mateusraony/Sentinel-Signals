import { assetHealthcheckReason } from './assetHealthcheck.js';

/**
 * Frescor do dado de um ativo — fonte única (item 277, PR-B) para o cartão,
 * o drawer, a lista de Ativos e o chip de saúde global. Usa o mesmo
 * healthcheck do cron (`assetHealthcheckReason`, tolerância de 30 min).
 *
 * Antes o cartão mostrava "LIVE" verde sempre que o healthcheck não acusava
 * problema — inclusive num ativo nunca lido (sem `last_scan_at`), que o
 * healthcheck trata como saudável. Aqui "ok" exige uma leitura de verdade.
 *
 * `now` é obrigatório: sem relógio válido o status é "unknown" (fail-closed).
 *
 * @returns {{ status: 'ok'|'stale'|'error'|'inactive'|'unknown',
 *   reason: 'persistent_error'|'silent'|null, ageMin: number|null }}
 */
export function assetDataQuality(asset, now) {
  const nowMs = Number.isFinite(now) ? now : null;
  const lastScanMs = asset?.last_scan_at ? new Date(asset.last_scan_at).getTime() : NaN;
  const hasScan = Number.isFinite(lastScanMs);
  const reason = asset && nowMs !== null ? assetHealthcheckReason(asset, { now: nowMs }) : null;
  const ageMin = nowMs !== null && hasScan ? Math.max(0, Math.floor((nowMs - lastScanMs) / 60000)) : null;

  /** @type {'ok'|'stale'|'error'|'inactive'|'unknown'} */
  let status = 'unknown';
  if (asset?.is_active === false) status = 'inactive';
  else if (reason === 'persistent_error') status = 'error';
  else if (reason === 'silent') status = 'stale';
  // Falha recente (dentro da tolerância de 30 min do healthcheck): o motor
  // renova `last_scan_at` mesmo quando a leitura falha, então "ok" aqui diria
  // "atualizado" sobre um dado que não veio (revisão do PR-B). O alerta do
  // Telegram continua esperando os 30 min — isto é só o que a tela mostra.
  else if (asset?.scan_status === 'error' || asset?.scan_error_since) status = 'error';
  else if (nowMs !== null && hasScan) status = 'ok';

  return { status, reason, ageMin };
}

/** Idade legível: "5 min", "3 h", "14 dias" (nunca "20160 min"). */
export function formatAge(ageMin) {
  if (ageMin < 60) return `${ageMin} min`;
  if (ageMin < 48 * 60) return `${Math.floor(ageMin / 60)} h`;
  return `${Math.floor(ageMin / (24 * 60))} dias`;
}

const lastScanText = (q) => (q.ageMin > 0 ? `último scan há ${formatAge(q.ageMin)}` : 'último scan agora');

const BADGE = Object.freeze({
  ok: { color: '#00ff80', label: (q) => (q.ageMin > 0 ? `Atualizado há ${formatAge(q.ageMin)}` : 'Atualizado agora'), short: (q) => (q.ageMin > 0 ? `há ${formatAge(q.ageMin)}` : 'agora') },
  stale: { color: '#ff9f43', label: (q) => (Number.isFinite(q.ageMin) ? `Atrasado (${formatAge(q.ageMin)} sem leitura)` : 'Atrasado'), short: () => 'Atrasado' },
  error: { color: '#ef4444', label: (q) => (Number.isFinite(q.ageMin) ? `Falha de leitura (${lastScanText(q)})` : 'Falha de leitura'), short: () => 'Falha' },
  inactive: { color: '#64748b', label: (q) => (Number.isFinite(q.ageMin) ? `Desligado (${lastScanText(q)})` : 'Desligado'), short: () => 'Desligado' },
  unknown: { color: '#64748b', label: () => 'Sem leitura', short: () => 'Sem leitura' },
});

/** Rótulo 📡 (longo e curto) + cor para um resultado de `assetDataQuality`. */
export function qualityBadge(quality) {
  const q = quality ?? { status: 'unknown', ageMin: null };
  const meta = BADGE[q.status] ?? BADGE.unknown;
  return { label: `📡 ${meta.label(q)}`, short: `📡 ${meta.short(q)}`, color: meta.color };
}

const PROBLEM_STATUSES = new Set(['stale', 'error', 'unknown']);

/**
 * Resumo do frescor dos ativos LIGADOS para o chip de saúde global (item 277,
 * no lugar do "Dados em tempo real" fixo do Dashboard e do ping fixo da
 * Sidebar). "Com problema" = atrasado, com falha ou nunca lido.
 */
export function summarizeDataHealth(assets, now) {
  const active = (assets ?? []).filter(a => a && a.is_active !== false);
  if (active.length === 0) return { status: 'empty', activeCount: 0, problemCount: 0, lastScanAgeMin: null };
  let problemCount = 0;
  let lastScanAgeMin = null;
  for (const a of active) {
    const q = assetDataQuality(a, now);
    if (PROBLEM_STATUSES.has(q.status)) problemCount++;
    if (q.ageMin !== null && (lastScanAgeMin === null || q.ageMin < lastScanAgeMin)) lastScanAgeMin = q.ageMin;
  }
  return { status: problemCount === 0 ? 'ok' : 'warn', activeCount: active.length, problemCount, lastScanAgeMin };
}

const CHIP_COLOR = Object.freeze({ ok: '#00ff80', warn: '#ff9f43', neutral: '#64748b' });

/** Texto + cor do chip. Carregando/erro nunca dizem "tudo em dia". */
export function healthChip(summary, { loading = false, error = false } = {}) {
  if (error) return { label: '📡 Saúde indisponível', color: CHIP_COLOR.neutral };
  if (loading || !summary) return { label: '📡 Verificando…', color: CHIP_COLOR.neutral };
  if (summary.status === 'empty') return { label: '📡 Nenhum ativo ligado', color: CHIP_COLOR.neutral };
  const age = summary.lastScanAgeMin;
  const when = age === null ? 'Sem leitura ainda' : age === 0 ? 'Último scan agora' : `Último scan há ${formatAge(age)}`;
  const tail = summary.problemCount === 0
    ? 'tudo em dia'
    : `${summary.problemCount} ${summary.problemCount === 1 ? 'ativo' : 'ativos'} com problema`;
  return { label: `📡 ${when} · ${tail}`, color: summary.status === 'ok' ? CHIP_COLOR.ok : CHIP_COLOR.warn };
}
