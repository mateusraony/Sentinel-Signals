// Modo de observação sem banco, ENSAIO do vigia (docs/known-risks.md item 299, addendum 6) — travas estruturais.
// O que importa aqui é o que NÃO pode mudar sem querer: o ensaio só LÊ (nunca grava episódio, nunca marca livro, nunca toca o Postgres), o workflow é só de
// disparo manual e sem permissão de escrita, e o log (público) leva só contagem e código. Cada regra tem variantes PLANTADAS que precisam ser acusadas.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ler = (arq) => readFileSync(join(ROOT, arq), 'utf8');
const semComentarioJs = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const semComentarioYml = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const importsDe = (codigo) => [...codigo.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

const ARQ = {
  ensaio: 'scripts/observationRehearsal.mjs',
  entrada: 'scripts/observation-rehearsal.mjs',
  workflow: '.github/workflows/observation-rehearsal.yml',
};

const BANCO = /adminEntities|adminTelegram|\bbackend\b|from\s+['"]pg['"]|(?<!OBSERVATION_)\bDATABASE_URL\b|DATABASE_URL_READONLY|DATABASE_SSL_CA/;

// --- regras ----------------------------------------------------------------------------------------------------------------------------------

export function problemasDoEnsaio(texto) {
  const c = semComentarioJs(texto);
  const p = [];
  const OK = new Set(['./contextTelegram.mjs', './observationWatchStore.mjs', './observationCandles.mjs', './observationWatch.mjs', './observationWatcher.mjs', './observationMessages.mjs', './observationSnapshot.mjs']);
  for (const spec of importsDe(c)) if (!OK.has(spec)) p.push(`import fora da lista: ${spec}`);
  if (BANCO.test(c)) p.push('toca o Postgres/adaptador do banco/adminTelegram: o ensaio não pode acordar o Neon');
  // (sem `.ref(`: o módulo só fala com o RTDB pelo armazenamento do vigia, e dele só usa as LEITURAS; `Map.set`/`Array.push` locais são inofensivos)
  if (/\bsetEpisode\b|\bpatchEpisode\b|\.ref\s*\(|\.(update|remove|transaction)\s*\(/.test(c)) p.push('o ensaio NÃO grava nada (nem episódio, nem livro de avisos)');
  if (!/rtdb\.readSnapshot\(\)/.test(c)) p.push('não lê o retrato real');
  if (!/rtdb\.ensureWritable\(\)/.test(c)) p.push('não confere as regras publicadas (a leitura delas é o que o ensaio testa)');
  if (/\.message\b/.test(c)) p.push('lê .message de erro (o log é público)');
  if (/\bconsole\./.test(c)) p.push('console.* no módulo (quem imprime é o ponto de entrada, só com contagem e código)');
  const relogios = [...c.matchAll(/Date\.now\s*\(/g)].length;
  const padroes = [...c.matchAll(/nowMs\s*=\s*Date\.now\(\)/g)].length;
  if (relogios !== padroes) p.push('Date.now() fora do parâmetro padrão `nowMs = Date.now()`');
  if (!/if \(!url\) return \{ ok: false, skipped: 'sem_url' \};/.test(c)) p.push('sem a URL o ensaio precisa sair sem tocar em nada');
  if (!/nada foi gravado/.test(c)) p.push('o relatório precisa dizer que nada foi gravado');
  if ((c.match(/ENSAIO/g) || []).length < 2) p.push('as duas mensagens precisam ser marcadas ENSAIO');
  if (!/valores inventados/.test(c)) p.push('o exemplo de aviso precisa dizer que os valores são inventados');
  const iEx = c.indexOf('function buildSampleAlert(');
  const corpoEx = iEx >= 0 ? c.slice(iEx, c.indexOf('\n}\n', iEx)) : '';
  if (!corpoEx || /op:\s*o\b|snapshot\.|\bops\b|\boperations\b/.test(corpoEx)) p.push('o exemplo de aviso não pode usar dado de operação real');
  if (!/function escapeHtml\(/.test(c)) p.push('sem escapeHtml: símbolo do banco iria cru para o HTML do Telegram');
  return p;
}

export function problemasDaEntrada(texto) {
  const c = semComentarioJs(texto);
  const p = [];
  if (!/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/.test(c)) p.push('o corpo precisa rodar só na execução direta (módulo que faz trabalho no carregamento é intestável)');
  if (!/withTimeout\(runObservationRehearsal\(\{\}\), REHEARSAL_TIMEOUT_MS/.test(c)) p.push('o ensaio precisa ter prazo');
  if (!/catch\(\(\) => \{\s*\n\s*\/\/[^\n]*\n\s*console\.error\('[^']*'\);/.test(texto.replace(/\.catch\(\(\) => \{/, '.catch(() => {'))) p.push('o catch precisa ser sem variável e com mensagem FIXA');
  if (/\.message\b/.test(c)) p.push('lê .message de erro');
  if (!/forceExit\(r\?\.ok \? 0 : 1\)/.test(c)) p.push('o job precisa ficar vermelho quando o ensaio acha problema');
  if (BANCO.test(c)) p.push('toca o banco');
  return p;
}

export function problemasDoWorkflowEnsaio(yml) {
  const c = semComentarioYml(yml);
  const p = [];
  if (!/^on:\s*\n\s+workflow_dispatch:\s*$/m.test(c)) p.push('o ensaio é só de disparo MANUAL (workflow_dispatch sem campos)');
  if (/\bschedule:|\bpush:|\bpull_request|\bworkflow_run:/.test(c)) p.push('gatilho automático: o ensaio manda mensagem no Telegram, só roda quando o usuário pedir');
  if (/^\s+inputs:/m.test(c)) p.push('o ensaio não tem campos');
  if (!/^permissions:\s*\n\s+contents: read\s*$/m.test(c)) p.push('permissions precisa ser só `contents: read`');
  if (/contents:\s*write|actions:\s*write|id-token/.test(c)) p.push('permissão de escrita');
  if (BANCO.test(c)) p.push('o ensaio não pode ter DATABASE_URL/CA do banco (não acorda o Neon)');
  const segredos = [...c.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
  const esperados = ['FIREBASE_DATABASE_URL', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  if (JSON.stringify(segredos) !== JSON.stringify(esperados)) p.push(`segredos permitidos: ${esperados.join(', ')}; achei: ${segredos.join(', ') || 'nenhum'}`);
  if (!/^\s+OBSERVATION_DATABASE_URL:\s*\$\{\{\s*secrets\.FIREBASE_DATABASE_URL\s*\}\}\s*$/m.test(c)) p.push('a URL entra como OBSERVATION_DATABASE_URL (nunca FIREBASE_DATABASE_URL: moveria marcadores de alerta)');
  if (/^\s+FIREBASE_DATABASE_URL:/m.test(c)) p.push('FIREBASE_DATABASE_URL como variável do passo');
  const runs = [...c.matchAll(/^\s+run:\s*(.+)$/gm)].map((m) => m[1].trim());
  if (!runs.includes('node scripts/observation-rehearsal.mjs')) p.push('o passo precisa rodar node scripts/observation-rehearsal.mjs');
  if (runs.some((r) => /\$\{\{/.test(r))) p.push('expressão ${{ }} dentro de um `run:` (injeção de comando)');
  if (/\bgit (push|commit)\b/.test(c)) p.push('o ensaio não escreve no repositório');
  if (/upload-artifact/.test(c)) p.push('sem artefato: poderia levar dado do retrato para um arquivo baixável');
  return p;
}

// --- testes ----------------------------------------------------------------------------------------------------------------------------------

const planta = (arq, de, para) => {
  const t = ler(arq);
  if (!t.includes(de)) throw new Error(`trecho a plantar não existe em ${arq}: ${de}`);
  return t.replace(de, para);
};

describe('tripwire do ensaio: arquivos reais seguem as regras', () => {
  it('módulo do ensaio', () => expect(problemasDoEnsaio(ler(ARQ.ensaio))).toEqual([]));
  it('ponto de entrada', () => expect(problemasDaEntrada(ler(ARQ.entrada))).toEqual([]));
  it('workflow', () => expect(problemasDoWorkflowEnsaio(ler(ARQ.workflow))).toEqual([]));
});

describe('tripwire do ensaio: variantes plantadas são acusadas', () => {
  const casos = [
    ['ensaio importa o adaptador do banco', () => problemasDoEnsaio(`import { backend } from './adminEntities.js';\n${ler(ARQ.ensaio)}`)],
    ['ensaio importa o Telegram com banco', () => problemasDoEnsaio(`import { notifyStopHit } from './adminTelegram.js';\n${ler(ARQ.ensaio)}`)],
    ['ensaio importa algo fora da lista', () => problemasDoEnsaio(`import fs from 'node:fs';\n${ler(ARQ.ensaio)}`)],
    ['ensaio cita DATABASE_URL', () => problemasDoEnsaio(`${ler(ARQ.ensaio)}\nexport const u = process.env.DATABASE_URL;`)],
    ['ensaio grava o episódio', () => problemasDoEnsaio(`${ler(ARQ.ensaio)}\nexport const g = (s) => s.setEpisode({});`)],
    ['ensaio marca o livro', () => problemasDoEnsaio(`${ler(ARQ.ensaio)}\nexport const g = (s) => s.patchEpisode({ alerts_sent: 1 });`)],
    ['ensaio grava direto no RTDB', () => problemasDoEnsaio(`${ler(ARQ.ensaio)}\nexport const g = (db) => db.ref('x').set(1);`)],
    ['ensaio apaga nó', () => problemasDoEnsaio(`${ler(ARQ.ensaio)}\nexport const g = (ref) => ref.remove();`)],
    ['ensaio sem ler o retrato', () => problemasDoEnsaio(planta(ARQ.ensaio, 'rtdb.readSnapshot()', 'Promise.resolve({ ok: true, value: null })'))],
    ['ensaio sem conferir as regras', () => problemasDoEnsaio(planta(ARQ.ensaio, 'rtdb.ensureWritable()', 'Promise.resolve({ ok: true })'))],
    ['ensaio lê .message', () => problemasDoEnsaio(`${ler(ARQ.ensaio)}\nexport const m = (e) => e.message;`)],
    ['ensaio loga', () => problemasDoEnsaio(`${ler(ARQ.ensaio)}\nconsole.log('x');`)],
    ['ensaio usa o relógio global', () => problemasDoEnsaio(`${ler(ARQ.ensaio)}\nexport const t = Date.now();`)],
    ['ensaio sem a saída antecipada sem URL', () => problemasDoEnsaio(planta(ARQ.ensaio, "if (!url) return { ok: false, skipped: 'sem_url' };", ''))],
    ['ensaio sem dizer que nada foi gravado', () => problemasDoEnsaio(planta(ARQ.ensaio, '— nada foi gravado e nenhuma', '— tudo certo e nenhuma'))],
    ['ensaio sem marcar o exemplo como inventado', () => problemasDoEnsaio(planta(ARQ.ensaio, '(valores inventados; nenhuma operação real', '(valores reais; nenhuma operação real'))],
    ['ensaio com o exemplo usando operação real', () => problemasDoEnsaio(planta(ARQ.ensaio, "op: { symbol: 'BTCUSDT', side: 'BUY', signal_timeframe: '4h', entry_price: 100, current_stop: 95 },", 'op: o,'))],
    ['ensaio sem escapeHtml', () => problemasDoEnsaio(planta(ARQ.ensaio, 'function escapeHtml(', 'function escapar('))],
    ['entrada sem a guarda de execução direta', () => problemasDaEntrada(planta(ARQ.entrada, 'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {', 'if (true) {'))],
    ['entrada sem prazo', () => problemasDaEntrada(planta(ARQ.entrada, "withTimeout(runObservationRehearsal({}), REHEARSAL_TIMEOUT_MS, 'observationRehearsal')", 'runObservationRehearsal({})'))],
    ['entrada que sempre sai com 0', () => problemasDaEntrada(planta(ARQ.entrada, 'forceExit(r?.ok ? 0 : 1)', 'forceExit(0)'))],
    ['entrada com catch mostrando o erro', () => problemasDaEntrada(planta(ARQ.entrada, ".catch(() => {\n      // Mensagem FIXA: o texto da exceção não passa por sanitização e o log é público.\n      console.error('[ensaio] falhou sem resultado (prazo ou erro inesperado)');", ".catch((e) => {\n      console.error('[ensaio] falhou', e.message);"))],
    ['workflow com agendamento', () => problemasDoWorkflowEnsaio(planta(ARQ.workflow, 'on:\n  workflow_dispatch:', "on:\n  workflow_dispatch:\n  schedule:\n    - cron: '0 * * * *'"))],
    ['workflow disparado por push', () => problemasDoWorkflowEnsaio(planta(ARQ.workflow, 'on:\n  workflow_dispatch:', 'on:\n  workflow_dispatch:\n  push:'))],
    ['workflow com campo de entrada', () => problemasDoWorkflowEnsaio(planta(ARQ.workflow, 'on:\n  workflow_dispatch:', 'on:\n  workflow_dispatch:\n    inputs:\n      x:\n        required: false'))],
    ['workflow com permissão de escrita', () => problemasDoWorkflowEnsaio(planta(ARQ.workflow, 'permissions:\n  contents: read', 'permissions:\n  contents: write'))],
    ['workflow com o banco', () => problemasDoWorkflowEnsaio(planta(ARQ.workflow, 'TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}', 'TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}\n          DATABASE_URL: ${{ secrets.DATABASE_URL }}'))],
    ['workflow com segredo a mais', () => problemasDoWorkflowEnsaio(planta(ARQ.workflow, 'TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}', 'TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}\n          EXTRA: ${{ secrets.BACKUP_DEPLOY_KEY }}'))],
    ['workflow sem o segredo do Telegram', () => problemasDoWorkflowEnsaio(planta(ARQ.workflow, 'TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}', 'X: 1'))],
    ['workflow com FIREBASE_DATABASE_URL como variável', () => problemasDoWorkflowEnsaio(planta(ARQ.workflow, 'OBSERVATION_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}', 'FIREBASE_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}'))],
    ['workflow roda outro script', () => problemasDoWorkflowEnsaio(planta(ARQ.workflow, 'run: node scripts/observation-rehearsal.mjs', 'run: node scripts/run-scan.mjs'))],
    ['workflow com expressão dentro do run', () => problemasDoWorkflowEnsaio(planta(ARQ.workflow, 'run: node scripts/observation-rehearsal.mjs', 'run: node scripts/observation-rehearsal.mjs ${{ github.event.inputs.x }}'))],
    ['workflow que guarda artefato', () => problemasDoWorkflowEnsaio(`${ler(ARQ.workflow)}\n      - uses: actions/upload-artifact@v4\n        with:\n          name: x\n          path: x`)],
    ['workflow que faz commit', () => problemasDoWorkflowEnsaio(`${ler(ARQ.workflow)}\n      - run: git push`)],
  ];

  it.each(casos)('%s', (_nome, montar) => {
    expect(montar().length).toBeGreaterThan(0);
  });
});
