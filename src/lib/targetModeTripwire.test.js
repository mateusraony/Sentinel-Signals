// docs/known-risks.md item 281 — tripwire de isolamento, mesmo padrão de
// fibEntryTripwire.test.js: `targetMode`/`targetNearPolicy` têm que existir SÓ em
// scripts/backtestPineConfig.js. É chave de MEDIÇÃO (trocar só o alvo da
// operação vale alguma coisa?) — se aparecesse em src/lib/pineParser.js
// (browser) ou scripts/adminPineConfig.js (cron), o painel passaria a abrir
// operações com outro alvo. Este teste falha antes disso.
//
// Lê texto-fonte em vez de importar (adminPineConfig.js abre conexão com o
// banco no carregamento).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS = ['targetMode', 'targetNearPolicy'];
const PRODUCTION_FILES = ['./pineParser.js', '../../scripts/adminPineConfig.js'];

describe('Alvo estrutural — tripwire de isolamento backtest-only (item 281)', () => {
  it("a chave existe em scripts/backtestPineConfig.js com o valor de hoje ('r_multiple')", () => {
    const source = readFileSync(resolve(__dirname, '../../scripts/backtestPineConfig.js'), 'utf-8');
    expect(source).toMatch(/targetMode\s*:\s*'r_multiple'/);
    expect(source).toMatch(/targetNearPolicy\s*:\s*'literal'/);
  });

  for (const rel of PRODUCTION_FILES) {
    it(`NUNCA aparece em ${rel}`, () => {
      const source = readFileSync(resolve(__dirname, rel), 'utf-8');
      for (const key of KEYS) expect(source, `${rel}: ${key}`).not.toMatch(new RegExp(key));
    });
  }
});
