// Medição do portão da Fase 5 do Contexto de Mercado (docs/known-risks.md item 285): "que fração das operações REAIS ficou aberta durante um evento macro?".
// Se for ≤ 30%, o marcador "aberta durante <evento>" no Histórico faz sentido (só destaca o que é incomum); acima disso vira ruído.
//
// Parte PURA do script (sem rede, sem banco, sem relógio global): monta a lista de eventos a partir dos arquivos PÚBLICOS da branch `context-data`
// e formata o relatório. O que toca banco e rede mora em `overlap-measure.mjs`. O relatório sai num log PÚBLICO: só contagens, datas de divulgação
// (já públicas) e percentuais — nunca símbolo, id, preço nem resultado de operação.
import { KIND_TIMES } from './contextCalendar.mjs';
import { nyToUtc } from './contextTime.mjs';
import { HIGH_IMPORTANCE_KINDS, ALL_KINDS } from '../src/lib/contextOverlap.js';

export const GATE_FRACTION = 0.3;
const DAY_MS = 86400000;
/** Tipos mensais (uma divulgação por mês); o FOMC tem 8 por ano (intervalo máximo normal ~8 semanas). */
const MONTHLY_KINDS = new Set(['CPI', 'NFP', 'PPI', 'PCE']);
const FOMC_MAX_GAP_DAYS = 75;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIRM_STATUS = new Set(['oficial', 'confirmada']);

/** 'AAAA-MM-DD' + tipo → instante UTC (ms) da divulgação, pelo horário fixo do tipo em Nova York. null se a data/tipo não servem. */
export function eventInstant(kind, date) {
  if (!DATE_RE.test(date ?? '') || !KIND_TIMES[kind]) return null;
  const r = nyToUtc(date, KIND_TIMES[kind]);
  return r ? r.ms : null;
}

/**
 * Junta o que a branch `context-data` publica: `history.json` ({ dates: { CPI: ['AAAA-MM-DD'…] } }, passadas) e `events.json` (lista com `startsAtUtc`
 * e `status`; só os de data firme e já ocorridos entram). Sem repetição (tipo + instante).
 * `coverageStartMs`: o mais RECENTE dos "primeiros dias conhecidos" dos tipos pedidos — antes disso ao menos um tipo não tem histórico, e contar
 * "sem evento" ali seria só falta de dado.
 */
export function buildEvents({ history, events, nowMs, kinds = ALL_KINDS }) {
  const seen = {};
  const add = (kind, ms) => { if (Number.isFinite(ms)) seen[`${kind}|${ms}`] = { kind, startsAtMs: ms }; };
  const firstKnown = {};
  const dates = history && typeof history === 'object' ? history.dates : null;
  for (const kind of kinds) {
    const list = Array.isArray(dates?.[kind]) ? dates[kind] : [];
    for (const d of list) {
      const ms = eventInstant(kind, d);
      if (ms == null) continue;
      add(kind, ms);
      if (firstKnown[kind] == null || ms < firstKnown[kind]) firstKnown[kind] = ms;
    }
  }
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || !kinds.includes(e.kind) || !FIRM_STATUS.has(e.status)) continue;
    const ms = Date.parse(e.startsAtUtc ?? '');
    if (Number.isFinite(ms) && ms <= nowMs) add(e.kind, ms);
  }
  const have = kinds.filter((k) => firstKnown[k] != null);
  const coverageStartMs = have.length === kinds.length ? Math.max(...have.map((k) => firstKnown[k])) : null;
  const events2 = Object.values(seen).sort((a, b) => a.startsAtMs - b.startsAtMs);
  const msByKind = {};
  for (const e of events2) (msByKind[e.kind] ??= []).push(e.startsAtMs);
  return { events: events2, coverageStartMs, kindsWithHistory: have, gaps: findGaps(msByKind, nowMs) };
}

/**
 * Os BURACOS do histórico de cada tipo (achado do Codex no PR #596): o coletor tira do histórico o mês com 2 datas (`contextHistory.mjs`), então "a data mais antiga"
 * não prova que não faltou nenhuma depois dela. Tipo mensal: cada mês, do primeiro ao anterior ao atual, sem nenhuma data. FOMC: espaço maior que 75 dias entre duas
 * reuniões conhecidas (ou desde a última até agora). Um intervalo {startMs, endMs} por buraco, por tipo.
 * @param {Record<string, number[]>} msByKind instantes conhecidos por tipo
 */
