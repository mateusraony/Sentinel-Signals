// Modo de observação sem banco, fase O1 (docs/known-risks.md item 299): grava o retrato do estado ao fim de cada scan.
//
// O que garante o "sem efeito sem a URL": a PRIMEIRA coisa que a função faz é conferir OBSERVATION_DATABASE_URL; vazia, devolve `sem_url` sem
// tocar no banco (nem uma consulta a mais ao Postgres) e sem inicializar o Firebase. Com a URL, faz 2 leituras pequenas ao fim da passada:
// as operações VIVAS (a mesma consulta que o price-check já faz) e os filtros do Telegram.
//
// NUNCA lança e nunca devolve texto de erro: o scan não pode cair por causa do retrato, e o log do Actions é público (só contagem e código).
import { buildSnapshot, LIVE_STATUSES, safeErrorCode, safeCode } from './observationSnapshot.mjs';
import { createObservationStore } from './observationStore.mjs';
import { withTimeout } from './scanTimeout.mjs';

const DEFAULT_READ_TIMEOUT_MS = 20_000;

/**
 * @param {{ env?: Record<string, string|undefined>, backend?: object, store?: object, assets?: object[], nowMs?: number, scanId?: string|null, readTimeoutMs?: number }} [dep]
 * @returns {Promise<{ ok: boolean, skipped?: string, reason?: string, erro?: string, operations?: number, assets?: number, dropped?: number, bytes?: number }>}
 */
export async function publishObservationSnapshot({
  env = process.env, backend, store, assets = [], nowMs = Date.now(), scanId = null, readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
} = {}) {
  try {
    const url = typeof env?.OBSERVATION_DATABASE_URL === 'string' ? env.OBSERVATION_DATABASE_URL.trim() : '';
    if (!url) return { ok: false, skipped: 'sem_url' };

    // Sem as operações não há retrato: um retrato SEM operações, quando elas existem, faria o vigia da O2 achar que não há nada a vigiar.
    const operations = await withTimeout(
      backend.entities.TradeOperation.filter({ status: [...LIVE_STATUSES] }), readTimeoutMs, 'observationReadOps',
    );

    // Os filtros do Telegram são opcionais: sem eles a O2 avisa tudo, como o cron já faz quando não consegue lê-los.
    let telegramFilters = null;
    try {
      telegramFilters = await withTimeout(backend.entities.TelegramFilters.get('current'), readTimeoutMs, 'observationReadFilters');
    } catch {
      telegramFilters = null;
    }

    const built = buildSnapshot({ operations, assets, telegramFilters, nowMs, scanId });
    if (!built.ok) return { ok: false, reason: built.reason };

    const destino = store ?? createObservationStore({ env });
    const gravado = await destino.write(built.snapshot);
    if (!gravado?.ok) return { ok: false, skipped: gravado?.skipped, erro: gravado?.erro };

    return {
      ok: true,
      operations: built.snapshot.counts.operations,
      assets: built.snapshot.counts.assets,
      dropped: built.snapshot.dropped_operations,
      bytes: built.bytes,
    };
  } catch (err) {
    return { ok: false, erro: safeErrorCode(err) };
  }
}

/** A linha do log do scan (PÚBLICO): só contagem e código curto. */
export function describePublishResult(r) {
  if (r?.ok) {
    const kb = (Number(r.bytes ?? 0) / 1024).toFixed(1).replace('.', ',');
    const descartadas = r.dropped > 0 ? ` descartadas=${r.dropped}` : '';
    return `[scan] retrato: gravado · ops=${r.operations} ativos=${r.assets}${descartadas} · ${kb} KB`;
  }
  if (r?.skipped === 'sem_url') return '[scan] retrato: desligado (sem URL do RTDB)';
  if (r?.skipped === 'banco_com_falha') return '[scan] retrato: não gravado (banco com falha nesta passada)';
  if (r?.reason) return `[scan] retrato: não gravado (${safeCode(r.reason)})`;
  return `[scan] retrato: não gravado (${safeCode(r?.erro ?? r?.skipped)})`;
}
