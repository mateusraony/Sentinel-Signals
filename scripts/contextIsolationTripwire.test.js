// Item 285 — tripwire de isolamento do Contexto de Mercado (docs/known-risks.md
// itens 284/285). A regra de ouro do plano: o contexto pode parar; o Sentinel
// não pode depender dele. Dois lados, os dois travados aqui:
//
//  1. O MOTOR (scanner, regras de saída, métricas, arbitragem, backtest) nunca
//     importa nada de Contexto de Mercado — se importasse, uma fonte externa
//     fora do ar ou lenta passaria a poder mexer em entrada, stop, alvo ou score.
//  2. O CONTEXTO (scripts/context*, .github/workflows/context-*.yml) nunca toca
//     banco, scanner nem o canal de Telegram que grava log no banco. Motivo
//     concreto: scripts/adminTelegram.js importa o `backend` e, quando o envio
//     falha, grava SystemLog no Postgres — um workflow de contexto que o usasse
//     acordaria o Neon, cuja cota de computação é justamente o problema de hoje
//     (itens 282/283). Quando a Fase 4 precisar de Telegram, o caminho é um
//     remetente SEM banco; só então este teste é ajustado, de propósito.
//
// Padrão de modelo: src/lib/noOrderExecutionTripwire.test.js (inclui a prova de
// que o guard pega o que deve pegar e não acusa o que é inocente).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

// Arquivos do motor de trading (a lista é explícita: mexer em motor é decisão consciente).
const MOTOR = [
  'src/lib/scanner.js',
  'src/lib/opExitRules.js',
  'src/lib/opTransition.js',
  'src/lib/tradeMetrics.js',
  'src/lib/signalArbitration.js',
  'src/lib/backtestEngine.js',
  'src/lib/decisionSnapshot.js',
  'src/lib/decisionExplanation.js',
];

