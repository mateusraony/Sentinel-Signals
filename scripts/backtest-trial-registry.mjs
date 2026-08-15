#!/usr/bin/env node
// Registro append-only de trials de backtest, com correção Bonferroni por
// família de hipótese (docs/known-risks.md item 89).
//
// Problema que isto resolve: cada vez que o projeto já aplicou correção de
// comparação múltipla (itens 45.9/56/68), o N da família foi decidido à mão
// por um humano lendo known-risks.md, e uma vez (item 68) a correção foi
// simplesmente esquecida na primeira versão do relatório — só apareceu numa
// review externa depois. Este script não decide o que conta como "mesma
// família" (isso continua sendo julgamento humano, registrado no --family),
// mas garante que, uma vez decidida a família, a matemática da correção
// nunca fica de fora.
//
// Uso:
//   node scripts/backtest-trial-registry.mjs --report <path> --family <nome>
//   node scripts/backtest-trial-registry.mjs --summarize-family <nome>
//
// O relatório (--report) é o backtest-report.json que sai de backtest.yml /
// npm run backtest — precisa ter report.trialLabel preenchido (o workflow já
// torna trial_label obrigatório) e report.costs (Fase 5, sempre presente).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY_PATH = path.join(process.cwd(), 'docs', 'backtest-trial-registry.json');

// Aproximação racional de Peter Acklam para a inversa da CDF normal padrão
// (erro relativo < 1.15e-9) — http://home.online.no/~pjacklam/notes/invnorm/.
// Evita puxar uma lib de estatística nova só para uma função; testada contra
// quantis conhecidos em backtest-trial-registry.test.mjs.
export function inverseNormalCDF(p) {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`inverseNormalCDF: p deve estar em (0,1), recebeu ${p}`);
  }
  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// z bicaudal de Bonferroni para uma família de `familySize` comparações sob
// alpha=0.05 (o mesmo alpha usado em todo o resto do projeto — ver
// src/lib/tradeMetrics.js). familySize=1 devolve exatamente 1.959964 (o
// 1.96 já usado em summarizeOps), então a correção é uma extensão, não uma
// mudança de comportamento para famílias de tamanho 1.
export function bonferroniZ(familySize, alpha = 0.05) {
  if (!Number.isInteger(familySize) || familySize < 1) {
    throw new RangeError(`bonferroniZ: familySize deve ser inteiro >= 1, recebeu ${familySize}`);
  }
  const adjustedAlpha = alpha / familySize;
  return inverseNormalCDF(1 - adjustedAlpha / 2);
}

// Mesmo cálculo de src/lib/tradeMetrics.js:expectancyCIAtZ, duplicado aqui de
// propósito (é uma linha de matemática pura) para este script não depender
// do pipeline de bundle do backtest (build-backtest.mjs) só para uma
// ferramenta de relatório.
export function ciAtZ(expectancyR, expectancyRStdErr, z) {
  if (expectancyR === null || expectancyRStdErr === null) return null;
  return [expectancyR - z * expectancyRStdErr, expectancyR + z * expectancyRStdErr];
}

// report.costs expõe expectancyRCI95 (z=1.96) mas não o stdErr bruto —
// recupera o stdErr a partir do IC95 já publicado em vez de recalcular a
// partir das operações (o relatório não inclui a lista de R por operação).
export function stdErrFromCI95(ci95) {
  if (!ci95) return null;
  const Z95 = 1.959963984540054; // inverseNormalCDF(0.975), mesma constante usada acima
  return (ci95[1] - ci95[0]) / (2 * Z95);
}

export function recordFromReport(report, family) {
  if (!report.trialLabel) {
    throw new Error('report.trialLabel ausente — backtest.yml exige trial_label; relatório parece incompleto.');
  }
  const costs = report.costs || {};
  const expectancyR = costs.netExpectancyR ?? null;
  return {
    family,
    trialLabel: report.trialLabel,
    recordedAt: new Date().toISOString(),
    runStartedAt: report.reproducibility?.runStartedAt ?? null,
    commitSha: report.reproducibility?.commitSha ?? null,
    configHash: report.reproducibility?.configHash ?? null,
    pineConfigOverride: report.reproducibility?.pineConfig ?? null,
    n: costs.countedTrades ?? null,
    minTrades: costs.minTrades ?? null,
    expectancyR,
    expectancyRStdErr: stdErrFromCI95(costs.expectancyRCI95),
    expectancyRCI95: costs.expectancyRCI95 ?? null,
    conclusiveAtN1: costs.conclusive ?? null,
  };
}

export function loadRegistry(registryPath = REGISTRY_PATH) {
  if (!fs.existsSync(registryPath)) return [];
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}

function saveRegistry(records, registryPath = REGISTRY_PATH) {
  fs.writeFileSync(registryPath, `${JSON.stringify(records, null, 2)}\n`);
}

export function appendTrial(reportPath, family, registryPath = REGISTRY_PATH) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const record = recordFromReport(report, family);
  const registry = loadRegistry(registryPath);
  if (registry.some((r) => r.trialLabel === record.trialLabel && r.family === family)) {
    throw new Error(
      `Já existe registro para trialLabel="${record.trialLabel}" na família "${family}" — `
      + 'evita duplicar (apague manualmente do JSON se for reprocessamento intencional).',
    );
  }
  registry.push(record);
  saveRegistry(registry, registryPath);
  return record;
}

export function summarizeFamily(family, registryPath = REGISTRY_PATH) {
  const registry = loadRegistry(registryPath).filter((r) => r.family === family);
  if (registry.length === 0) {
    return { family, n: 0, rows: [], markdown: `Nenhum trial registrado na família "${family}".` };
  }
  const familySize = registry.length;
  const z = bonferroniZ(familySize);
  const fmt = (v) => (v === null || v === undefined ? '—' : v.toFixed(3));
  const fmtCI = (ci) => (ci ? `[${fmt(ci[0])}, ${fmt(ci[1])}]` : '—');
  const rows = registry.map((r) => {
    const correctedCI = ciAtZ(r.expectancyR, r.expectancyRStdErr, z);
    const correctedConclusive = correctedCI ? !(correctedCI[0] <= 0 && correctedCI[1] >= 0) : null;
    return { ...r, correctedCI, correctedConclusive };
  });
  const lines = [
    '',
    `## Família "${family}" — N=${familySize} trials, correção Bonferroni (alpha=0.05/${familySize}, z=${z.toFixed(4)})`,
    '',
    '| trial_label | n | expectancyR | IC95 original (z=1.96) | IC corrigido (família) | conclusivo corrigido? |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.trialLabel} | ${r.n ?? '—'} | ${fmt(r.expectancyR)} | ${fmtCI(r.expectancyRCI95)} | ${fmtCI(r.correctedCI)} | ${r.correctedConclusive === null ? '—' : (r.correctedConclusive ? 'SIM' : 'não')} |`),
    '',
  ];
  return { family, n: familySize, z, rows, markdown: lines.join('\n') };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['summarize-family']) {
    const { markdown } = summarizeFamily(args['summarize-family']);
    console.log(markdown);
    return;
  }
  if (args.report && args.family) {
    const record = appendTrial(args.report, args.family);
    console.log(`[registry] adicionado: família="${record.family}" label="${record.trialLabel}" n=${record.n} expectancyR=${record.expectancyR?.toFixed(4) ?? '—'}`);
    return;
  }
  console.error(
    'Uso:\n'
    + '  node scripts/backtest-trial-registry.mjs --report <path> --family <nome>\n'
    + '  node scripts/backtest-trial-registry.mjs --summarize-family <nome>',
  );
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
