#!/usr/bin/env node
// Análise PRÉ-REGISTRADA (docs/known-risks.md, item 256, addendum "Pré-registro
// H1/H2") das duas hipóteses levantadas olhando o backtest `Teste_05102026`:
//   H1 — volume: R médio é MAIOR quando `volume_above_ma` é verdadeiro.
//   H2 — chop:   R CAI conforme `chop_value` sobe (inclinação < 0).
// Este arquivo é a análise FIXA: foi escrito e mesclado ANTES de rodar o backtest
// out-of-time (2024-10-05 → 2025-10-05). Qualquer mudança aqui depois de ver o
// relatório novo invalida o pré-registro (o histórico do git é a prova).
//
// Entrada: o `backtest-report.json` (campo `indicatorAttribution.records`).
// Método: regressão de R sobre o regressor (indicador 0/1 em H1; chop contínuo
// em H2) com erro-padrão robusto a agrupamento (CR1) e t de Student com G−1 gl.
// "Confirmada" = IC95 bicaulal exclui zero NA DIREÇÃO PREVISTA (= unilateral
// α=0,025 por hipótese, já com Bonferroni m=2), nas DUAS partições de cluster
// (semana ISO e símbolo×mês), com G ≥ 20 e n ≥ 300. Nada além disso conta.
//
// Uso:  node scripts/analyze-preregistered-volume-chop.mjs <report.json> [--json] [--unofficial]
//   (--unofficial só para referência: analisa mesmo com metadados divergentes e marca NÃO OFICIAL)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { studentTCritical95 } from './backtest-correlation-check.mjs';

// O ÚNICO run que vale como teste: qualquer outro relatório (descoberta, outras datas/ativos/config)
// é rejeitado ANTES de qualquer cálculo (Codex, PR #469) — sem isso o script poderia imprimir um
// "CONFIRMADA" de aparência oficial sobre dado que nunca foi o pré-registrado.
export const PREREG_RUN = Object.freeze({
  from: '2024-10-05',
  to: '2025-10-05',
  trialLabel: 'PreReg_VolChop_OOT_20241005',
  configHash: '8334c2d471fb771d',
  symbols: Object.freeze(['BTCUSDT', 'ETHUSDT', 'FETUSDT', 'PENDLEUSDT', 'ZROUSDT', 'DYDXUSDT', 'PAXGUSDT']),
});

export const PREREG = Object.freeze({
  minRecords: 300,
  minClusters: 20,
  // IC bicaulal 95% (alpha=0,05 em studentTCritical95) == unilateral 0,025 por hipótese.
  alphaTwoSided: 0.05,
  clusterings: Object.freeze(['week', 'symbolMonth']),
});

// Semana ISO-8601 (UTC) como "AAAA-Www".
export function isoWeekKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Só registros com R finito, `volume_above_ma` booleano e `chop_value` finito
// (dado ausente fica de fora e é CONTADO — nunca vira 0).
export function extractRecords(report) {
  const raw = report?.indicatorAttribution?.records ?? [];
  const out = [];
  let dropped = 0;
  for (const rec of raw) {
    const r = rec?.outcome?.rResult;
    const s = rec?.snapshot;
    if (!Number.isFinite(r) || !s || typeof s.volume_above_ma !== 'boolean' || !Number.isFinite(s.chop_value)) {
      dropped += 1;
      continue;
    }
    const week = isoWeekKey(s.candle_time);
    if (week === null) { dropped += 1; continue; }
    out.push({
      r,
      volume: s.volume_above_ma ? 1 : 0,
      chop: s.chop_value,
      week,
      symbolMonth: `${s.symbol}|${String(s.candle_time).slice(0, 7)}`,
    });
  }
  return { records: out, dropped, total: raw.length };
}

