// docs/known-risks.md item 133 — tripwire de isolamento, mesmo padrão do
// timeStopOverrideTripwire.test.js: `pineConfig.maxConcurrentSameSideOps`
// tem que existir SÓ em scripts/backtestPineConfig.js. Se essa chave um dia
// aparecer como entrada de DEFAULTS/SYNCED_STRATEGY_KEYS em
// src/lib/pineParser.js (browser) ou scripts/adminPineConfig.js (cron) —
// os dois que alimentam strategyConfig/current no Firestore, gravável por
// QUALQUER sessão anônima (CLAUDE.md decisão 1) — este teste falha alto e
// cedo, antes de virar toggle de produção sem gate de revisão.
//
// Aqui o risco é concreto: um teto de exposição é controle de RISCO de
// carteira. Vindo de config viva, qualquer um com a URL poderia zerá-lo
// (liberando exposição sem limite) ou baixá-lo a 1 (travando entradas
// novas) sem nenhuma medição por trás — e o mecanismo ainda é HIPÓTESE não
// medida, não uma melhoria confirmada.
//
// Lê texto-fonte em vez de importar: adminPineConfig.js inicializa
// firebase-admin no top-level (precisa de FIREBASE_SERVICE_ACCOUNT_JSON,
// ausente no ambiente de teste).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `:` depois do nome — casa com entrada de objeto real
// (`maxConcurrentSameSideOps: null,`), não com a menção em prosa dentro de
// um comentário explicativo.
const KEY_AS_OBJECT_ENTRY = /maxConcurrentSameSideOps\s*:/;

describe('maxConcurrentSameSideOps — tripwire de isolamento backtest-only', () => {
  it('existe como entrada real em scripts/backtestPineConfig.js (confirma que o teste reconhece o padrão)', () => {
    const source = readFileSync(resolve(__dirname, '../../scripts/backtestPineConfig.js'), 'utf-8');
    expect(source).toMatch(KEY_AS_OBJECT_ENTRY);
  });

  it('NUNCA aparece como entrada de objeto em src/lib/pineParser.js (browser, strategyConfig/current)', () => {
    const source = readFileSync(resolve(__dirname, './pineParser.js'), 'utf-8');
    expect(source).not.toMatch(KEY_AS_OBJECT_ENTRY);
  });

  it('NUNCA aparece como entrada de objeto em scripts/adminPineConfig.js (cron, strategyConfig/current)', () => {
    const source = readFileSync(resolve(__dirname, '../../scripts/adminPineConfig.js'), 'utf-8');
    expect(source).not.toMatch(KEY_AS_OBJECT_ENTRY);
  });

  it('NÃO está em nenhuma lista de sync (SYNCED_STRATEGY_KEYS) dos dois arquivos de produção', () => {
    for (const rel of ['./pineParser.js', '../../scripts/adminPineConfig.js']) {
      const source = readFileSync(resolve(__dirname, rel), 'utf-8');
      expect(source, `${rel} não pode citar a chave como string de sync`)
        .not.toMatch(/'maxConcurrentSameSideOps'/);
    }
  });
});
