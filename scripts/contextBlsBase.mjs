// Contexto de Mercado — a BASE PRÓPRIA do BLS (docs/known-risks.md item 285, addendum 21). Módulo PURO (sem rede, sem disco, sem relógio).
//
// Por quê: até aqui cada coleta baixava o histórico inteiro e calculava tudo na hora; uma resposta parcial ou uma queda da API deixava o evento sem
// número, e a linha "-" do BLS (mês que NUNCA foi publicado, como outubro de 2025 por causa da paralisação do governo dos EUA) sumia sem deixar rastro.
// Agora o coletor guarda os ÍNDICES CRUS que o BLS publicou (domínio público; "Fonte: BLS" na tela) e as LACUNAS OFICIAIS com o motivo, num arquivo
// pequeno (`bls-base.json`) na branch pública `context-data`. Os números do painel são calculados da base JÁ FUNDIDA com a resposta da API
// (`baseToSeries(mergeBase(...).base)`): um valor que a fusão recusou NUNCA entra na conta — não se mistura a resposta crua por cima da base.
//
// Regras (cada uma travada por teste):
//  - a fusão NUNCA perde o que já foi lido: resposta nula, parcial ou com erro deixa a base idêntica, byte a byte;
//  - revisão pequena do BLS (até 5%) sobrescreve; salto maior é recusado e contado (série errada ou dado corrompido);
//  - um valor nunca vira lacuna; a lacuna some quando o valor chega (o BLS publicou mais tarde);
//  - nunca se estima nem se interpola: lacuna é lacuna;
//  - lista FECHADA no arquivo público: 5 séries conhecidas, meses AAAA-MM, números plausíveis, motivos do enum. Nada de texto livre, URL ou chave.
import { GAP_REASONS, BLS_SOURCE, allSeriesIds } from './contextBls.mjs';

export const BASE_VERSION = 1;
export const BASE_SOURCE = BLS_SOURCE;
/** Quantos meses (os mais recentes) a base guarda por série: dá para o "em 12 meses" de qualquer mês e para o histórico, em poucos KB. */
export const MAX_MONTHS = 40;
/** Revisão do BLS acima disto sobre o valor já guardado é recusada (série errada / dado corrompido); as revisões reais são minúsculas. */
export const MAX_JUMP_PCT = 5;
const MAX_VALUE = 1e7;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const IDS = allSeriesIds();

/**
 * Lacunas OFICIAIS já documentadas pelo BLS, usadas como reserva se a API omitir a linha "-": o índice de outubro de 2025 do CPI (com e sem ajuste) NÃO
 * existe (a coleta de preços não foi feita na paralisação do governo dos EUA e não será refeita; fonte: página do BLS "2025 federal government shutdown
 * impact on the CPI"). O PPI e o Payroll de outubro de 2025 foram publicados depois, então não entram aqui. O valor que chegar apaga a lacuna.
 */
export const SEED_GAPS = Object.freeze({
  CUSR0000SA0: Object.freeze({ '2025-10': 'paralisacao_2025' }),
  CUUR0000SA0: Object.freeze({ '2025-10': 'paralisacao_2025' }),
});

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const plausible = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < MAX_VALUE;

export const emptyBase = () => ({ version: BASE_VERSION, source: BASE_SOURCE, values: {}, gaps: {} });

/** O texto exato do arquivo: chaves em ordem estável e quebra de linha final (o arquivo só muda quando um número muda). */
export const serializeBase = (base) => `${JSON.stringify(base, null, 2)}\n`;

/** Os meses mais recentes (união de valores e lacunas) de uma série, em ordem crescente, no máximo `MAX_MONTHS`. */
function janela(valores, lacunas) {
  const meses = [...new Set([...Object.keys(valores), ...Object.keys(lacunas)])].sort();
  return new Set(meses.slice(-MAX_MONTHS));
}

