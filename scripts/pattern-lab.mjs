#!/usr/bin/env node
// CLI do laboratório de padrões (fase B1) — docs/known-risks.md item 266.
// A lógica mora em scripts/patternLab.mjs (testável sem rodar main).
//
// Uso:
//   node scripts/pattern-lab.mjs [--data-dir lab-data] [--prereg docs/experiments/pattern-lab-prereg.json] \
//     [--json pattern-lab-summary.json]
//
// Lê SIMBOLO_lab.json (gerados por scripts/fetch-pattern-lab-data.mjs), roda
// descoberta + validação e grava um resumo pequeno (~15 KB). O veredito é um
// RESULTADO, não erro: "nenhum padrão" sai com código 0. Código 1 só para
// entrada faltando ou inválida.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runPatternLab, formatPatternLabMarkdown } from './patternLab.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const preregPath = args.prereg || path.join('docs', 'experiments', 'pattern-lab-prereg.json');
  const dataDir = args['data-dir'] || 'lab-data';
  const preregText = fs.readFileSync(preregPath, 'utf8');
  const prereg = JSON.parse(preregText);
  const preregSha256 = crypto.createHash('sha256').update(preregText).digest('hex');

  const datasets = [];
  for (const symbol of prereg.symbols) {
    const file = path.join(dataDir, `${symbol}_lab.json`);
    if (!fs.existsSync(file)) {
      console.error(`[pattern-lab] falta ${file} — rode scripts/fetch-pattern-lab-data.mjs antes`);
      process.exitCode = 1;
      return;
    }
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    datasets.push({ symbol, bars: d.bars });
  }

  const result = runPatternLab(datasets, prereg);
  const commitSha = process.env.GITHUB_SHA || null;
  const summary = {
    lab: prereg.name,
    item: prereg.item,
    preregSha256,
    commitSha,
    runId: process.env.GITHUB_RUN_ID || null,
    ...result,
  };
  console.log(formatPatternLabMarkdown(result, { preregSha256, commitSha }));
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
