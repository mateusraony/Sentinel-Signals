// Modo de observação sem banco, fase O2a (docs/known-risks.md item 299) — travas estruturais dos dois módulos PUROS do vigia.
// O que importa aqui é o que NÃO pode mudar sem querer: o vigia decide stop/alvo com as regras do PRÓPRIO motor (importadas, não copiadas), não lê
// relógio nem ambiente, não fala com rede/banco/Telegram e não lê `.message` de erro (o log do Actions é público). As mensagens não importam nada e
// não levam link. Cada regra tem variantes PLANTADAS que precisam ser acusadas (.claude/rules/testing.md: guard nunca testado contra o alvo é suposição).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ler = (arq) => readFileSync(join(ROOT, arq), 'utf8');
const semComentarioJs = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const importsDe = (codigo) => [...codigo.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

const ARQ = { vigia: 'scripts/observationWatch.mjs', mensagens: 'scripts/observationMessages.mjs' };

const MOTOR = ['isCandleUsableForExits', 'getEntryReferenceTime', 'resolveCandleExit', 'closesFullyAtTp1'];

/** O que vale para os dois módulos puros. */
function problemasComuns(c) {
  const p = [];
  if (/\bprocess\./.test(c)) p.push('lê process (ambiente): o módulo puro recebe tudo por parâmetro');
  if (/\bDate\.now\s*\(/.test(c)) p.push('Date.now() (o relógio vem por parâmetro)');
  if (/new Date\(\s*\)/.test(c)) p.push('new Date() sem argumento é o relógio global');
  if (/\bfetch\s*\(|\brequire\s*\(|\bimport\s*\(/.test(c)) p.push('rede ou import dinâmico no módulo puro');
  if (/\bconsole\./.test(c)) p.push('console.* (quem loga é o chamador, só com contagem e código)');
  if (/\.message\b/.test(c)) p.push('lê .message de erro (pode trazer endereço do projeto; o log é público)');
  if (/firebase|\bpg\b|adminEntities|adminTelegram|TELEGRAM_BOT_TOKEN|DATABASE_URL/i.test(c)) p.push('cita banco, Firebase ou segredo: o módulo é puro');
  if (/\bMath\.random\s*\(/.test(c)) p.push('aleatoriedade: a decisão precisa ser determinística');
  return p;
}

export function problemasDoVigia(texto) {
  const c = semComentarioJs(texto);
  const p = problemasComuns(c);
  const OK = new Set(['../src/lib/opExitRules.js', './observationSnapshot.mjs']);
  for (const spec of importsDe(c)) if (!OK.has(spec)) p.push(`import fora da lista: ${spec}`);
  // As regras de saída vêm do motor, importadas pelo nome E usadas.
  const importMotor = /import\s*\{([^}]*)\}\s*from\s*'\.\.\/src\/lib\/opExitRules\.js'/.exec(c)?.[1] ?? '';
  for (const nome of MOTOR) {
    if (!new RegExp(`\\b${nome}\\b`).test(importMotor)) p.push(`não importa ${nome} do motor (opExitRules.js)`);
    const usos = (c.match(new RegExp(`\\b${nome}\\s*\\(`, 'g')) || []).length;
    if (usos < 1) p.push(`importa ${nome} mas não o usa: a regra do motor foi trocada por uma cópia`);
  }
  // O stop vence a ambiguidade: a decisão sai de resolveCandleExit, não de uma comparação própria.
  if ((c.match(/resolveCandleExit\s*\(/g) || []).length < 2) p.push('stop/alvo na mesma vela precisa passar por resolveCandleExit nos dois ramos (antes e depois do TP1)');
  // Só o que o motor também faz: nada de Time Stop, Chop Exit, invalidação ou trailing por ATR (isso é a O3).
  if (/advanceTrailingStop|advancePreTp1|TIME_STOP|CHOP_EXIT|INVALIDATED|atrValue|trailMult/.test(c)) p.push('o vigia da O2 não replica Time Stop, Chop Exit, invalidação nem trailing por ATR (isso é a O3)');
  // Não escreve em nada.
  // (`push` fica de fora de propósito: é o do vetor local; o RTDB grava com set/update/remove/transaction)
  if (/\.(set|update|remove|transaction|create|delete)\s*\(/.test(c)) p.push('o núcleo puro não grava em lugar nenhum');
  return p;
}

export function problemasDasMensagens(texto) {
  const c = semComentarioJs(texto);
  const p = problemasComuns(c);
  if (importsDe(c).length > 0 || /^\s*import\s/m.test(c)) p.push('o módulo das mensagens precisa ser PURO (nenhum import)');
  if (/https?:\/\//.test(c)) p.push('link nas mensagens: durante a queda o painel está sem dados');
  if (!/function escapeHtml\(/.test(c)) p.push('sem escapeHtml: texto do banco iria cru para o HTML do Telegram');
  if (/\$\{\s*(?:op|o)\?*\.(?:symbol|side)\s*\}/.test(c)) p.push('símbolo ou lado do banco interpolado sem passar por label()/sideText()');
  return p;
}

const planta = (arq, de, para) => {
  const t = ler(arq);
  if (!t.includes(de)) throw new Error(`trecho a plantar não existe em ${arq}: ${de}`);
  return t.replace(de, para);
};

describe('tripwire O2a: arquivos reais seguem as regras', () => {
  it('núcleo do vigia', () => expect(problemasDoVigia(ler(ARQ.vigia))).toEqual([]));
  it('mensagens', () => expect(problemasDasMensagens(ler(ARQ.mensagens))).toEqual([]));
});

describe('tripwire O2a: variantes plantadas são acusadas', () => {
  const casos = [
    ['vigia importa a rede/banco', () => problemasDoVigia(`import pg from 'pg';\n${ler(ARQ.vigia)}`)],
    ['vigia importa algo fora da lista', () => problemasDoVigia(`import fs from 'node:fs';\n${ler(ARQ.vigia)}`)],
    ['vigia lê o ambiente', () => problemasDoVigia(`${ler(ARQ.vigia)}\nexport const x = process.env.X;`)],
    ['vigia usa Date.now', () => problemasDoVigia(`${ler(ARQ.vigia)}\nexport const t = Date.now();`)],
    ['vigia usa new Date()', () => problemasDoVigia(`${ler(ARQ.vigia)}\nexport const t = new Date();`)],
    ['vigia faz fetch', () => problemasDoVigia(`${ler(ARQ.vigia)}\nexport const f = () => fetch('x');`)],
    ['vigia loga', () => problemasDoVigia(`${ler(ARQ.vigia)}\nconsole.log('x');`)],
    ['vigia lê .message', () => problemasDoVigia(`${ler(ARQ.vigia)}\nexport const m = (e) => e.message;`)],
    ['vigia usa aleatoriedade', () => problemasDoVigia(`${ler(ARQ.vigia)}\nexport const r = Math.random();`)],
    ['vigia cita DATABASE_URL', () => problemasDoVigia(`${ler(ARQ.vigia)}\nexport const u = 'DATABASE_URL';`)],
    ['vigia grava no RTDB', () => problemasDoVigia(`${ler(ARQ.vigia)}\nexport const g = (ref) => ref.set(1);`)],
    ['vigia deixa de importar closesFullyAtTp1', () => problemasDoVigia(planta(ARQ.vigia, 'resolveCandleExit, closesFullyAtTp1 }', 'resolveCandleExit }'))],
    ['vigia deixa de importar isCandleUsableForExits', () => problemasDoVigia(planta(ARQ.vigia, '{ isCandleUsableForExits, getEntryReferenceTime', '{ getEntryReferenceTime'))],
    ['vigia copia a guarda temporal em vez de usar a do motor', () => problemasDoVigia(planta(ARQ.vigia, 'if (!isCandleUsableForExits(new Date(c.openTime).toISOString(), entryRef)) continue;', 'if (c.openTime < Date.parse(entryRef)) continue;'))],
    ['vigia decide a ambiguidade por conta própria (ramo pré-TP1)', () => problemasDoVigia(planta(ARQ.vigia, 'const { stopWins, ambiguous } = resolveCandleExit({ stopTouched, targetTouched: tp1Touched });', 'const stopWins = stopTouched; const ambiguous = false;'))],
    ['vigia decide a ambiguidade por conta própria (ramo do runner)', () => problemasDoVigia(planta(ARQ.vigia, 'const { stopWins, ambiguous } = resolveCandleExit({ stopTouched, targetTouched: tp2Touched });', 'const stopWins = stopTouched; const ambiguous = false;'))],
    ['vigia replica o trailing por ATR', () => problemasDoVigia(`${ler(ARQ.vigia)}\nconst x = advanceTrailingStop;`)],
    ['vigia replica o Time Stop', () => problemasDoVigia(`${ler(ARQ.vigia)}\nconst x = 'TIME_STOP';`)],
    ['mensagens importam algo', () => problemasDasMensagens(`import { x } from './y.mjs';\n${ler(ARQ.mensagens)}`)],
    ['mensagens com link do painel', () => problemasDasMensagens(`${ler(ARQ.mensagens)}\nexport const l = 'https://sentinel-signals.onrender.com';`)],
    ['mensagens leem o ambiente', () => problemasDasMensagens(`${ler(ARQ.mensagens)}\nexport const t = process.env.TELEGRAM_BOT_TOKEN;`)],
    ['mensagens usam o relógio', () => problemasDasMensagens(`${ler(ARQ.mensagens)}\nexport const t = Date.now();`)],
    ['mensagens sem escapeHtml', () => problemasDasMensagens(planta(ARQ.mensagens, 'function escapeHtml(', 'function escapar('))],
    ['mensagens com o símbolo cru', () => problemasDasMensagens(planta(ARQ.mensagens, '${headerLine(op)}', '${op.symbol}'))],
    ['mensagens leem .message', () => problemasDasMensagens(`${ler(ARQ.mensagens)}\nexport const m = (e) => e.message;`)],
    ['mensagens citam o banco', () => problemasDasMensagens(`${ler(ARQ.mensagens)}\nexport const m = 'adminEntities';`)],
  ];

  it.each(casos)('%s', (_nome, montar) => {
    expect(montar().length).toBeGreaterThan(0);
  });
});
