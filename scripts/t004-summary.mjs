// Resumo final do T-2026-004: lê os 4 relatórios (artefatos baixados em DIR/t004-W1-A, t004-W1-B, t004-W2-A, t004-W2-B) e aplica a regra pré-registrada.
// Uso: node scripts/t004-summary.mjs --dir reports [--json saida.json]. Escreve o texto (markdown) na saída padrão. Só lê arquivos.
import fs from 'node:fs';
import path from 'node:path';
import { summarize } from './t004Summary.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const dir = arg('dir') || 'reports';
const read = (id) => JSON.parse(fs.readFileSync(path.join(dir, `t004-${id}`, 'backtest-report.json'), 'utf8'));
const reports = { W1: { A: read('W1-A'), B: read('W1-B') }, W2: { A: read('W2-A'), B: read('W2-B') } };
const out = summarize(reports);
console.log(out.markdown);
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify({ verdict: out.verdict, windows: out.windows.map(({ label, a, b, diff, se, ci95, paired }) => ({ label, a, b, diff, se, ci95, paired })) }, null, 1));
