// Resumo final do T-2026-006 (só o trailing): lê os 8 relatórios (artefatos em DIR/t006-<janela>-<braço>/backtest-report.json) e aplica a regra pré-registrada.
// Uso: node scripts/t006-summary.mjs --dir reports [--json saida.json]. Texto (markdown) na saída padrão. Só lê arquivos.
import fs from 'node:fs';
import path from 'node:path';
import { summarizeT006 } from './t006Summary.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const prereg = JSON.parse(fs.readFileSync('docs/experiments/t006-trailing-prereg.json', 'utf8'));
const dir = arg('dir') || 'reports';
const read = (janela, braco) => JSON.parse(fs.readFileSync(path.join(dir, `t006-${janela}-${braco}`, 'backtest-report.json'), 'utf8'));
const reports = {};
for (const w of prereg.windows) {
  reports[w.label] = Object.fromEntries(Object.keys(prereg.arms).map((braco) => [braco, read(w.label, braco)]));
}
const out = summarizeT006(reports, prereg.reproducao_esperada_do_t004);
console.log(out.markdown);
if (arg('json')) {
  fs.writeFileSync(arg('json'), JSON.stringify({ verdict: out.verdict, reproduction: out.reproduction, windows: out.windows.map(({ label, primario, espelho, pares, sd }) => ({ label, primario, espelho, pares, sd })) }, null, 1));
}
