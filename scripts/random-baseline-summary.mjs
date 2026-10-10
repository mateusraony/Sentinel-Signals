#!/usr/bin/env node
// CLI do resumo "entrada da RF × entradas aleatórias" — docs/known-risks.md
// item 264. A lógica mora em scripts/randomBaselineSummary.mjs (testável sem
// rodar main no carregamento — item 166).
//
// Uso:
//   node scripts/random-baseline-summary.mjs --control R0.json --random-dir ./aleatorios \
//     [--expected-seeds 40] [--data-dir ./backtest-data] [--alpha 0.025] [--json saida.json]
//
// --random-dir: todos os *.json do diretório são relatórios do braço aleatório.
// --expected-seeds: exige exatamente as seeds 1..N (o workflow sempre passa).
// --data-dir: candles já baixados (SIMBOLO_4h.json) — só para o "comprar e
// segurar" descritivo; sem ele, essa linha não sai.
// Sai com código 1 quando o resumo é recusado (relatórios incomparáveis, seeds
// repetidas, poucas seeds para o limiar).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeRandomBaseline, formatRandomBaselineMarkdown } from './randomBaselineSummary.mjs';

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

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.control || !args['random-dir']) {
    console.error('Uso: node scripts/random-baseline-summary.mjs --control R0.json --random-dir DIR [--expected-seeds N] [--data-dir DIR] [--alpha 0.025] [--json FILE]');
    process.exitCode = 1;
    return;
  }
  const control = readJson(args.control);
  const randomFiles = fs.readdirSync(args['random-dir'])
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(args['random-dir'], f));
  const randoms = randomFiles.map(readJson);

  let seriesBySymbol;
  if (args['data-dir']) {
    const symbols = (control.trialArgs?.match(/(?:^|\s)--symbols\s+(\S+)/)?.[1] ?? '').split(',').filter(Boolean);
    seriesBySymbol = {};
    for (const sym of symbols) {
      const file = path.join(args['data-dir'], `${sym}_4h.json`);
      if (fs.existsSync(file)) seriesBySymbol[sym] = readJson(file);
    }
  }

  const summary = summarizeRandomBaseline(control, randoms, {
    alpha: args.alpha ? Number(args.alpha) : 0.025,
    expectedSeeds: args['expected-seeds'] ? Number(args['expected-seeds']) : undefined,
    seriesBySymbol,
  });
  console.log(formatRandomBaselineMarkdown(summary));
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.comparable) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
