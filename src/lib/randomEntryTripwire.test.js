// docs/known-risks.md item 264 — tripwire de isolamento, mesmo padrão de
// rfExitCloseOnlyTripwire.test.js: as chaves da entrada aleatória
// (`randomEntryEnabled`, `randomEntrySeed`, `randomEntryProb`) têm que
// existir SÓ em scripts/backtestPineConfig.js. São chaves de MEDIÇÃO (a
// entrada da RF vale mais que entrar ao acaso?) — se uma delas aparecesse
// em src/lib/pineParser.js (browser) ou scripts/adminPineConfig.js (cron),
// o painel poderia abrir operação por sorteio. Este teste falha antes disso.
//
// Lê texto-fonte em vez de importar (adminPineConfig.js abre conexão com o
// banco no carregamento).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS = ['randomEntryEnabled', 'randomEntrySeed', 'randomEntryProb'];
// `:` depois do nome — casa com entrada de objeto real, não com menção em
// prosa num comentário.
const asObjectEntry = (key) => new RegExp(`${key}\\s*:`);
const PRODUCTION_FILES = ['./pineParser.js', '../../scripts/adminPineConfig.js'];

describe('entrada aleatória — tripwire de isolamento backtest-only (item 264)', () => {
  it('as 3 chaves existem como entrada real em scripts/backtestPineConfig.js (confirma que o teste reconhece o padrão)', () => {
    const source = readFileSync(resolve(__dirname, '../../scripts/backtestPineConfig.js'), 'utf-8');
    for (const key of KEYS) expect(source, key).toMatch(asObjectEntry(key));
  });

  for (const rel of PRODUCTION_FILES) {
    it(`NUNCA aparecem como entrada de objeto nem string de sync em ${rel}`, () => {
      const source = readFileSync(resolve(__dirname, rel), 'utf-8');
      for (const key of KEYS) {
        expect(source, `${rel}: ${key}`).not.toMatch(asObjectEntry(key));
        expect(source, `${rel}: '${key}'`).not.toMatch(new RegExp(`'${key}'`));
      }
    });
  }
});
