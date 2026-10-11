#!/usr/bin/env node
// CLI do teste de tendência semanal — docs/known-risks.md item 268.
// A lógica mora em scripts/weeklyTrend.mjs (testável sem rodar main).
//
// Uso:
//   node scripts/weekly-trend.mjs [--data-dir candles] [--prereg docs/experiments/weekly-trend-prereg.json] \
//     [--json weekly-trend-summary.json]
//
// Lê SIMBOLO_1d.json (gerados por scripts/fetch-backtest-data.mjs). O
// veredito é um RESULTADO: "não achei" sai com código 0. Código 1 para entrada
// faltando e para INCOMPLETE (faltou dado — o job tem que aparecer vermelho;
// o resumo é gravado antes, para dar para ver o que faltou).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runWeeklyTrend, formatWeeklyTrendMarkdown } from './weeklyTrend.mjs';

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
  const preregPath = args.prereg || path.join('docs', 'experiments', 'weekly-trend-prereg.json');
  const dataDir = args['data-dir'] || 'candles';
  const preregText = fs.readFileSync(preregPath, 'utf8');
  const prereg = JSON.parse(preregText);
  const preregSha256 = crypto.createHash('sha256').update(preregText).digest('hex');

  const dailyBySymbol = {};
  for (const symbol of [...prereg.primarySymbols, ...prereg.descriptiveSymbols]) {
    const file = path.join(dataDir, `${symbol}_1d.json`);
    if (fs.existsSync(file)) dailyBySymbol[symbol] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  const result = runWeeklyTrend(dailyBySymbol, prereg);
  const commitSha = process.env.GITHUB_SHA || null;
  const summary = { lab: prereg.name, item: prereg.item, preregSha256, commitSha, runId: process.env.GITHUB_RUN_ID || null, ...result };
  console.log(formatWeeklyTrendMarkdown(result));
  console.log(`\nPré-registro sha256 ${preregSha256.slice(0, 12)}…${commitSha ? ` · commit ${commitSha.slice(0, 7)}` : ''}`);
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(summary, null, 2)}\n`);
  if (result.verdict === 'INCOMPLETE') {
    console.error(`[weekly-trend] INCOMPLETE: ${result.untested.join('; ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