// OLS de y sobre x (com intercepto) e erro-padrão da inclinação robusto a
// cluster (CR1: G/(G−1) · (n−1)/(n−2)). Devolve null se não estimável.
export function slopeClusterRobust(x, y, clusterKeys) {
  const n = x.length;
  if (n < 3 || y.length !== n || clusterKeys.length !== n) return null;
  const xb = x.reduce((a, v) => a + v, 0) / n;
  const yb = y.reduce((a, v) => a + v, 0) / n;
  const sxx = x.reduce((a, v) => a + (v - xb) ** 2, 0);
  if (!(sxx > 0)) return null;
  const slope = x.reduce((a, v, i) => a + (v - xb) * (y[i] - yb), 0) / sxx;
  const intercept = yb - slope * xb;
  const sums = new Map();
  for (let i = 0; i < n; i += 1) {
    const e = y[i] - intercept - slope * x[i];
    sums.set(clusterKeys[i], (sums.get(clusterKeys[i]) ?? 0) + (x[i] - xb) * e);
  }
  const G = sums.size;
  if (G < 2) return null;
  let sq = 0;
  for (const v of sums.values()) sq += v * v;
  const variance = (sq / sxx ** 2) * (G / (G - 1)) * ((n - 1) / (n - 2));
  const se = Math.sqrt(variance);
  const crit = studentTCritical95(G - 1, PREREG.alphaTwoSided);
  return { n, G, slope, se, t: se > 0 ? slope / se : null, crit, lower: slope - crit * se, upper: slope + crit * se };
}

// direção prevista: +1 (H1, IC acima de zero) ou −1 (H2, IC abaixo de zero).
function specConfirmed(res, direction) {
  if (!res) return false;
  if (res.G < PREREG.minClusters) return false;
  return direction > 0 ? res.lower > 0 : res.upper < 0;
}

export function evaluateHypothesis(records, { regressor, direction }) {
  const x = records.map((rec) => rec[regressor]);
  const y = records.map((rec) => rec.r);
  const specs = {};
  for (const clustering of PREREG.clusterings) {
    specs[clustering] = slopeClusterRobust(x, y, records.map((rec) => rec[clustering]));
  }
  const reliable = records.length >= PREREG.minRecords
    && PREREG.clusterings.every((c) => specs[c] && specs[c].G >= PREREG.minClusters);
  const confirmed = PREREG.clusterings.map((c) => specConfirmed(specs[c], direction));
  return { regressor, direction, n: records.length, reliable, specs, verdict: verdictFrom(reliable, confirmed) };
}

// Regra de decisão fixa: amostra insuficiente → inconclusiva; as DUAS partições
// confirmam → confirmada; só uma confirma → divergente (NÃO conta como confirmada).
export function verdictFrom(reliable, confirmedFlags) {
  if (!reliable) return 'INCONCLUSIVA_AMOSTRA';
  if (confirmedFlags.every(Boolean)) return 'CONFIRMADA';
  if (confirmedFlags.some(Boolean)) return 'DIVERGENTE_NAO_CONFIRMADA';
  return 'NAO_CONFIRMADA';
}

// Símbolos do run, lidos de `trialArgs` ("--symbols A,B,C --from ...").
function symbolsFromTrialArgs(trialArgs) {
  const m = /--symbols\s+(\S+)/.exec(String(trialArgs ?? ''));
  return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : null;
}

