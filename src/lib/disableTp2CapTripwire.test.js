// docs/known-risks.md item 114 — tripwire de segurança, mesmo padrão do
// timeStopOverrideTripwire.test.js/rsiOnlyGateTripwire.test.js:
// pineConfig.disableTp2CapEnabled tem que existir SÓ em
// scripts/backtestPineConfig.js. Se essa chave algum dia aparecer como uma
// entrada de DEFAULTS/SYNCED_STRATEGY_KEYS em src/lib/pineParser.js
// (browser) ou scripts/adminPineConfig.js (cron) — os dois arquivos que
// alimentam strategyConfig/current no Firestore, gravável por qualquer
// sessão anônima (CLAUDE.md decisão item 1) — este teste falha alto e cedo,
// antes de virar um toggle de produção sem gate de revisão de código.
//
// O risco aqui é concreto: desligar o TP2 muda QUANDO uma operação real
// termina (o runner passa a correr até o trailing/Time Stop/Chop Exit em
// vez de fechar em 2×tp1R) — mudança de estratégia de saída que precisa de
// A/B real antes de cogitar produção, mesma disciplina de allowedSide/
// buyRegimeFilterEnabled/rfStructuralStopEnabled.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `:` depois do nome — bate com uma entrada de objeto real
// (`disableTp2CapEnabled: false,`), não com a menção em prosa dentro de um
// comentário explicativo (sem `:` logo em seguida).
const KEY_AS_OBJECT_ENTRY = /disableTp2CapEnabled\s*:/;

describe('disableTp2CapEnabled — tripwire de isolamento backtest-only', () => {
  it('existe como entrada real em scripts/backtestPineConfig.js (confirma que o teste sabe reconhecer o padrão)', () => {
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
});
