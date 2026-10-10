#!/usr/bin/env node
// CLI da comparação pareada "saídas por Fibonacci × saídas atuais" —
// docs/known-risks.md item 267. A lógica mora em scripts/compareRandomBaselines.mjs.
//
// Uso:
//   node scripts/compare-random-baselines.mjs --current resumo-atual.json --fib resumo-fib.json [--json saida.json]
//
// Os dois arquivos são o `random-baseline-summary.json` (artifact resumo-*)
// de duas rodadas do workflow "Backtest — referência de entrada aleatória",
// mesma janela e mesmo commit: uma sem e outra com "Fibonacci 15m" marcado.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareRandomBaselines, formatComparisonMarkdown } from './compareRandomBaselines.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.current || !args.fib) {
    console.error('uso: --current resumo-sem-fib.json --fib resumo-com-fib.json [--json saida.json]');
    process.exitCode = 1;
    return;
  }
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const result = compareRandomBaselines(read(args.current), read(args.fib));
  console.log(formatComparisonMarkdown(result));
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`);
  if (!result.comparable) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
