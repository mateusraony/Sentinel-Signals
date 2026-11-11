// Contexto de Mercado — o VISUAL do cartão de resultado (redesenho de 10/11/2026, docs/known-risks.md item 285, addendum 20).
// Parte PURA: só geometria (barras, minigráfico, andamento) e frases em português simples. Sem rede, sem relógio próprio (o "agora" vem de fora),
// sem banco. A cor NUNCA diz "bom" ou "ruim": quem manda é o PAPEL do número (anterior, atual, BTC); a direção vai por seta + palavra.
import { valueNumber, shiftMonth } from '@/lib/marketContextBand';

const MIN = 60 * 1000;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Barras "anterior × atual" numa MESMA escala (estilo bullet): cada barra sai do ZERO até o valor. Tudo positivo: o zero fica na esquerda; com
 * valor negativo o zero aparece no meio. Tamanho mínimo de 1,5% para um valor pequeno não sumir. Valor sem número = null naquele lado.
 * @returns {{ zero: number, previous: {left:number,width:number}|null, actual: {left:number,width:number}|null } | null} posições em % da trilha
 */
export function compareBars(previousText, actualText) {
  const p = valueNumber(previousText);
  const a = valueNumber(actualText);
  const vals = [p, a].filter((v) => Number.isFinite(v));
  if (vals.length === 0) return null;
  const lo0 = Math.min(0, ...vals);
  const hi0 = Math.max(0, ...vals);
  const span0 = hi0 - lo0 || 1;
  const lo = lo0 < 0 ? lo0 - span0 * 0.1 : 0;
  const hi = hi0 > 0 ? hi0 + span0 * 0.1 : 0;
  const span = hi - lo || 1;
  const pos = (v) => ((v - lo) / span) * 100;
  const zero = pos(0);
  const bar = (v) => {
    if (!Number.isFinite(v)) return null;
    const at = pos(v);
    const width = v === 0 ? 0 : Math.max(Math.abs(at - zero), 1.5);
    return { left: at >= zero ? zero : zero - width, width };
  };
  return { zero, previous: bar(p), actual: bar(a) };
}

/**
 * Quanto a medida mudou em relação à divulgação anterior, em palavras: "0,2 ponto a menos" (variação %) ou "136 mil a mais" (vagas). null se algum
 * lado não é número ou se não mudou. É um FATO sobre dois números; não diz se é bom ou ruim.
 */
export function deltaText(previousText, actualText) {
  const p = valueNumber(previousText);
  const a = valueNumber(actualText);
  if (!Number.isFinite(p) || !Number.isFinite(a)) return null;
  const d = a - p;
  if (Math.abs(d) < 1e-9) return null;
  const more = d > 0 ? 'a mais' : 'a menos';
  const n = Math.abs(d);
  if (/\smil\s*$/.test(String(actualText))) return `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} mil ${more}`;
  const txt = round1(n).toFixed(1).replace('.', ',');
  return `${txt} ${n > 1 ? 'pontos' : 'ponto'} ${more}`;
}

/**
 * O resumo do cartão em frases simples, uma por medida. `official` = o evento já tem o "Atual". Cada item:
 *  - { kind: 'wait' }                                         — o BLS ainda não publicou;
 *  - { kind: 'compare', label, actual, previous, word, revised } — "acima" | "abaixo" | "igual" à divulgação anterior;
 *  - { kind: 'alone', label, actual, revised }               — saiu, mas não há anterior para comparar;
 *  - { kind: 'unavailable', label }                          — saiu o resultado, mas esta medida não deu para calcular;
 *  - { kind: 'gap', label, reason, month }                   — sem número oficial porque o BLS nunca publicou o mês-base (lacuna oficial).
 * @param {{ key: string, label: string, previous: string|null, actual: string|null, revised: string|null, direction: string|null, gap?: string, gapMonth?: string|null, alt?: object|null }[]} rows
 */
export function resultSummary(rows, official) {
  if (!official) return [{ key: 'wait', kind: 'wait' }];
  return (Array.isArray(rows) ? rows : []).map((r) => {
    // Lacuna OFICIAL (o BLS nunca publicou o mês-base do "em 12 meses"): a frase diz POR QUÊ, em vez de "indisponível".
    if (r.actual === null && r.gap) return { key: r.key, kind: 'gap', label: r.label, reason: r.gap, month: monthLabel(r.gapMonth) };
    if (r.actual === null) return { key: r.key, kind: 'unavailable', label: r.label };
    if (r.previous !== null && r.direction) {
      return { key: r.key, kind: 'compare', label: r.label, actual: r.actual, previous: r.previous, word: r.direction, revised: r.revised };
    }
    return { key: r.key, kind: 'alone', label: r.label, actual: r.actual, revised: r.revised };
  });
}

const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** 'AAAA-MM' → "out/2025" (null se não for um mês bem formado). */
export function monthLabel(ym) {
  const m = typeof ym === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym) : null;
  return m ? `${MONTHS_PT[Number(m[2]) - 1]}/${m[1]}` : null;
}

