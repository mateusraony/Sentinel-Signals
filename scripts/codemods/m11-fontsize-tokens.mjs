#!/usr/bin/env node
// M-11 do Raio-X de UI/UX — codemod de uma execução: substitui a classe
// arbitrária `text-[Npx]` (N em 7/8/9/10/11, os únicos 5 valores que
// existem em todo o código) pelo token nomeado equivalente `text-Npx`,
// agora definido em tailwind.config.js (theme.extend.fontSize). Renome
// puro — mesmo valor de px, sem mudança de line-height nem de qualquer
// outra propriedade. Ver docs/known-risks.md.
//
// Uso: node scripts/codemods/m11-fontsize-tokens.mjs [--write]
// Sem --write, só reporta o que seria alterado (dry run).
import fs from 'node:fs';
import { globSync } from 'glob';

const WRITE = process.argv.includes('--write');
const PATTERN = /text-\[(7|8|9|10|11)px\]/g;
const files = globSync('src/**/*.{js,jsx}', { cwd: process.cwd() });

let total = 0;
const report = [];
for (const file of files) {
  const original = fs.readFileSync(file, 'utf8');
  let count = 0;
  const next = original.replace(PATTERN, (_, n) => { count++; return `text-${n}px`; });
  if (count > 0) {
    total += count;
    report.push(`${file}: ${count}`);
    if (WRITE) fs.writeFileSync(file, next);
  }
}

report.sort((a, b) => Number(b.split(': ')[1]) - Number(a.split(': ')[1]));
console.log(report.join('\n'));
console.log(`\nTOTAL ${WRITE ? 'substituído' : 'a substituir (dry run)'}: ${total} em ${report.length} arquivo(s)`);
