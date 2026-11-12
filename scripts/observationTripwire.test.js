// Modo de observação sem banco, fase O1 (docs/known-risks.md item 299) — travas estruturais. O retrato guarda entrada, stop e alvos de operações reais
// e o log do Actions é público, então o que importa aqui é o que NÃO pode mudar sem querer: módulo puro, um nó fixo e app nomeado no RTDB, nenhuma
// leitura de `.message` de erro, a variável do scan com OUTRO nome (para não mover os marcadores de alerta) e a chamada protegida dentro do scan.
// Cada regra tem variantes PLANTADAS que precisam ser acusadas (guard nunca testado contra o próprio alvo é suposição — .claude/rules/testing.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ler = (arq) => readFileSync(join(ROOT, arq), 'utf8');
const semComentarioJs = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const semComentarioYml = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const importsDe = (codigo) => [...codigo.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

const ARQ = {
  snapshot: 'scripts/observationSnapshot.mjs',
  store: 'scripts/observationStore.mjs',
  publish: 'scripts/observationPublish.mjs',
  scanYml: '.github/workflows/scan.yml',
  runScan: 'scripts/run-scan.mjs',
};

// --- regras (cada uma devolve a lista de problemas) -------------------------------------------------------------------------------------------

export function problemasDoSnapshot(texto) {
  const c = semComentarioJs(texto);
  const p = [];
  if (importsDe(c).length > 0 || /^\s*import\s/m.test(c)) p.push('o módulo do retrato precisa ser PURO (nenhum import)');
  if (/\bprocess\./.test(c)) p.push('lê process (ambiente): o módulo puro recebe tudo por parâmetro');
  if (/\bDate\.now\s*\(/.test(c)) p.push('Date.now() dentro do módulo puro (o relógio vem por parâmetro)');
  if (/\bfetch\s*\(|\brequire\s*\(|\bimport\s*\(/.test(c)) p.push('rede ou import dinâmico no módulo puro');
  return p;
}

export function problemasDoArmazenamento(texto) {
  const c = semComentarioJs(texto);
  const p = [];
  const OK = new Set(['firebase-admin/app', 'firebase-admin/database', './scanTimeout.mjs', './observationSnapshot.mjs']);
  for (const spec of importsDe(c)) if (!OK.has(spec)) p.push(`import fora da lista: ${spec}`);
  if (/FIREBASE_DATABASE_URL/.test(c)) p.push('lê FIREBASE_DATABASE_URL: a URL do retrato é OBSERVATION_DATABASE_URL (a outra move os marcadores de alerta)');
  if (/\bgetDatabase\s*\(/.test(c)) p.push('getDatabase() usa o app PADRÃO; o retrato usa getDatabaseWithUrl com app nomeado');
  if (!/OBSERVATION_APP_NAME\s*=\s*'observation'/.test(c)) p.push('app nomeado "observation" ausente');
  if (!/initializeApp\([^;]*,\s*OBSERVATION_APP_NAME\s*\)/.test(c)) p.push('initializeApp precisa receber o NOME do app (nunca o app padrão)');
  const caminho = /SNAPSHOT_PATH\s*=\s*'([^']+)'/.exec(c)?.[1];
  if (!caminho || !/^observation\/[a-z_]+$/.test(caminho)) p.push('SNAPSHOT_PATH precisa ser um nó fixo sob "observation/"');
  const refs = [...c.matchAll(/\.ref\(([^)]*)\)/g)].map((m) => m[1].trim());
  if (refs.length !== 1 || refs[0] !== 'SNAPSHOT_PATH') p.push(`só um .ref(SNAPSHOT_PATH) é permitido; achei: ${refs.join(' | ') || 'nenhum'}`);
  if ((c.match(/\.set\(/g) || []).length !== 1) p.push('esperado exatamente 1 gravação (.set)');
  if (/\.(update|remove|push|transaction|get|once|on)\s*\(/.test(c)) p.push('operação de RTDB fora da gravação única');
  if (/\.message\b/.test(c)) p.push('lê .message de erro (pode trazer URL do projeto; o log é público)');
  if (/console\./.test(c)) p.push('console.* no armazenamento (quem loga é o run-scan, só com contagem)');
  return p;
}

export function problemasDaPublicacao(texto) {
  const c = semComentarioJs(texto);
  const p = [];
  const OK = new Set(['./observationSnapshot.mjs', './observationStore.mjs', './scanTimeout.mjs']);
  for (const spec of importsDe(c)) if (!OK.has(spec)) p.push(`import fora da lista: ${spec}`);
  if (/\bpg\b|adminEntities|adminTelegram|firebase/i.test(c.replace(/['"]\.\/observationStore\.mjs['"]/g, ''))) p.push('fala com Postgres/Telegram/Firebase direto (tudo passa pelo `backend` recebido e pelo armazenamento)');
  if (/\.message\b/.test(c)) p.push('lê .message de erro (o resultado só leva o código)');
  if (/console\./.test(c)) p.push('console.* na publicação (quem loga é o run-scan)');
  if (!/if \(!url\) return \{ ok: false, skipped: 'sem_url' \};/.test(c)) p.push('a 1ª coisa precisa ser: sem URL, sai sem tocar em nada');
  if (!/catch \(err\) \{\s*return \{ ok: false, erro: safeErrorCode\(err\) \};/.test(c)) p.push('o catch externo precisa devolver só o código (nunca lançar)');
  const antesDaURL = c.slice(0, c.indexOf("skipped: 'sem_url'"));
  if (/backend\.entities/.test(antesDaURL)) p.push('consulta ao banco ANTES de conferir a URL');
  return p;
}

export function problemasDoScanYml(yml) {
  const c = semComentarioYml(yml);
  const p = [];
  if (!/^\s+OBSERVATION_DATABASE_URL:\s*\$\{\{\s*secrets\.FIREBASE_DATABASE_URL\s*\}\}\s*$/m.test(c)) p.push('falta OBSERVATION_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}');
  if (/^\s+FIREBASE_DATABASE_URL:/m.test(c)) p.push('FIREBASE_DATABASE_URL como variável do scan moveria os marcadores de alerta do Firestore para o RTDB');
  const usos = [...c.matchAll(/secrets\.FIREBASE_DATABASE_URL/g)].length;
  if (usos !== 1) p.push(`secrets.FIREBASE_DATABASE_URL deveria aparecer 1 vez no scan.yml; achei ${usos}`);
  return p;
}

export function problemasDoRunScan(texto) {
  const p = [];
  const iChamada = texto.indexOf('await publishObservationSnapshot(');
  const iHealth = texto.indexOf('await withTimeout(checkAssetHealthchecks(assets)');
  const iResumo = texto.indexOf('formatScanSummary(summarizeScanPass(');
  if (iChamada < 0) p.push('a chamada do retrato sumiu do run-scan');
  else {
    if ((texto.match(/publishObservationSnapshot\(/g) || []).length !== 1) p.push('o retrato deveria ser chamado uma única vez');
    if (iHealth < 0 || iChamada < iHealth) p.push('o retrato precisa vir DEPOIS do price-check e do healthcheck');
    if (iResumo >= 0 && iChamada > iResumo) p.push('o retrato precisa vir ANTES do resumo por scan');
    // O bloco inteiro do retrato: `try {` abrindo na 1ª instrução, a chamada dentro, e o `catch` fixo que só avisa (mensagem FIXA, sem o erro).
    const bloco = /try \{\s*\n\s*const bancoComFalha[\s\S]*?\} catch \{\s*\n\s*console\.warn\('[^']*'\);\s*\n\s*\}/.exec(texto)?.[0];
    if (!bloco || !bloco.includes('await publishObservationSnapshot(')) {
      p.push('a chamada do retrato precisa estar dentro de try/catch (nunca fatal)');
      return p;
    }
    if (/process\.exit|forceExit|exitCode|throw /.test(bloco)) p.push('o bloco do retrato mexe no código de saída ou lança');
    if (!/isDatabaseQuotaExhausted/.test(bloco)) p.push('o retrato precisa ser pulado quando o banco falhou na passada');
  }
  if (!/from '\.\/observationPublish\.mjs'/.test(texto)) p.push('import do retrato ausente');
  return p;
}

// --- testes -----------------------------------------------------------------------------------------------------------------------------------

const planta = (arq, de, para) => {
  const t = ler(arq);
  if (!t.includes(de)) throw new Error(`trecho a plantar não existe em ${arq}: ${de}`);
  return t.replace(de, para);
};

describe('tripwire O1: arquivos reais seguem as regras', () => {
  it('módulo puro do retrato', () => expect(problemasDoSnapshot(ler(ARQ.snapshot))).toEqual([]));
  it('armazenamento no RTDB', () => expect(problemasDoArmazenamento(ler(ARQ.store))).toEqual([]));
  it('publicação', () => expect(problemasDaPublicacao(ler(ARQ.publish))).toEqual([]));
  it('scan.yml', () => expect(problemasDoScanYml(ler(ARQ.scanYml))).toEqual([]));
  it('run-scan.mjs', () => expect(problemasDoRunScan(ler(ARQ.runScan))).toEqual([]));
});

describe('tripwire O1: variantes plantadas são acusadas', () => {
  const casos = [
    ['snapshot importa algo', () => problemasDoSnapshot(`import fs from 'node:fs';\n${ler(ARQ.snapshot)}`)],
    ['snapshot lê o ambiente', () => problemasDoSnapshot(`${ler(ARQ.snapshot)}\nexport const x = process.env.X;`)],
    ['snapshot usa Date.now', () => problemasDoSnapshot(`${ler(ARQ.snapshot)}\nexport const t = Date.now();`)],
    ['store lê FIREBASE_DATABASE_URL', () => problemasDoArmazenamento(planta(ARQ.store, "env?.OBSERVATION_DATABASE_URL", "env?.FIREBASE_DATABASE_URL"))],
    ['store usa o app padrão', () => problemasDoArmazenamento(planta(ARQ.store, 'getDatabaseWithUrl(url, app)', 'getDatabase()'))],
    ['store sem o nome do app', () => problemasDoArmazenamento(planta(ARQ.store, "}, OBSERVATION_APP_NAME);", "});"))],
    ['store grava em outro caminho', () => problemasDoArmazenamento(planta(ARQ.store, "'observation/snapshot'", "'systemAlerts/snapshot'"))],
    ['store com um 2º ref', () => problemasDoArmazenamento(planta(ARQ.store, '.ref(SNAPSHOT_PATH).set(snapshot)', ".ref('observation/outro').set(1); getDb().ref(SNAPSHOT_PATH).set(snapshot)"))],
    ['store apaga nó', () => problemasDoArmazenamento(`${ler(ARQ.store)}\nexport const apagar = (db) => db.ref(SNAPSHOT_PATH).remove();`)],
    ['store lê .message', () => problemasDoArmazenamento(planta(ARQ.store, 'erro: safeErrorCode(err)', 'erro: err.message'))],
    ['store importa pg', () => problemasDoArmazenamento(`import pg from 'pg';\n${ler(ARQ.store)}`)],
    ['store com console.log', () => problemasDoArmazenamento(`${ler(ARQ.store)}\nconsole.log('x');`)],
    ['publicação importa o banco', () => problemasDaPublicacao(`import { backend } from './adminEntities.js';\n${ler(ARQ.publish)}`)],
    ['publicação lê .message', () => problemasDaPublicacao(planta(ARQ.publish, 'erro: safeErrorCode(err)', 'erro: err.message'))],
    ['publicação com console', () => problemasDaPublicacao(`${ler(ARQ.publish)}\nconsole.log('x');`)],
    ['publicação lê o banco antes de ver a URL', () => problemasDaPublicacao(planta(ARQ.publish, "const url = typeof env?.OBSERVATION_DATABASE_URL === 'string' ? env.OBSERVATION_DATABASE_URL.trim() : '';\n    if (!url)", "const url = typeof env?.OBSERVATION_DATABASE_URL === 'string' ? env.OBSERVATION_DATABASE_URL.trim() : '';\n    await backend.entities.TradeOperation.filter({});\n    if (!url)"))],
    ['publicação sem a saída antecipada', () => problemasDaPublicacao(planta(ARQ.publish, "if (!url) return { ok: false, skipped: 'sem_url' };", ''))],
    ['scan.yml sem a variável', () => problemasDoScanYml(planta(ARQ.scanYml, 'OBSERVATION_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}', 'X: 1'))],
    ['scan.yml com FIREBASE_DATABASE_URL', () => problemasDoScanYml(planta(ARQ.scanYml, 'OBSERVATION_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}', 'FIREBASE_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}'))],
    ['scan.yml com as duas', () => problemasDoScanYml(planta(ARQ.scanYml, 'OBSERVATION_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}', 'OBSERVATION_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}\n          FIREBASE_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}'))],
    ['run-scan sem a chamada', () => problemasDoRunScan(planta(ARQ.runScan, 'await publishObservationSnapshot(', 'await outraCoisa('))],
    ['run-scan com a chamada fora do try', () => problemasDoRunScan(planta(ARQ.runScan, '  try {\n    const bancoComFalha', '  {\n    const bancoComFalha'))],
    ['run-scan com a chamada duplicada', () => problemasDoRunScan(`${ler(ARQ.runScan)}\nawait publishObservationSnapshot({});`)],
    ['run-scan sem pular quando o banco falhou', () => problemasDoRunScan(planta(ARQ.runScan, 'isDatabaseQuotaExhausted(r.error)) || priceCheckErrors.some((e) => isDatabaseQuotaExhausted(e.error))', 'false'))],
    ['run-scan mexendo no código de saída', () => problemasDoRunScan(planta(ARQ.runScan, "console.log(describePublishResult(retrato));", "console.log(describePublishResult(retrato)); process.exitCode = 1;"))],
  ];

  it.each(casos)('%s', (_nome, montar) => {
    expect(montar().length).toBeGreaterThan(0);
  });
});
