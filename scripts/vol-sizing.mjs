#!/usr/bin/env node
// Tamanho pela volatilidade — docs/known-risks.md item 269. CLI fina; a parte
// pura é scripts/volSizing.mjs.
//
// Uma janela (roda no job de resumo do backtest-random-baseline.yml):
//   node scripts/vol-sizing.mjs --reports DIR --candles DIR --json saida.json
// Veredito final, juntando as duas janelas (roda na sessão):
//   node scripts/vol-sizing.mjs --combine W1.json W2.json [--json final.json]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runVolSizingWindow, combineWindows, formatWindowMarkdown, formatCombinedMarkdown } from './volSizing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREREG_PATH = path.resolve(__dirname, '../docs/experiments/vol-sizing-prereg.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (key === 'combine') { args.combine = true; continue; }
      args[key] = next; i += 1;
    } else args._.push(argv[i]);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const preregRaw = fs.readFileSync(PREREG_PATH, 'utf8');
  const prereg = JSON.parse(preregRaw);
  const preregSha256 = crypto.createHash('sha256').update(preregRaw).digest('hex');

  if (args.combine) {
    const result = combineWindows(args._.map(readJson), prereg, { preregSha256 });
    console.log(formatCombinedMarkdown(result));
    if (args.json) fs.writeFileSync(args.json, `${JSON.stringify({ lab: prereg.name, preregSha256, ...result }, null, 2)}\n`);
    if (result.verdict === 'INCOMPLETE') process.exitCode = 1;
    return;
  }

  if (!args.reports || !args.candles) {
    console.error('Uso: node scripts/vol-sizing.mjs --reports DIR --candles DIR [--json FILE]  |  --combine W1.json W2.json [--json FILE]');
    process.exitCode = 1;
    return;
  }
  const files = fs.readdirSync(args.reports).filter((f) => /^report-.*\.json$/.test(f)).sort();
  const controlFile = files.find((f) => f === 'report-R0.json');
  const control = controlFile ? readJson(path.join(args.reports, controlFile)) : null;
  const randoms = files.filter((f) => f !== 'report-R0.json').map((f) => readJson(path.join(args.reports, f)));
  const candlesBySymbol = {};
  for (const s of prereg.symbols) {
    const file = path.join(args.candles, `${s}_1d.json`);
    if (fs.existsSync(file)) candlesBySymbol[s] = readJson(file);
  }
  const result = control
    ? runVolSizingWindow({ control, randoms, candlesBySymbol, prereg })
    : { verdict: 'INCOMPLETE', errors: ['report-R0.json não encontrado'], window: null };
  console.log(formatWindowMarkdown(result));
  const out = {
    lab: prereg.name,
    preregSha256,
    commitSha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    ...result,
  };
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(out, null, 2)}\n`);
  if (result.verdict === 'INCOMPLETE') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
