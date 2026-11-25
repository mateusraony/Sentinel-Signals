// Confere que o relatório de uma rodada do T-2026-004 USOU a configuração do braço (o erro de 25/11/2026: campo de overrides vazio, item 308 addendum 2).
// Uso: node scripts/t004-verify-config.mjs --report backtest-report.json --expect pine-config-overrides.json. Sai com código 1 se houver divergência. Só lê arquivos.
import fs from 'node:fs';
import { configMismatches } from './backtest-trial-registry.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const report = JSON.parse(fs.readFileSync(arg('report'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(arg('expect'), 'utf8'));
const bad = configMismatches(report, expected);
if (bad.length) {
  console.error(`::error::O relatório NÃO usou a configuração do braço (${bad.length} chave(s)): ${bad.map((b) => `${b.key}: esperado ${JSON.stringify(b.expected)}, usou ${JSON.stringify(b.actual)}`).join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`[t004] configuração conferida: as ${Object.keys(expected).length} chaves do braço estão no relatório.`);
}
