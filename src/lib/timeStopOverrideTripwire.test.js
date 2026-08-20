// docs/known-risks.md item 109 — tripwire de segurança, mesmo padrão do
// rf1hUncondTripwire.test.js: pineConfig.timeStopBarsOverride tem que
// existir SÓ em scripts/backtestPineConfig.js. Se essa chave algum dia
// aparecer como uma entrada de DEFAULTS/SYNCED_STRATEGY_KEYS em
// src/lib/pineParser.js (browser) ou scripts/adminPineConfig.js (cron) —
// os dois arquivos que alimentam strategyConfig/current no Firestore,
// gravável por qualquer sessão anônima (CLAUDE.md decisão item 1) — este
// teste falha alto e cedo, antes de virar um toggle de produção sem gate
// de revisão de código.
//
// Aqui o risco é concreto e não teórico: o prazo máximo sem TP1 é um
// parâmetro de GESTÃO DE RISCO congelado na criação da operação; um valor
// vindo de config viva encurtaria o prazo de operações futuras sem
// nenhuma medição por trás — exatamente o que o item 109 registra como
// ainda não decidido (a evidência é sugestiva contra encurtar, e só um
// replay resolve).
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
// (`timeStopBarsOverride: null,`), não com a menção em prosa dentro de um
// comentário explicativo (sem `:` logo em seguida).
const KEY_AS_OBJECT_ENTRY = /timeStopBarsOverride\s*:/;

describe('timeStopBarsOverride — tripwire de isolamento backtest-only', () => {
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
