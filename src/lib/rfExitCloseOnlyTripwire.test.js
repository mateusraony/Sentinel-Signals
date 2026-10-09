// docs/known-risks.md item 263 — tripwire de isolamento, mesmo padrão de
// portfolioSideCapTripwire.test.js: `pineConfig.rfExitCloseOnlyEnabled` tem
// que existir SÓ em scripts/backtestPineConfig.js. É uma chave de MEDIÇÃO
// (quanto a saída por RF no estilo do Pine real muda o resultado), não uma
// mudança aprovada de estratégia. Se ela aparecer como entrada de DEFAULTS/
// SYNCED_STRATEGY_KEYS em src/lib/pineParser.js (browser) ou
// scripts/adminPineConfig.js (cron) — os dois que alimentam a config viva —
// viraria um toggle de produção sem decisão nem medição por trás; este teste
// falha antes disso.
//
// Lê texto-fonte em vez de importar (adminPineConfig.js abre conexão com o
// banco no carregamento).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `:` depois do nome — casa com entrada de objeto real, não com menção em
// prosa num comentário.
const KEY_AS_OBJECT_ENTRY = /rfExitCloseOnlyEnabled\s*:/;

describe('rfExitCloseOnlyEnabled — tripwire de isolamento backtest-only (item 263)', () => {
  it('existe como entrada real em scripts/backtestPineConfig.js (confirma que o teste reconhece o padrão)', () => {
    const source = readFileSync(resolve(__dirname, '../../scripts/backtestPineConfig.js'), 'utf-8');
    expect(source).toMatch(KEY_AS_OBJECT_ENTRY);
  });

  it('NUNCA aparece como entrada de objeto em src/lib/pineParser.js (browser, config viva)', () => {
    const source = readFileSync(resolve(__dirname, './pineParser.js'), 'utf-8');
    expect(source).not.toMatch(KEY_AS_OBJECT_ENTRY);
  });

  it('NUNCA aparece como entrada de objeto em scripts/adminPineConfig.js (cron, config viva)', () => {
    const source = readFileSync(resolve(__dirname, '../../scripts/adminPineConfig.js'), 'utf-8');
    expect(source).not.toMatch(KEY_AS_OBJECT_ENTRY);
  });

  it('NÃO está em nenhuma lista de sync dos dois arquivos de produção', () => {
    for (const rel of ['./pineParser.js', '../../scripts/adminPineConfig.js']) {
      const source = readFileSync(resolve(__dirname, rel), 'utf-8');
      expect(source, `${rel} não pode citar a chave como string de sync`).not.toMatch(/'rfExitCloseOnlyEnabled'/);
    }
  });
});
