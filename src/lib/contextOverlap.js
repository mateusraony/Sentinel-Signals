// Contexto de Mercado — Fase 5 (docs/known-risks.md item 285): "essa operação ficou aberta durante um evento macro?".
//
// Módulo PURO (sem rede, sem banco, sem relógio global: `nowMs` entra por parâmetro). Nada aqui toca o motor: o motor
// nunca importa este arquivo (travado por scripts/contextIsolationTripwire.test.js) — a relação é só de leitura sobre
// operações que já existem. É CORRELAÇÃO, nunca causa: "estava aberta quando saiu o CPI" não diz que o CPI mexeu no resultado.
//
// Janela da operação: [quando a posição passou a existir, quando fechou]. Operação ainda ativa vai até `nowMs`.
// Evento = { kind, startsAtMs } (instante UTC da divulgação, em milissegundos). Evento exatamente na borda conta (fechado nos dois lados).
import { getOpenedAt, getClosedAt, isClosedOp } from './tradeMetrics.js';

/** Os 3 tipos de ALTA importância (o marcador só usa estes). PPI e PCE são importância média. */
export const HIGH_IMPORTANCE_KINDS = Object.freeze(['CPI', 'NFP', 'FOMC']);
export const ALL_KINDS = Object.freeze(['CPI', 'NFP', 'PPI', 'PCE', 'FOMC']);

/** Tolerante: string ISO, número (ms) ou Date. Qualquer coisa que não dê uma data real vira null (nunca NaN, nunca 0). */
export function toMs(value) {
  if (value == null || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * A janela [startMs, endMs] da operação. `null` se não dá para saber o INÍCIO (sem início não há janela: não se inventa).
 * Operação terminal sem horário de fecho legível → `null` (não se chuta que ficou aberta até agora); ativa → termina em `nowMs`.
 */
export function opWindow(op, nowMs) {
  if (!op) return null;
  const startMs = toMs(getOpenedAt(op));
  if (startMs == null) return null;
  let endMs;
  if (isClosedOp(op)) {
    endMs = toMs(op.closed_at_real_time) ?? toMs(getClosedAt(op));
    if (endMs == null) return null;
  } else {
    endMs = toMs(nowMs);
    if (endMs == null) return null;
  }
  if (endMs < startMs) return null; // relógio/ordem estranha: some, não vira janela negativa
  return { startMs, endMs };
}

/** Os eventos (dos tipos pedidos) cujo instante cai dentro da janela, em ordem de data. */
export function eventsDuring(window, events, { kinds = HIGH_IMPORTANCE_KINDS } = {}) {
  if (!window || !Array.isArray(events)) return [];
  const allowed = new Set(kinds);
  return events
    .filter((e) => e && allowed.has(e.kind) && Number.isFinite(e.startsAtMs) && e.startsAtMs >= window.startMs && e.startsAtMs <= window.endMs)
    .sort((a, b) => a.startsAtMs - b.startsAtMs);
}

/**
 * A medição do portão da Fase 5: de todas as operações COBERTAS pelo histórico de eventos, quantas ficaram abertas durante algum evento.
 * Cobertura: o histórico de eventos só vai até `coverageStartMs` para trás; operação que abriu antes disso não entra na conta
 * (senão contaria "sem evento" onde só faltava dado). Operação sem janela legível fica de fora e é contada à parte (`unreadable`).
 * @param {any[]} ops @param {{ kind: string, startsAtMs: number }[]} events @param {{ nowMs?: number, coverageStartMs?: number, kinds?: readonly string[] }} [opts]
 * @returns {{ total:number, marked:number, fraction:number|null, byKind:Record<string,number>, unreadable:number, outsideCoverage:number }}
 */
export function overlapStats(ops, events, { nowMs, coverageStartMs = 0, kinds = HIGH_IMPORTANCE_KINDS } = {}) {
  const byKind = Object.fromEntries(kinds.map((k) => [k, 0]));
  let total = 0;
  let marked = 0;
  let unreadable = 0;
  let outsideCoverage = 0;
  for (const op of Array.isArray(ops) ? ops : []) {
    const w = opWindow(op, nowMs);
    if (!w) { unreadable += 1; continue; }
    if (w.startMs < coverageStartMs) { outsideCoverage += 1; continue; }
    total += 1;
    const hit = eventsDuring(w, events, { kinds });
    if (hit.length) marked += 1;
    for (const k of new Set(hit.map((e) => e.kind))) byKind[k] += 1; // 1 operação conta 1x por tipo, mesmo com 2 CPIs na janela
  }
  return { total, marked, fraction: total ? marked / total : null, byKind, unreadable, outsideCoverage };
}
