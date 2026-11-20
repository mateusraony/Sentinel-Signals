// Medição do portão da Fase 5 do Contexto de Mercado (docs/known-risks.md item 285): "que fração das operações REAIS ficou aberta durante um evento macro?".
// Se for ≤ 30%, o marcador "aberta durante <evento>" no Histórico faz sentido (só destaca o que é incomum); acima disso vira ruído.
//
// Parte PURA do script (sem rede, sem banco, sem relógio global): o veredito e o relatório. O que toca banco e rede mora em `overlap-measure.mjs`. O relatório sai num log PÚBLICO: só contagens, datas de divulgação
// (já públicas) e percentuais — nunca símbolo, id, preço nem resultado de operação.
import { HIGH_IMPORTANCE_KINDS, ALL_KINDS } from '../src/lib/contextOverlap.js';
import { eventInstant, buildEvents, findGaps } from '../src/lib/contextEvents.js';

// A montagem dos eventos e dos buracos mora em src/lib/contextEvents.js (o painel usa a MESMA conta no marcador do Histórico).
export { eventInstant, buildEvents, findGaps };

export const GATE_FRACTION = 0.3;
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