// Importa (estático, dinâmico ou require) um módulo de Contexto de Mercado: o nome-base do arquivo
// começa com "context" (contextTime, contextOverlap, context-probe...) ou é "marketContext*"/"useMarketContext".
// Não acusa `signalContextTranslation`, `AuthContext` nem o `context-menu` do shadcn.
const IMPORTA_CONTEXTO = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"][^'"]*\/(?:context(?!-menu)[A-Za-z0-9-]*|marketContext[A-Za-z0-9]*|useMarketContext)(?:\.m?jsx?)?['"]/;

// O que o lado do Contexto NÃO pode referenciar.
const PROIBIDO_NO_CONTEXTO = [
  { nome: 'banco Postgres/Neon', re: /DATABASE_URL|DATABASE_SSL_CA|pgEntitiesCore|from\s+['"]pg['"]/ },
  { nome: 'adaptador de entidades (banco)', re: /adminEntities|@\/api\/entities|api\/entities/ },
  { nome: 'Firebase', re: /firebase|FIREBASE_/i },
  { nome: 'o scanner / motor de trading', re: /\bscanner\b|scanAllAssets|priceCheckActiveOps|persistScanResults|TradeOperation/ },
  { nome: 'Telegram que grava log no banco', re: /adminTelegram/ },
];

const lerSeExiste = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : null);

function arquivosDoContexto() {
  const scripts = readdirSync(join(ROOT, 'scripts'))
    .filter((n) => /^context[A-Za-z0-9-]*\.(mjs|js)$/.test(n) && !/\.test\.(mjs|js)$/.test(n))
    .map((n) => `scripts/${n}`);
  const workflows = readdirSync(join(ROOT, '.github', 'workflows'))
    .filter((n) => /^context-.*\.ya?ml$/.test(n))
    .map((n) => `.github/workflows/${n}`);
  return [...scripts, ...workflows];
}

function violacoes(rel, texto) {
  // Comentários explicam o PORQUÊ citando os termos proibidos; o que vale é o código.
  const semComentario = texto
    .split('\n')
    .filter((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l))
    .join('\n');
  return PROIBIDO_NO_CONTEXTO.filter(({ re }) => re.test(semComentario)).map(({ nome }) => `${rel}: referencia ${nome}`);
}

describe('tripwire: o motor não depende do Contexto de Mercado (item 285)', () => {
  it('nenhum arquivo do motor importa módulo de contexto', () => {
    const achados = [];
    let lidos = 0;
    for (const rel of MOTOR) {
      const texto = lerSeExiste(rel);
      if (texto === null) continue;
      lidos += 1;
      if (IMPORTA_CONTEXTO.test(texto)) achados.push(rel);
    }
    expect(lidos).toBeGreaterThanOrEqual(6); // não-vacuidade: leu o motor de verdade
    expect(achados).toEqual([]);
  });

  it('nenhum arquivo de src/lib/indicators importa módulo de contexto', () => {
    const dir = join(ROOT, 'src', 'lib', 'indicators');
    const arquivos = readdirSync(dir).filter((n) => /\.(js|jsx)$/.test(n) && !/\.test\./.test(n));
    expect(arquivos.length).toBeGreaterThan(5);
    const achados = arquivos.filter((n) => IMPORTA_CONTEXTO.test(readFileSync(join(dir, n), 'utf8')));
    expect(achados).toEqual([]);
  });
});

describe('tripwire: o Contexto não toca banco, scanner nem Telegram com banco (item 285)', () => {
  it('scripts/context* e workflows context-*.yml estão limpos', () => {
    const arquivos = arquivosDoContexto();
    expect(arquivos.length).toBeGreaterThanOrEqual(5); // não-vacuidade: achou os arquivos da fase
    const achados = arquivos.flatMap((rel) => violacoes(rel, readFileSync(join(ROOT, rel), 'utf8')));
    expect(achados).toEqual([]);
  });

  it('a sonda não manda Telegram e só pede permissão de leitura', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/context-probe.yml'), 'utf8');
    const semComentario = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(semComentario).not.toMatch(/TELEGRAM/);
    expect(semComentario).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(semComentario).not.toMatch(/contents:\s*write/);
    expect(semComentario).toMatch(/workflow_dispatch/);
    expect(semComentario).not.toMatch(/^\s*schedule:/m); // Fase 1 é manual de propósito
  });
});

describe('prova do guard: pega o que deve e não acusa o inocente', () => {
  it('pega import de contexto no motor', () => {
    const plantados = [
      "import { nyToUtc } from './contextTime.mjs';",
      "import { x } from '../../scripts/contextBudget.mjs'",
      "const m = await import('./context-probe.mjs');",
      "import { useMarketContext } from '@/hooks/useMarketContext';",
      "import { overlap } from './contextOverlap';",
      "const t = require('./contextTime.mjs')",
    ];
    for (const linha of plantados) expect(IMPORTA_CONTEXTO.test(linha), linha).toBe(true);
  });

  it('não acusa módulos que só têm "context" no nome por outro motivo', () => {
    const inocentes = [
      "import { t } from './signalContextTranslation';",
      "import { useAuth } from '@/lib/AuthContext';",
      "import { ContextMenu } from '@/components/ui/context-menu';",
      "import { scanErrorBrowserContext } from './scanErrorBrowserContext.js'",
      "const contextual = 1; // contexto do candle",
    ];
    for (const linha of inocentes) expect(IMPORTA_CONTEXTO.test(linha), linha).toBe(false);
  });

  it('pega banco, scanner e Telegram-com-banco plantados no lado do contexto', () => {
    const plantados = [
      "import { backend } from './adminEntities.js';",
      'DATABASE_URL: ${{ secrets.DATABASE_URL }}',
      "import { notify } from './adminTelegram.js';",
      "import { scanAllAssets } from '../src/lib/scanner.js';",
      "import { getFirestore } from 'firebase-admin/firestore';",
      "import pg from 'pg'; // from 'pg'",
    ];
    for (const linha of plantados) {
      expect(violacoes('plantado', linha).length, linha).toBeGreaterThan(0);
    }
  });

  it('ignora comentário que só explica (o texto deste próprio cabeçalho)', () => {
    expect(violacoes('x', '// adminTelegram acorda o Neon via DATABASE_URL\n# scanner não\nconst a = 1;')).toEqual([]);
  });
});
