// Item 285, Fase 5 — a medição de operações × eventos é SÓ LEITURA, sem aviso e sem vazar dado de operação no log público.
// Travas: workflow (permissões, segredos, sem agendamento, sem entrada digitada no shell) e script (nenhuma escrita, nada de Telegram/Firebase,
// nada de símbolo/preço/id no texto, nunca a mensagem crua do erro). Cada regra prova que pega o que deve (variantes plantadas).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ler = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const semComentario = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l)).join('\n');

const SEGREDOS_OK = new Set(['DATABASE_URL_READONLY', 'DATABASE_URL', 'DATABASE_SSL_CA']);

export function problemasDoWorkflow(yml) {
  const t = semComentario(yml);
  const out = [];
  if (/^\s*schedule:/m.test(t)) out.push('tem schedule (acordaria o Neon sozinho)');
  if (/\bTELEGRAM|FIREBASE/i.test(t)) out.push('cita Telegram/Firebase');
  if (/contents:\s*write|permissions:\s*write-all|(?:actions|pull-requests|issues|id-token):\s*write/.test(t)) out.push('permissão de escrita');
  if (!/permissions:\s*\n\s+contents:\s*read\s*\n/.test(t)) out.push('falta permissions: contents: read');
  for (const m of t.matchAll(/secrets\.([A-Z0-9_]+)/g)) if (!SEGREDOS_OK.has(m[1])) out.push(`segredo fora da lista: ${m[1]}`);
  if (/\$\{\{\s*(github\.event\.inputs|inputs)\./.test(t)) out.push('entrada digitada no workflow');
  if (!/run:\s*node scripts\/overlap-measure\.mjs\s*$/m.test(t)) out.push('não roda o script esperado');
  if (!/DATABASE_SSL_CA:\s*\$\{\{\s*secrets\.DATABASE_SSL_CA\s*\}\}/.test(t)) out.push('não repassa DATABASE_SSL_CA');
  return out;
}

export function problemasDoScript(texto) {
  const t = semComentario(texto);
  const out = [];
  if (/\.(create|update|delete|set|bulkCreate|bulkImport|createUnique|upsert)\s*\(|transitionTradeOp|tradeOps|\.locks\b/.test(t)) out.push('escreve ou muda estado');
  if (/adminTelegram|contextTelegram|api\.telegram\.org|firebase|FIREBASE_|rtdb/i.test(t)) out.push('Telegram/Firebase');
  if (/\.message\b|\.stack\b|console\.error/.test(t)) out.push('imprime texto cru de erro');
  if (/\bsymbol\b|entry_price|asset_id|\bpnl\b|\.id\b|stop_loss|\btp1\b|\btp2\b/i.test(t)) out.push('toca símbolo/preço/id de operação');
  if (/\.query\s*\(|getPool|from\s+['"]pg['"]/.test(t)) out.push('SQL direto');
  return out;
}

describe('tripwire: medição da Fase 5 é só leitura (item 285)', () => {
  it('o workflow real está limpo', () => {
    expect(problemasDoWorkflow(ler('.github/workflows/overlap-measure.yml'))).toEqual([]);
  });

  it('os arquivos da medição estão limpos', () => {
    for (const rel of ['scripts/overlap-measure.mjs', 'scripts/overlapMeasure.mjs', 'src/lib/contextOverlap.js']) {
      expect(problemasDoScript(ler(rel)), rel).toEqual([]);
    }
  });

  it('o script de verdade só LÊ as operações (usa list)', () => {
    expect(semComentario(ler('scripts/overlap-measure.mjs'))).toMatch(/TradeOperation\.list\(/);
  });

  it('a credencial somente-leitura é escolhida ANTES de abrir o banco', () => {
    const t = semComentario(ler('scripts/overlap-measure.mjs'));
    const troca = t.indexOf('process.env.DATABASE_URL = process.env.DATABASE_URL_READONLY');
    const abre = t.indexOf("import('./adminEntities.js')");
    expect(troca).toBeGreaterThan(-1);
    expect(abre).toBeGreaterThan(troca);
    expect(t).not.toMatch(/^import .*adminEntities/m); // import estático abriria o pool antes da troca
  });

  it('o motor não importa a medição nem o módulo de sobreposição', () => {
    for (const rel of ['src/lib/scanner.js', 'src/lib/opExitRules.js', 'src/lib/opTransition.js', 'src/lib/tradeMetrics.js']) {
      expect(ler(rel), rel).not.toMatch(/contextOverlap|overlapMeasure|overlap-measure/);
    }
  });

  it('variantes plantadas: o checador do workflow pega cada desvio', () => {
    const real = ler('.github/workflows/overlap-measure.yml');
    const variantes = [
      real.replace('workflow_dispatch: {}', 'workflow_dispatch: {}\n  schedule:\n    - cron: "0 * * * *"'),
      real.replace('contents: read', 'contents: write'),
      real.replace('DATABASE_SSL_CA: ${{ secrets.DATABASE_SSL_CA }}', 'DATABASE_SSL_CA: ${{ secrets.DATABASE_SSL_CA }}\n          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}'),
      real.replace('DATABASE_SSL_CA: ${{ secrets.DATABASE_SSL_CA }}', 'DATABASE_SSL_CA: ${{ secrets.DATABASE_SSL_CA }}\n          X: ${{ secrets.OUTRO }}'),
      real.replace('run: node scripts/overlap-measure.mjs', 'run: node scripts/overlap-measure.mjs ${{ github.event.inputs.x }}'),
      real.replace('run: node scripts/overlap-measure.mjs', 'run: node scripts/outro.mjs'),
      real.replace(/\s+DATABASE_SSL_CA: .*\n/, '\n'),
      real.replace('permissions:\n  contents: read\n', ''),
    ];
    variantes.forEach((v, i) => expect(problemasDoWorkflow(v).length, `variante ${i}`).toBeGreaterThan(0));
  });

  it('variantes plantadas: o checador do script pega cada desvio', () => {
    const base = ler('scripts/overlap-measure.mjs');
    const variantes = [
      `${base}\nawait backend.entities.TradeOperation.create({});`,
      `${base}\nawait backend.entities.TradeOperation.update(x, {});`,
      `${base}\nawait backend.tradeOps.transitionTradeOp(a, b, c);`,
      `${base}\nimport { send } from './adminTelegram.js';`,
      `${base}\nconsole.log(err.message);`,
      `${base}\nconsole.log(op.symbol);`,
      `${base}\nconsole.log(op.entry_price);`,
      `${base}\nconst r = await pool.query('select 1');`,
      `${base}\nimport admin from 'firebase-admin';`,
    ];
    variantes.forEach((v, i) => expect(problemasDoScript(v).length, `variante ${i}`).toBeGreaterThan(0));
  });
});
