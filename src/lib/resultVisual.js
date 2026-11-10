// Contexto de Mercado — o VISUAL do cartão de resultado (redesenho de 10/11/2026, docs/known-risks.md item 285, addendum 20).
// Parte PURA: só geometria (barras, minigráfico, andamento) e frases em português simples. Sem rede, sem relógio próprio (o "agora" vem de fora),
// sem banco. A cor NUNCA diz "bom" ou "ruim": quem manda é o PAPEL do número (anterior, atual, BTC); a direção vai por seta + palavra.
import { valueNumber } from '@/lib/marketContextBand';

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
 *  - { kind: 'unavailable', label }                          — saiu o resultado, mas esta medida não deu para calcular.
 * @param {{ key: string, label: string, previous: string|null, actual: string|null, revised: string|null, direction: string|null }[]} rows
 */
export function resultSummary(rows, official) {
  if (!official) return [{ key: 'wait', kind: 'wait' }];
  return (Array.isArray(rows) ? rows : []).map((r) => {
    if (r.actual === null) return { key: r.key, kind: 'unavailable', label: r.label };
    if (r.previous !== null && r.direction) {
      return { key: r.key, kind: 'compare', label: r.label, actual: r.actual, previous: r.previous, word: r.direction, revised: r.revised };
    }
    return { key: r.key, kind: 'alone', label: r.label, actual: r.actual, revised: r.revised };
  });
}

/** A mesma frase como TEXTO (leitor de tela, título, teste de vocabulário). */
export function summaryText(item) {
  if (item.kind === 'wait') return 'O BLS ainda não publicou o número deste mês. Quando sair, ele aparece aqui.';
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
  const lo0 = Math.min(0, ...vals);
  const hi0 = Math.max(0, ...vals);
  const span0 = Math.max(hi0 - lo0, 0.3);
  const lo = lo0 - span0 * 0.12;
  const hi = hi0 + span0 * 0.12;
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
