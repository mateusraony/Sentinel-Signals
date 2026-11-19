// Medição do portão da Fase 5 do Contexto de Mercado (docs/known-risks.md item 285) — workflow `overlap-measure.yml`.
//
// SÓ LEITURA: lê as operações (`TradeOperation`) e imprime contagens e percentuais. Não escreve no banco, não manda Telegram, não toca o motor.
// Prefere a credencial somente-leitura (`DATABASE_URL_READONLY`); sem ela, usa a normal e AVISA no relatório (nunca calado) — o código só chama `list`.
// O repositório e o log do Actions são PÚBLICOS: o relatório leva só contagens, datas de divulgação e percentuais (nada de símbolo, id, preço ou resultado).
// Em falha mostra só um CÓDIGO (nunca a mensagem crua do driver, que pode trazer endereço e senha do banco).
// A parte pura (eventos, relatório) mora em `overlapMeasure.mjs`; a regra de sobreposição, em `src/lib/contextOverlap.js` (a mesma que o painel usaria).
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { buildEvents, formatReport, medianHours } from './overlapMeasure.mjs';
import { overlapStats, opWindow, HIGH_IMPORTANCE_KINDS, ALL_KINDS } from '../src/lib/contextOverlap.js';

const DEFAULT_REPO = 'mateusraony/Sentinel-Signals';
const OPS_LIMIT = 2000;

async function fetchJson(fetchImpl, url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!(res.status >= 200 && res.status < 300)) return null;
    return JSON.parse(await res.text());
  } catch {
    return null; // sem mensagem: poderia citar a URL
  } finally {
    clearTimeout(timer);
  }
}

/**
 * O núcleo, com tudo injetado (testável sem rede nem banco).
 * @returns {Promise<{ lines: string[], code: number }>} `code` 0 = medição feita (passe ou não); 2 = fonte de eventos indisponível; 3 = banco indisponível.
 */
export async function run({ fetchImpl = fetch, listOps, nowMs = Date.now(), repo = DEFAULT_REPO, notes = [] }) {
  const base = `https://raw.githubusercontent.com/${repo}/context-data`;
  const [history, events] = await Promise.all([fetchJson(fetchImpl, `${base}/history.json`), fetchJson(fetchImpl, `${base}/events.json`)]);
  if (!history) return { lines: ['❌ Não consegui ler o histórico de datas (history.json da branch context-data). Nada foi medido. [codigo: historico_indisponivel]'], code: 2 };

  const built = buildEvents({ history, events, nowMs, kinds: ALL_KINDS });
  if (built.coverageStartMs == null) return { lines: ['❌ O histórico não traz datas de todos os 5 tipos de evento: o período coberto não pode ser definido. [codigo: historico_incompleto]'], code: 2 };

  let ops;
  try {
    ops = await listOps();
  } catch {
    return { lines: ['❌ Não consegui ler as operações no banco. Nada foi medido. [codigo: banco_indisponivel]'], code: 3 };
  }
  if (!Array.isArray(ops)) return { lines: ['❌ Resposta inesperada do banco. [codigo: banco_resposta]'], code: 3 };

  const gapsFor = (kinds) => kinds.flatMap((k) => built.gaps[k] ?? []);
  const common = { nowMs, coverageStartMs: built.coverageStartMs };
  const high = overlapStats(ops, built.events, { ...common, kinds: HIGH_IMPORTANCE_KINDS, gaps: gapsFor(HIGH_IMPORTANCE_KINDS) });
  const all = overlapStats(ops, built.events, { ...common, kinds: ALL_KINDS, gaps: gapsFor(ALL_KINDS) });
  const gapMonths = ALL_KINDS.flatMap((k) => (built.gaps[k] ?? []).map((g) => `${k} ${new Date(g.startMs).toISOString().slice(0, 7)}`));
  const gapAll = gapsFor(HIGH_IMPORTANCE_KINDS);
  const windows = ops.map((o) => opWindow(o, nowMs)).filter((w) => w && w.startMs >= built.coverageStartMs && !gapAll.some((g) => w.startMs <= g.endMs && w.endMs >= g.startMs));
  const lines = [
    ...formatReport({ high, all, coverageStartMs: built.coverageStartMs, nowMs, eventsCount: built.events.length, durationHoursMedian: medianHours(windows), gapMonths }),
    ...(notes.length ? ['', ...notes] : []),
  ];
  return { lines, code: 0 };
}

async function main() {
  const notes = [];
  if (process.env.DATABASE_URL_READONLY) {
    process.env.DATABASE_URL = process.env.DATABASE_URL_READONLY;
  } else {
    notes.push('⚠️ Rodou com a credencial normal do banco (DATABASE_URL_READONLY não configurada). O script só LÊ, mas a role somente-leitura é a garantia de verdade.');
  }
  const listOps = async () => {
    const { backend } = await import('./adminEntities.js'); // só depois de escolher a URL: o pool lê process.env.DATABASE_URL
    return backend.entities.TradeOperation.list('-created_date', OPS_LIMIT);
  };
  const { lines, code } = await run({ listOps, repo: process.env.GITHUB_REPOSITORY || DEFAULT_REPO, notes });
  const text = lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`); } catch { /* o log já tem tudo */ }
  }
  process.exit(code); // o pool do banco pode segurar o processo aberto
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.log('❌ Falha inesperada. [codigo: inesperado]'); process.exit(1); });
}
