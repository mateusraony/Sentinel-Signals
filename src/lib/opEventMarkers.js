// Contexto de Mercado — Fase 5 (docs/known-risks.md item 285): o marcador "aberta durante <evento>" do Histórico. PURO.
// É CORRELAÇÃO, nunca causa: o marcador só diz que a operação estava aberta no instante da divulgação. Só os eventos de ALTA importância
// (CPI, Payroll, FOMC). Sem dado confiável (operação antes do histórico, ou que toca um mês sem divulgação no histórico) NÃO há marcador
// e nada é afirmado — a ausência do marcador não quer dizer "sem evento" nesses casos. Mesma regra da medição (`scripts/overlap-measure.mjs`).
import { opWindow, eventsDuring, HIGH_IMPORTANCE_KINDS } from './contextOverlap.js';
import { buildEvents } from './contextEvents.js';

/**
 * O contexto da conta, a partir do que a rede devolveu (`fetchOperationEventsSource`). null se não dá para montar (sem histórico de todos os tipos).
 * @returns {{ events: { kind: string, startsAtMs: number }[], coverageStartMs: number, gaps: Record<string, { startMs: number, endMs: number }[]> }|null}
 */
export function buildOperationEventContext(source, nowMs) {
  if (!source || !source.history) return null;
  const built = buildEvents({ history: source.history, events: source.events, nowMs });
  if (built.coverageStartMs == null) return null;
  return { events: built.events, coverageStartMs: built.coverageStartMs, gaps: built.gaps };
}

/** Os eventos de alta importância durante os quais a operação ficou aberta (em ordem de data), ou null (nenhum, ou sem dado confiável para dizer). */
export function eventMarkersFor(op, ctx, nowMs) {
  if (!ctx || !Array.isArray(ctx.events) || !Number.isFinite(ctx.coverageStartMs)) return null;
  const w = opWindow(op, nowMs);
  if (!w || w.startMs < ctx.coverageStartMs) return null;
  const gaps = HIGH_IMPORTANCE_KINDS.flatMap((k) => ctx.gaps?.[k] ?? []);
  if (gaps.some((g) => w.startMs <= g.endMs && w.endMs >= g.startMs)) return null;
  const hit = eventsDuring(w, ctx.events, { kinds: HIGH_IMPORTANCE_KINDS });
  return hit.length ? hit : null;
}

const NAMES = Object.freeze({ CPI: 'CPI', NFP: 'Payroll', FOMC: 'FOMC' });
const FULL_NAMES = Object.freeze({ CPI: 'inflação ao consumidor (CPI)', NFP: 'emprego dos EUA (Payroll)', FOMC: 'decisão de juros do Fed (FOMC)' });
const dayMonth = (ms) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(new Date(ms));
const clock = (ms) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

/** O texto curto do selo: "Aberta durante o CPI (10/11)"; vários: "… o CPI (10/11) e o Payroll (06/11)" (no máximo 2 nomes e "+N"). */
export function markerLabel(hit) {
  const parts = hit.map((e) => `${NAMES[e.kind] ?? e.kind} (${dayMonth(e.startsAtMs)})`);
  const shown = parts.slice(0, 2).join(' e o ');
  const more = parts.length > 2 ? ` +${parts.length - 2}` : '';
  return `Aberta durante o ${shown}${more}`;
}

/** A explicação do selo (dica e leitor de tela): quando saiu cada um e o aviso de que é só coincidência de horário. */
export function markerExplanation(hit) {
  const list = hit.map((e) => `${FULL_NAMES[e.kind] ?? e.kind} em ${dayMonth(e.startsAtMs)} às ${clock(e.startsAtMs)} (Brasília)`).join('; ');
  return `Esta operação estava aberta quando saiu: ${list}. É só a coincidência de horário — não diz que o evento mexeu no resultado.`;
}
