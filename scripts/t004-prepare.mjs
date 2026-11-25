// Prepara UMA rodada do T-2026-004 (ou do T-2026-006, com --prereg) a partir do pré-registro (docs/experiments/pine-vs-producao-prereg.json): grava `pine-config-overrides.json` e escreve
// SYMBOLS/FROM/TO/TIMEFRAMES no $GITHUB_ENV. Entradas só por argumento fixo do workflow (a matriz é nossa, não digitada). Não toca rede, banco nem Telegram.
import fs from 'node:fs';
import { prepareArm } from './t004Summary.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

// `--prereg` (opcional) escolhe OUTRO pré-registro com a mesma forma (usado pelo T-2026-006); sem ele, o do T-2026-004.
const prereg = JSON.parse(fs.readFileSync(arg('prereg') || 'docs/experiments/pine-vs-producao-prereg.json', 'utf8'));
const p = prepareArm(prereg, arg('janela'), arg('braco'));
fs.writeFileSync('pine-config-overrides.json', JSON.stringify(p.pineConfig));
const lines = [`SYMBOLS=${p.symbols}`, `FROM=${p.from}`, `TO=${p.to}`, `TIMEFRAMES=${p.timeframes}`].join('\n') + '\n';
if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, lines);
console.log(`[t004] janela ${arg('janela')} (${p.from} → ${p.to}), braço ${arg('braco')}, ${p.symbols.split(',').length} moedas, chaves do braço: ${Object.keys(p.pineConfig).length}`);