export function findGaps(msByKind, nowMs) {
  const gaps = {};
  for (const [kind, list] of Object.entries(msByKind)) {
    const known = [...list].sort((a, b) => a - b);
    if (!known.length) continue;
    const out = [];
    if (MONTHLY_KINDS.has(kind)) {
      const have = new Set(known.map((ms) => new Date(ms).toISOString().slice(0, 7)));
      const first = new Date(known[0]);
      const now = new Date(nowMs);
      let y = first.getUTCFullYear();
      let m = first.getUTCMonth();
      const stop = now.getUTCFullYear() * 12 + now.getUTCMonth(); // o mês de hoje não conta: a divulgação dele pode ainda não ter saído
      while (y * 12 + m < stop) {
        const key = `${y}-${String(m + 1).padStart(2, '0')}`;
        if (!have.has(key)) out.push({ startMs: Date.UTC(y, m, 1), endMs: Date.UTC(y, m + 1, 1) - 1 });
        m += 1;
        if (m > 11) { m = 0; y += 1; }
      }
    } else {
      for (let i = 1; i < known.length; i += 1) {
        if (known[i] - known[i - 1] > FOMC_MAX_GAP_DAYS * DAY_MS) out.push({ startMs: known[i - 1] + 1, endMs: known[i] - 1 });
      }
      const last = known[known.length - 1];
      if (nowMs - last > FOMC_MAX_GAP_DAYS * DAY_MS) out.push({ startMs: last + 1, endMs: nowMs });
    }
    if (out.length) gaps[kind] = out;
  }
  return gaps;
}

const pct = (f) => (f == null ? 'n/d' : `${(f * 100).toFixed(1).replace('.', ',')}%`);
const day = (ms) => (ms == null ? 'n/d' : new Date(ms).toISOString().slice(0, 10));

/** O veredito do portão, em português, sem recomendação de operação. */
export function gateVerdict(stats) {
  if (!stats || !stats.total) return 'SEM AMOSTRA: nenhuma operação dentro do período coberto — o portão não pode ser decidido.';
  if (stats.fraction <= GATE_FRACTION) return `PASSA: ${pct(stats.fraction)} das operações ficaram abertas durante um evento de alta importância (limite de ${pct(GATE_FRACTION)}).`;
  return `NÃO PASSA: ${pct(stats.fraction)} das operações ficaram abertas durante um evento de alta importância (limite de ${pct(GATE_FRACTION)}) — um marcador em quase toda operação não diz nada.`;
}

/** Linhas do relatório (texto puro, vai para o log público). `high`/`all`: saídas de `overlapStats`. */
export function formatReport({ high, all, coverageStartMs, nowMs, eventsCount, durationHoursMedian, gapMonths = [] }) {
  const L = [];
  L.push('# Medição da Fase 5 — operações abertas durante um evento macro');
  L.push('');
  L.push('Só contagens e percentuais (o repositório e o log são públicos). Correlação, não causa.');
  L.push('');
  L.push(`- Período coberto pelo histórico de eventos: ${day(coverageStartMs)} → ${day(nowMs)} (${eventsCount} eventos conhecidos).`);
  L.push(`- Operações dentro do período: **${high.total}** · fora do período (antes do histórico): ${high.outsideCoverage} · sem horário legível: ${high.unreadable} · em período com divulgação faltando no histórico: ${high.inGap}.`);
  if (gapMonths.length) L.push(`- Meses sem divulgação no histórico (operações que os tocam ficam fora da conta): ${gapMonths.join(', ')}.`);
  if (durationHoursMedian != null) L.push(`- Duração mediana das operações do período: ${durationHoursMedian.toFixed(1).replace('.', ',')} h.`);
  L.push('');
  L.push(`## Alta importância (${HIGH_IMPORTANCE_KINDS.join(', ')})`);
  L.push(`- Marcadas: **${high.marked} de ${high.total}** = **${pct(high.fraction)}**`);
  for (const k of HIGH_IMPORTANCE_KINDS) L.push(`  - ${k}: ${high.byKind[k] ?? 0}`);
  L.push('');
  L.push(`## Todos os 5 tipos (${ALL_KINDS.join(', ')}) — só informativo`);
  L.push(`- Marcadas: ${all.marked} de ${all.total} = ${pct(all.fraction)}`);
  L.push('');
  L.push(`**Portão (≤ ${pct(GATE_FRACTION)}): ${gateVerdict(high)}**`);
  if (high.total < 30) L.push(`Atenção: amostra pequena (${high.total} ${high.total === 1 ? 'operação' : 'operações'}) — a fração tem margem de erro grande; leia como ordem de grandeza.`);
  return L;
}

/** Mediana simples (horas) das durações das janelas; null sem janelas. */
export function medianHours(windows) {
  const hs = windows.map((w) => (w.endMs - w.startMs) / 3600000).sort((a, b) => a - b);
  if (!hs.length) return null;
  const m = Math.floor(hs.length / 2);
  return hs.length % 2 ? hs[m] : (hs[m - 1] + hs[m]) / 2;
}
