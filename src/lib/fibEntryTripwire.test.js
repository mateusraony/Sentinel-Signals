// docs/known-risks.md item 267 — tripwire de isolamento, mesmo padrão de
// randomEntryTripwire.test.js: `fibEntryEnabled` tem que existir SÓ em
// scripts/backtestPineConfig.js. É chave de MEDIÇÃO (a entrada/saída por
// Fibonacci no 15m vale alguma coisa?) — se aparecesse em
// src/lib/pineParser.js (browser) ou scripts/adminPineConfig.js (cron), o
// painel passaria a abrir e gerir operações por essa regra. Este teste falha
// antes disso.
//
// Lê texto-fonte em vez de importar (adminPineConfig.js abre conexão com o
// banco no carregamento).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS = ['fibEntryEnabled'];
const asObjectEntry = (key) => new RegExp(`${key}\\s*:`);
const PRODUCTION_FILES = ['./pineParser.js', '../../scripts/adminPineConfig.js'];

describe('Fibonacci 15m — tripwire de isolamento backtest-only (item 267)', () => {
  it('a chave existe como entrada real em scripts/backtestPineConfig.js, desligada (confirma que o teste reconhece o padrão)', () => {
    const source = readFileSync(resolve(__dirname, '../../scripts/backtestPineConfig.js'), 'utf-8');
    for (const key of KEYS) expect(source, key).toMatch(new RegExp(`${key}\\s*:\\s*false`));
  });

  for (const rel of PRODUCTION_FILES) {
    it(`NUNCA aparece como entrada de objeto nem string de sync em ${rel}`, () => {
      const source = readFileSync(resolve(__dirname, rel), 'utf-8');
      for (const key of KEYS) {
        expect(source, `${rel}: ${key}`).not.toMatch(asObjectEntry(key));
        expect(source, `${rel}: '${key}'`).not.toMatch(new RegExp(`'${key}'`));
      }
    });
  }
});