// Devolve a lista de divergências entre o relatório e o run pré-registrado (vazia = confere).
export function validateReportMetadata(report) {
  const problems = [];
  const day = (v) => (typeof v === 'string' ? v.slice(0, 10) : null);
  if (day(report?.range?.from) !== PREREG_RUN.from) problems.push(`range.from=${report?.range?.from ?? 'ausente'} (esperado ${PREREG_RUN.from})`);
  if (day(report?.range?.to) !== PREREG_RUN.to) problems.push(`range.to=${report?.range?.to ?? 'ausente'} (esperado ${PREREG_RUN.to})`);
  if (report?.trialLabel !== PREREG_RUN.trialLabel) problems.push(`trialLabel=${report?.trialLabel ?? 'ausente'} (esperado ${PREREG_RUN.trialLabel})`);
  if (report?.reproducibility?.configHash !== PREREG_RUN.configHash) problems.push(`configHash=${report?.reproducibility?.configHash ?? 'ausente'} (esperado ${PREREG_RUN.configHash})`);
  const symbols = symbolsFromTrialArgs(report?.trialArgs);
  if (!symbols) problems.push('símbolos não encontrados em trialArgs');
  else if (symbols.length !== PREREG_RUN.symbols.length || !PREREG_RUN.symbols.every((x) => symbols.includes(x))) {
    problems.push(`símbolos=${symbols.join(',')} (esperado ${PREREG_RUN.symbols.join(',')})`);
  }
  return problems;
}

// `enforceMetadata` (padrão true): relatório que não é o do pré-registro NÃO é analisado
// (status RELATORIO_INVALIDO). `false` só para desenvolvimento/referência e marca o resultado
// como NÃO OFICIAL — nunca vale como confirmação.
export function analyzeReport(report, { enforceMetadata = true } = {}) {
  const problems = validateReportMetadata(report);
  if (enforceMetadata && problems.length > 0) {
    return { official: false, status: 'RELATORIO_INVALIDO', problems };
  }
  const { records, dropped, total } = extractRecords(report);
  return {
    official: problems.length === 0,
    status: problems.length === 0 ? 'OFICIAL' : 'NAO_OFICIAL_METADADOS_NAO_CONFEREM',
    problems,
    totalRecords: total,
    usedRecords: records.length,
    droppedRecords: dropped,
    H1_volume: evaluateHypothesis(records, { regressor: 'volume', direction: +1 }),
    H2_chop: evaluateHypothesis(records, { regressor: 'chop', direction: -1 }),
  };
}

const fmt = (v, d = 3) => (v === null || v === undefined ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d));

export function formatText(result) {
  if (result.status === 'RELATORIO_INVALIDO') {
    return ['RELATÓRIO REJEITADO — não é o run do pré-registro; nenhuma hipótese foi calculada.',
      ...result.problems.map((p) => `  - ${p}`)].join('\n');
  }
  const lines = [];
  if (!result.official) {
    lines.push('*** NÃO OFICIAL — os metadados do relatório NÃO conferem com o pré-registro; vale só como referência, nunca como confirmação ***');
    for (const p of result.problems) lines.push(`  - ${p}`);
    lines.push('');
  }
  lines.push('ANÁLISE PRÉ-REGISTRADA — H1 (volume) e H2 (chop)  [veredito primeiro, números depois]');
  lines.push(`Registros: ${result.usedRecords} usados de ${result.totalRecords} (${result.droppedRecords} descartados por dado ausente)`);
  lines.push('');
  for (const [name, h] of [['H1 volume (R maior com volume acima da média; IC95 > 0)', result.H1_volume], ['H2 chop (R cai com o Chop; IC95 < 0)', result.H2_chop]]) {
    lines.push(`${name}\n  VEREDITO: ${h.verdict}${h.reliable ? '' : '  (n<300 ou G<20 em alguma partição)'}`);
    for (const c of PREREG.clusterings) {
      const s = h.specs[c];
      lines.push(s
        ? `  cluster=${c.padEnd(11)} G=${String(s.G).padStart(3)} inclinação=${fmt(s.slope)} IC95=[${fmt(s.lower)}; ${fmt(s.upper)}]`
        : `  cluster=${c.padEnd(11)} não estimável`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Uso: node scripts/analyze-preregistered-volume-chop.mjs <report.json> [--json]');
    process.exit(2);
  }
  const result = analyzeReport(JSON.parse(fs.readFileSync(file, 'utf8')), { enforceMetadata: !args.includes('--unofficial') });
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : formatText(result));
}
