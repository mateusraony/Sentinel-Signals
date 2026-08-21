// docs/known-risks.md item 111 — tripwire de segurança, mesmo padrão do
// rf1hUncondTripwire.test.js: pineConfig.rsiOnlyGateEnabled tem que existir
// SÓ em scripts/backtestPineConfig.js. Se essa chave algum dia aparecer como
// entrada de DEFAULTS/SYNCED_STRATEGY_KEYS em src/lib/pineParser.js (browser)
// ou scripts/adminPineConfig.js (cron) — os dois arquivos que alimentam
// strategyConfig/current no Firestore, gravável por qualquer sessão anônima
// (CLAUDE.md decisão item 1) — este teste falha alto e cedo, antes de virar
// um toggle de produção sem gate de revisão de código.
//
// O risco é concreto: isso substitui inteiramente o gate de score (o
// mecanismo de confluência que existe desde o início do projeto) por um
// único componente, com base num indício (não prova) de mineração
// exploratória — exatamente o tipo de mudança de ESTRATÉGIA que exige A/B
// real antes de cogitar produção, mesmo padrão do allowedSide/
// buyRegimeFilterEnabled.
//
// Lê o texto-fonte em vez de importar os módulos: adminPineConfig.js
// inicializa firebase-admin no top-level do arquivo (precisa de
// FIREBASE_SERVICE_ACCOUNT_JSON, ausente no ambiente de teste) — importar
// quebraria por um motivo não relacionado a este teste.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `:` depois do nome — bate com uma entrada de objeto real
// (`rsiOnlyGateEnabled: false,`), não com a menção em prosa dentro de um
// comentário explicativo (sem `:` logo em seguida).
const KEY_AS_OBJECT_ENTRY = /rsiOnlyGateEnabled\s*:/;

describe('rsiOnlyGateEnabled — tripwire de isolamento backtest-only', () => {
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