/** Monta uma base limpa e ordenada a partir de blocos já validados (poda para a janela, omite série vazia). */
function montar(valuesById, gapsById) {
  const out = emptyBase();
  for (const id of IDS) {
    const v = valuesById[id] ?? {};
    const g = gapsById[id] ?? {};
    const manter = janela(v, g);
    const vs = Object.fromEntries(Object.entries(v).filter(([ym]) => manter.has(ym)).sort(([a], [b]) => (a < b ? -1 : 1)));
    const gs = Object.fromEntries(Object.entries(g).filter(([ym]) => manter.has(ym)).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (Object.keys(vs).length) out.values[id] = vs;
    if (Object.keys(gs).length) out.gaps[id] = gs;
  }
  return out;
}

/**
 * O arquivo lido do disco/rede NUNCA é confiável: devolve uma base limpa aproveitando só o que presta (série conhecida, mês AAAA-MM, número
 * plausível, motivo do enum, lacuna só de mês sem valor). Lixo, versão errada ou tipo errado viram base vazia. Nunca lança.
 */
export function sanitizeBase(raw) {
  if (!isObj(raw) || raw.version !== BASE_VERSION) return emptyBase();
  const values = {};
  const gaps = {};
  for (const id of IDS) {
    const vs = isObj(raw.values?.[id]) ? raw.values[id] : {};
    const limpos = {};
    for (const [ym, v] of Object.entries(vs)) if (MONTH_RE.test(ym) && plausible(v)) limpos[ym] = v;
    const gs = isObj(raw.gaps?.[id]) ? raw.gaps[id] : {};
    const lacunas = {};
    for (const [ym, r] of Object.entries(gs)) if (MONTH_RE.test(ym) && GAP_REASONS.includes(r) && limpos[ym] === undefined) lacunas[ym] = r;
    values[id] = limpos;
    gaps[id] = lacunas;
  }
  return montar(values, gaps);
}

/**
 * A trava do conteúdo público: só a lista fechada passa. As mensagens são GENÉRICAS de propósito (nunca citam o conteúdo recusado, que poderia ser
 * uma URL com chave). Lança `Error('base do BLS recusada: …')`.
 */
export function assertBaseShape(base) {
  if (!isObj(base)) throw new Error('base do BLS recusada: não é um objeto');
  const problemas = [];
  if (Object.keys(base).sort().join(',') !== 'gaps,source,values,version') problemas.push('campos diferentes de version, source, values, gaps');
  if (base.version !== BASE_VERSION) problemas.push('versão inválida');
  if (base.source !== BASE_SOURCE) problemas.push('fonte inválida');
  for (const campo of ['values', 'gaps']) {
    const bloco = base[campo];
    if (!isObj(bloco)) { problemas.push(`${campo} não é um objeto`); continue; }
    for (const [id, meses] of Object.entries(bloco)) {
      if (!IDS.includes(id)) { problemas.push(`série desconhecida em ${campo}`); continue; }
      if (!isObj(meses)) { problemas.push(`${campo}: série sem objeto de meses`); continue; }
      for (const [ym, x] of Object.entries(meses)) {
        if (!MONTH_RE.test(ym)) problemas.push(`${campo}: mês inválido`);
        else if (campo === 'values' && !plausible(x)) problemas.push('values: número inválido');
        else if (campo === 'gaps' && !GAP_REASONS.includes(x)) problemas.push('gaps: motivo fora da lista');
      }
    }
  }
  for (const id of IDS) {
    const v = isObj(base.values) && isObj(base.values[id]) ? base.values[id] : {};
    const g = isObj(base.gaps) && isObj(base.gaps[id]) ? base.gaps[id] : {};
    if (Object.keys(g).some((ym) => ym in v)) problemas.push('valor e lacuna no mesmo mês');
    if (new Set([...Object.keys(v), ...Object.keys(g)]).size > MAX_MONTHS) problemas.push(`mais de ${MAX_MONTHS} meses numa série`);
  }
  if (problemas.length) throw new Error(`base do BLS recusada: ${problemas.slice(0, 5).join('; ')}`);
}

/**
 * Funde a resposta da API na base. `fetched` = `{ series: { id → Map(mês → número)|null }, gaps: { id → Map(mês → motivo)|null } }` (o que `fetchBlsSeries`
 * devolve). Resposta nula, vazia ou parcial só ACRESCENTA: nada do que já estava na base some. Devolve `{ base, changed, stats }`; `changed` compara com
 * a base já sanitizada de entrada. `seedGaps` = as lacunas oficiais conhecidas (reserva, vale só para mês sem valor).
 * @returns {{ base: ReturnType<typeof emptyBase>, changed: boolean, stats: { written: number, gaps: number, rejected: number } }}
 */
export function mergeBase(base, fetched, { seedGaps = SEED_GAPS } = {}) {
  const prev = sanitizeBase(base);
  const stats = { written: 0, gaps: 0, rejected: 0 };
  const values = {};
  const gaps = {};
  for (const id of IDS) {
    const vals = { ...(prev.values[id] ?? {}) };
    const gps = { ...(prev.gaps[id] ?? {}) };
    const m = fetched?.series?.[id];
    if (m instanceof Map) {
      for (const [ym, v] of m) {
        if (typeof ym !== 'string' || !MONTH_RE.test(ym) || !plausible(v)) continue;
        const atual = vals[ym];
        if (atual !== undefined && atual !== v && Math.abs((v / atual - 1) * 100) > MAX_JUMP_PCT + 1e-9) { stats.rejected += 1; continue; }
        if (atual !== v) { vals[ym] = v; stats.written += 1; }
        delete gps[ym]; // o valor chegou: a lacuna deixa de existir
      }
    }
    const g = fetched?.gaps?.[id];
    if (g instanceof Map) {
      for (const [ym, motivo] of g) {
        if (typeof ym !== 'string' || !MONTH_RE.test(ym) || vals[ym] !== undefined) continue; // um valor nunca vira lacuna
        const r = GAP_REASONS.includes(motivo) ? motivo : 'nao_divulgado'; // o texto do BLS nunca passa
        if (gps[ym] !== r) { gps[ym] = r; stats.gaps += 1; }
      }
    }
    for (const [ym, r] of Object.entries(seedGaps?.[id] ?? {})) if (vals[ym] === undefined && gps[ym] === undefined) gps[ym] = r;
    values[id] = vals;
    gaps[id] = gps;
  }
  const next = montar(values, gaps);
  return { base: next, changed: serializeBase(next) !== serializeBase(prev), stats };
}

/** A base como `{ id → Map(mês → número)|null }`, o mesmo formato que `fetchBlsSeries` devolve e que `contextBls.mjs` consome. */
export function baseToSeries(base) {
  const out = {};
  for (const id of IDS) {
    const v = isObj(base?.values) && isObj(base.values[id]) ? Object.entries(base.values[id]) : [];
    out[id] = v.length ? new Map(v) : null;
  }
  return out;
}

/** As lacunas da base como `{ id → Map(mês → motivo)|null }`, o formato que `gapNoteValues` consome. */
export function baseToGaps(base) {
  const out = {};
  for (const id of IDS) {
    const g = isObj(base?.gaps) && isObj(base.gaps[id]) ? Object.entries(base.gaps[id]) : [];
    out[id] = g.length ? new Map(g) : null;
  }
  return out;
}

/**
 * A linha do resumo do coletor sobre a base: só contagens e códigos (o repositório é público e o resumo é legível sem login).
 * @param {{ written: number, rejected: number }} stats @param {string} estado ex.: 'gravada', 'inalterada'
 */
export function describeBase(base, stats, estado) {
  const nValores = Object.values(base?.values ?? {}).reduce((s, m) => s + Object.keys(m).length, 0);
  const lacunas = Object.entries(base?.gaps ?? {}).flatMap(([id, m]) => Object.entries(m).map(([ym, r]) => `${id} ${ym} (${r})`));
  const partes = [`${nValores} valores`, `${lacunas.length} ${lacunas.length === 1 ? 'lacuna oficial' : 'lacunas oficiais'}${lacunas.length ? ` — ${lacunas.slice(0, 6).join(', ')}` : ''}`];
  const rej = stats?.rejected ?? 0;
  if (rej) partes.push(`${rej} ${rej === 1 ? 'salto recusado' : 'saltos recusados'} (revisão acima de ${MAX_JUMP_PCT}%)`);
  partes.push(estado);
  return `Base do BLS: ${partes.join(' · ')}.`;
}
