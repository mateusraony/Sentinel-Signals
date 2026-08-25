// docs/known-risks.md item 132 — tripwire de segurança, mesmo padrão do
// timeStopOverrideTripwire.test.js: as três chaves do trailing pré-TP1 têm
// que existir SÓ em scripts/backtestPineConfig.js. Se qualquer uma aparecer
// como entrada de DEFAULTS/SYNCED_STRATEGY_KEYS em src/lib/pineParser.js
// (browser) ou scripts/adminPineConfig.js (cron) — os dois arquivos que
// alimentam strategyConfig/current no Firestore, gravável por qualquer
// sessão anônima (CLAUDE.md decisão item 1) — este teste falha alto e cedo,
// antes de virar um toggle de produção sem gate de revisão de código.
//
// O risco aqui é concreto: trocar o mecanismo de proteção pré-TP1 muda a
// GESTÃO DE RISCO de operações futuras, e o item 132 registra explicitamente
// que a calibração de start/trail ainda não foi medida contra o histograma
// real de MFE. Um valor vindo de config viva aplicaria essa mudança sem
// nenhuma medição por trás.
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
// (`preTp1TrailEnabled: false,`), não com a menção em prosa dentro de um
// comentário explicativo (sem `:` logo em seguida).
const CHAVES = [
  ['preTp1TrailEnabled', /preTp1TrailEnabled\s*:/],
  ['preTp1TrailStartAtrMult', /preTp1TrailStartAtrMult\s*:/],
  ['preTp1TrailAtrMult', /preTp1TrailAtrMult\s*:/],
];

describe('trailing pré-TP1 — tripwire de isolamento backtest-only', () => {
  for (const [nome, padrao] of CHAVES) {
    it(`${nome} existe como entrada real em scripts/backtestPineConfig.js (confirma que o teste sabe reconhecer o padrão)`, () => {
      const source = readFileSync(resolve(__dirname, '../../scripts/backtestPineConfig.js'), 'utf-8');
      expect(source).toMatch(padrao);
    });

    it(`${nome} NUNCA aparece como entrada de objeto em src/lib/pineParser.js (browser, strategyConfig/current)`, () => {
      const source = readFileSync(resolve(__dirname, './pineParser.js'), 'utf-8');
      expect(source).not.toMatch(padrao);
    });

    it(`${nome} NUNCA aparece como entrada de objeto em scripts/adminPineConfig.js (cron, strategyConfig/current)`, () => {
      const source = readFileSync(resolve(__dirname, '../../scripts/adminPineConfig.js'), 'utf-8');
      expect(source).not.toMatch(padrao);
    });
  }
});
