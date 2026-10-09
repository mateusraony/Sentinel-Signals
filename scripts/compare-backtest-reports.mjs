#!/usr/bin/env node
// CLI da comparação controle × variante — docs/known-risks.md item 263.
// Toda a lógica mora em scripts/compareBacktestReports.mjs (testável sem
// rodar main no carregamento — item 166).
//
// Uso:
//   node scripts/compare-backtest-reports.mjs --control A.json --variant B.json \
//     [--family-size 3] [--allow-commit-mismatch] [--iterations 5000] [--seed N] [--json saida.json]
//
// Sai com código 1 quando a comparação é recusada (relatório inválido,
// janela/símbolos/commit diferentes) — nunca imprime números nesse caso.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from './backtest-correlation-check.mjs';
import { compareReports, formatComparisonMarkdown } from './compareBacktestReports.mjs';

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
  if (!args.control || !args.variant) {
    console.error('Uso: node scripts/compare-backtest-reports.mjs --control A.json --variant B.json [--family-size N] [--allow-commit-mismatch] [--iterations N] [--seed N] [--json FILE]');
    process.exitCode = 1;
    return;
  }
  const control = JSON.parse(fs.readFileSync(args.control, 'utf8'));
  const variant = JSON.parse(fs.readFileSync(args.variant, 'utf8'));
  const familySize = args['family-size'] ? Number(args['family-size']) : 1;
  const iterations = args.iterations ? Number(args.iterations) : 5000;
  // Mesmo racional de backtest-correlation-check.mjs: sem --seed, gera um e
  // IMPRIME, para a rodada ser reproduzível sem fixar um valor para sempre.
  const seed = args.seed ? Number(args.seed) : (Date.now() >>> 0);
  const result = compareReports(control, variant, {
    familySize,
    allowCommitMismatch: args['allow-commit-mismatch'] === true,
    iterations,
    rand: mulberry32(seed),
  });
  console.log(`Seed (\`--seed ${seed}\` reproduz esta rodada exata): ${seed}`);
  console.log(formatComparisonMarkdown(result));
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify({ seed, ...result }, null, 2)}\n`);
  if (!result.comparable) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