/** O motivo da lacuna em palavras, depois de "O BLS não divulgou o índice de out/2025": a paralisação do governo dos EUA ou nada (motivo genérico). */
const gapCause = (reason) => (reason === 'paralisacao_2025' ? ' (paralisação do governo dos EUA)' : '');

/** Título e texto curtos da janela alternativa (`alt` já interpretado por `parseAlt`): "desde nov/2025 (11 meses)" e o período em palavras. */
export function altWindowText(alt) {
  const from = monthLabel(alt?.from);
  const to = monthLabel(alt?.to);
  if (!from || !to || !Number.isFinite(alt?.months)) return null;
  return {
    title: `desde ${from} (${alt.months} meses)`,
    body: `de ${from} até ${to}, só com índices que o BLS publicou (sem ajuste sazonal).`,
  };
}

/**
 * A explicação completa da lacuna (a caixa "Por que não há número em 12 meses?"), em frases curtas. `r` = a linha "em 12 meses" de `resultRows` com `gap`.
 * Não estima nada: diz o que o BLS não publicou, o que isso impede e — se existe — que a janela alternativa é só uma referência de outro período.
 * @returns {string[]}
 */
export function gapExplanation(r) {
  const month = monthLabel(r?.gapMonth);
  const eventMonth = month ? monthLabel(shiftMonth(r.gapMonth, 12)) : null;
  const lines = [];
  if (r?.gap === 'paralisacao_2025') {
    lines.push(`O BLS não coletou os preços ${month ? `de ${month}` : 'do mês usado na comparação'} por causa da paralisação do governo dos EUA e nunca publicou esse índice.`);
  } else {
    lines.push(`O BLS não publicou o índice ${month ? `de ${month}` : 'do mês usado na comparação'}.`);
  }
  lines.push(`Sem ele, o BLS também não divulga a variação em 12 meses${eventMonth ? ` de ${eventMonth}` : ''}. Nada foi estimado.`);
  if (r?.alt) {
    lines.push(`A janela alternativa é só uma referência: tem ${r.alt.months} meses e não se compara com ${r.previous ? `os ${r.previous} de 12 meses da divulgação anterior` : 'o número oficial de 12 meses'}.`);
  }
  return lines;
}

/** A mesma frase como TEXTO (leitor de tela, título, teste de vocabulário). */
export function summaryText(item) {
  if (item.kind === 'wait') return 'O BLS ainda não publicou o número deste mês. Quando sair, ele aparece aqui.';
  if (item.kind === 'gap') return `${item.label}: sem número oficial neste mês. O BLS não divulgou o índice ${item.month ? `de ${item.month}` : 'do mês usado na comparação'}${gapCause(item.reason)}.`;
  if (item.kind === 'unavailable') return `${item.label}: indisponível desta vez, não deu para calcular com os dados do BLS.`;
  const rev = item.revised ? ` O anterior foi revisado para ${item.revised}.` : '';
  if (item.kind === 'alone') return `${item.label}: ${item.actual}.${rev}`;
  if (item.word === 'igual') return `${item.label}: ${item.actual}, igual ao da divulgação anterior (${item.previous}).${rev}`;
  return `${item.label}: ${item.actual}, ${item.word} dos ${item.previous} da divulgação anterior.${rev}`;
}

/**
 * Geometria do minigráfico "BTC desde a divulgação": eixo X de 0 a 60 min FIXO (a linha cresce com o tempo); eixo Y ajustado ao que o BTC fez
 * (do menor ao maior valor, o ZERO sempre dentro, no mínimo 0,3% de escala e 12% de folga em cima e embaixo) — assim o desenho usa a altura toda,
 * mesmo quando o BTC só caiu ou só subiu. `series` = [{ m, pct }] (m = minuto depois da divulgação, pct = variação em %).
 * @returns {{ width: number, height: number, pad: number, line: string, area: string, zeroY: number, points: {m:number,x:number,y:number,pct:number}[], maxAbs: number } | null}
 */
export function sparkGeometry(series, { width = 300, height = 112, pad = 10 } = {}) {
  const pts = (Array.isArray(series) ? series : [])
    .filter((s) => Number.isFinite(s?.m) && Number.isFinite(s?.pct) && s.m >= 0 && s.m <= 60)
    .sort((a, b) => a.m - b.m);
  if (pts.length < 2) return null;
  const vals = pts.map((s) => s.pct);
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  // Escala mínima de 0,3% NO EIXO (não só na folga): o que falta é repartido dos dois lados (o zero continua dentro). Assim um movimento de
  // 0,1% ocupa ~1/4 da altura e não 58% — movimento minúsculo não vira montanha (achado do Codex, PR #557).
  const falta = Math.max(0, 0.3 - (hi - lo));
  lo -= falta / 2;
  hi += falta / 2;
  const folga = (hi - lo) * 0.12;
  lo -= folga;
  hi += folga;
  const maxAbs = Math.max(0.3, ...vals.map((v) => Math.abs(v)));
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const x = (m) => round1(pad + (m / 60) * innerW);
  const y = (v) => round1(pad + ((hi - v) / (hi - lo)) * innerH);
  const zeroY = y(0);
  const points = pts.map((s) => ({ m: s.m, x: x(s.m), y: y(s.pct), pct: s.pct }));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const last = points[points.length - 1];
  const area = `${line} L${last.x} ${zeroY} L${points[0].x} ${zeroY} Z`;
  return { width, height, pad, line, area, zeroY, points, maxAbs };
}

