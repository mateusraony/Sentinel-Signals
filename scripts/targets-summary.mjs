#!/usr/bin/env node
// CLI do resumo do teste dos alvos — docs/known-risks.md item 281.
// Toda a lógica mora em scripts/targetsSummary.mjs (testável).
//
// Uso:
//   node scripts/targets-summary.mjs --prereg docs/experiments/targets-prereg.json \
//     --reports DIR [--controls-only] [--json saida.json]
//
// DIR tem report-<janela>-<braço>.json (o controle é o braço "atual").
// --controls-only: etapa que libera os braços no workflow — só confere os
// controles. Sai com código 1 quando não for OK (PARADO ou falha de execução):
// nenhum número de braço é impresso nesse caso.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from './backtest-correlation-check.mjs';
import { checkControls, formatControlsMarkdown, summarizeTargetsExperiment, formatTargetsMarkdown } from './targetsSummary.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[argv[i].slice(2)] = next; i += 1; } else { args[argv[i].slice(2)] = true; }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prereg || !args.reports) {
    console.error('Uso: node scripts/targets-summary.mjs --prereg FILE --reports DIR [--controls-only] [--json FILE]');
    process.exitCode = 1;
    return;
  }
  const prereg = JSON.parse(fs.readFileSync(args.prereg, 'utf8'));
  const read = (name) => {
    const file = path.join(args.reports, name);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  };
  if (args['controls-only']) {
    const check = checkControls({ prereg, controls: Object.fromEntries(prereg.windows.map((w) => [w.label, read(`report-${w.label}-atual.json`)])) });
    console.log(formatControlsMarkdown(check));
    if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(check, null, 2)}\n`);
    if (check.status !== 'OK') process.exitCode = 1;
    return;
  }
  const reports = {};
  for (const w of prereg.windows) {
    reports[w.label] = { control: read(`report-${w.label}-atual.json`), arms: {} };
    for (const a of prereg.arms) {
      const r = read(`report-${w.label}-${a.label}.json`);
      if (r) reports[w.label].arms[a.label] = r;
    }
  }
  // Semente fixa: o bootstrap do pareado (só descritivo) fica reproduzível.
  const summary = summarizeTargetsExperiment({ prereg, reports, rand: mulberry32(281) });
  console.log(formatTargetsMarkdown(summary, prereg));
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== 'OK') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
