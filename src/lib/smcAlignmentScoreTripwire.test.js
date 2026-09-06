// docs/known-risks.md item 77 — tripwire de segurança, mesmo padrão do
// hierarchicalCascadeTripwire.test.js: pineConfig.smcAlignmentScoreEnabled
// tem que existir SÓ em scripts/backtestPineConfig.js. Se essa chave algum
// dia aparecer como uma entrada de DEFAULTS/SYNCED_STRATEGY_KEYS em
// src/lib/pineParser.js (browser) ou scripts/adminPineConfig.js (cron) — os
// dois arquivos que alimentam strategyConfig/current no Firestore, gravável
// por qualquer sessão anônima (CLAUDE.md decisão item 1) — este teste falha
// alto e cedo, antes de virar um toggle de produção sem gate de revisão de
// código.
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
// (`smcAlignmentScoreEnabled: false,`), não com a menção em prosa dentro de
// um comentário explicativo (sem `:` logo em seguida) que os 3 arquivos já
// têm de propósito.
const KEY_AS_OBJECT_ENTRY = /smcAlignmentScoreEnabled\s*:/;

describe('smcAlignmentScoreEnabled — tripwire de isolamento backtest-only', () => {
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

  // Item 2 da Fase 2 do pente fino (docs/known-risks.md item 168, achado 2,
  // deferido a pedido do usuário pra esta rodada separada): o vetor real de
  // vazamento pra produção não é uma entrada em DEFAULTS (checado acima) — é
  // uma entrada em SYNCED_STRATEGY_KEYS. getPineConfig() (pineParser.js) lê
  // esse array e, pra CADA chave nele, sobrescreve config[key] com o valor de
  // strategyConfig/current no Firestore SE a chave estiver presente lá —
  // isso roda incondicionalmente, sem checar se a chave também existe em
  // DEFAULTS. Bastaria adicionar 'smcAlignmentScoreEnabled' ao array (sem tocar DEFAULTS
  // nenhum) pra o Firestore (gravável por qualquer sessão anônima, CLAUDE.md
  // decisão 1) já conseguir setar esse flag hoje mesmo — os 3 testes acima
  // não pegariam isso, porque só olham a forma de entrada de objeto.
  it('NÃO está em nenhuma lista de sync (SYNCED_STRATEGY_KEYS) dos dois arquivos de produção', () => {
    for (const rel of ['./pineParser.js', '../../scripts/adminPineConfig.js']) {
      const source = readFileSync(resolve(__dirname, rel), 'utf-8');
      expect(source, `${rel} não pode citar a chave como string de sync`)
        .not.toMatch(/'smcAlignmentScoreEnabled'/);
    }
  });
});