/** O ponto do minigráfico num minuto exato (para os marcadores de 5, 30 e 60 min); null se aquele minuto não existe na série. */
export function markerAt(geo, m) {
  return geo?.points.find((p) => p.m === m) ?? null;
}

/**
 * O ponto do minigráfico mais perto de uma posição horizontal `vx` (nas unidades do DESENHO, de 0 a `geo.width`): é o que o ponteiro do mouse ou o dedo
 * "pega" para mostrar a dica. Fora do desenho cai no primeiro ou no último ponto. Devolve o próprio ponto da geometria; null sem pontos ou com `vx` inválido.
 * @returns {{ m: number, x: number, y: number, pct: number } | null}
 */
export function nearestPoint(geo, vx) {
  if (!Array.isArray(geo?.points) || geo.points.length === 0 || !Number.isFinite(vx)) return null;
  let best = geo.points[0];
  for (const p of geo.points) {
    if (Math.abs(p.x - vx) < Math.abs(best.x - vx)) best = p;
  }
  return best;
}

/** Algum dos números oficiais do evento é uma porcentagem (CPI, PPI)? O Payroll é em "mil", sem casa decimal. */
export function hasPercentValues(values) {
  return [values?.previous, values?.actual, values?.revised].some((t) => typeof t === 'string' && t.includes('%'));
}

/**
 * A linha "Fonte" do rodapé, com as casas decimais de cada número (o BLS divulga as variações com 1 casa; o BTC é quotado com 2): sem isso, "+0,4%" do
 * CPI e "-0,59%" do BTC parecem inconsistentes. Só fala de "1 casa" quando há número em % e só fala do BTC quando o painel do BTC está na tela.
 * @param {{ source?: string, percent?: boolean, btc?: boolean }} [opcoes]
 */
export function sourceLine({ source, percent = false, btc = false } = {}) {
  const parts = [];
  if (source) parts.push(percent ? `${source} (1 casa decimal, como divulgado)` : source);
  if (btc) parts.push('BTC: Binance (2 casas)');
  return parts.join(' · ');
}

/**
 * Andamento de um horizonte (5, 30 ou 60 min) depois da divulgação: já fechou? senão, quanto falta e que fração do caminho já passou.
 * @returns {{ closed: boolean, remainingMin: number, fraction: number }}
 */
export function horizonStatus(n, startMs, nowMs) {
  const left = startMs + n * MIN - nowMs;
  if (left <= 0) return { closed: true, remainingMin: 0, fraction: 1 };
  return { closed: false, remainingMin: Math.ceil(left / MIN), fraction: clamp(1 - left / (n * MIN), 0, 1) };
}

/** Fração (0–1) do tamanho de um movimento em relação ao maior da tela (mínimo de escala 0,3%): a barrinha mostra TAMANHO, não direção. */
export function sizeFraction(pct, maxAbs) {
  if (!Number.isFinite(pct)) return 0;
  return clamp(Math.abs(pct) / Math.max(maxAbs, 0.3), 0, 1);
}

/** O maior movimento (em módulo) entre os horizontes que já têm número; 0,3 se nenhum. */
export function maxAbsMove(moves) {
  const vals = Object.values(moves ?? {}).filter((v) => Number.isFinite(v)).map((v) => Math.abs(v));
  return Math.max(0.3, ...vals);
}

/**
 * Duas barras na MESMA escala para "nas divulgações × num dia normal" (texto como "0,65%"). null se algum lado não é número.
 * @returns {{ value: number, normal: number } | null} frações 0–1 da trilha
 */
export function gaugeBars(valueText, normalText) {
  const v = valueNumber(valueText);
  const n = valueNumber(normalText);
  if (!Number.isFinite(v) || !Number.isFinite(n)) return null;
  const top = Math.max(v, n, 0.01) * 1.15;
  return { value: clamp(v / top, 0, 1), normal: clamp(n / top, 0, 1) };
}

/**
 * O ponto mais baixo, o mais alto e o último da série do BTC DEPOIS da divulgação (minuto 1 em diante; a referência em 0% não conta). Em empate fica o
 * primeiro minuto. É um FATO sobre o que já aconteceu — não diz o que vem depois. null se ainda não há nenhum minuto fechado.
 * @returns {{ min: {m:number,pct:number}, max: {m:number,pct:number}, last: {m:number,pct:number} } | null}
 */
export function seriesExtremes(series) {
  const pts = (Array.isArray(series) ? series : []).filter((s) => Number.isFinite(s?.m) && Number.isFinite(s?.pct) && s.m >= 1);
  if (pts.length === 0) return null;
  let min = pts[0];
  let max = pts[0];
  for (const p of pts) {
    if (p.pct < min.pct) min = p;
    if (p.pct > max.pct) max = p;
  }
  return { min, max, last: pts[pts.length - 1] };
}
