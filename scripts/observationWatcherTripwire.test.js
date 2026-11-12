// Modo de observação sem banco, fase O2b (docs/known-risks.md item 299) — travas estruturais da LIGAÇÃO do vigia ao scan.
// O que importa aqui é o que NÃO pode mudar sem querer: o vigia nunca toca o Postgres (nem importa o adaptador do banco), grava só o episódio sob
// `observation/` e só depois de conferir as regras publicadas do RTDB, usa o Telegram SEM banco, busca velas só da Binance Spot com o símbolo validado,
// nunca lê `.message` de erro (o log do Actions é público), e entra no `run-scan.mjs` nos DOIS lugares certos (o `.catch` e o bloco de falha por ativo),
// no máximo uma vez, nunca fatal. Cada regra tem variantes PLANTADAS que precisam ser acusadas (.claude/rules/testing.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ler = (arq) => readFileSync(join(ROOT, arq), 'utf8');
const semComentarioJs = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const semComentarioYml = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const importsDe = (codigo) => [...codigo.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

const ARQ = {
  orquestrador: 'scripts/observationWatcher.mjs',
  armazenamento: 'scripts/observationWatchStore.mjs',
  velas: 'scripts/observationCandles.mjs',
  runScan: 'scripts/run-scan.mjs',
  scanYml: '.github/workflows/scan.yml',
};

const BANCO = /adminEntities|adminTelegram|\bbackend\b|from\s+['"]pg['"]|(?<!OBSERVATION_)\bDATABASE_URL\b|DATABASE_URL_READONLY/;

// --- regras (cada uma devolve a lista de problemas) -------------------------------------------------------------------------------------------

export function problemasDoOrquestrador(texto) {
  const c = semComentarioJs(texto);
  const p = [];
  const OK = new Set(['./contextTelegram.mjs', './observationWatchStore.mjs', './observationCandles.mjs', './observationWatch.mjs', './observationMessages.mjs', './observationSnapshot.mjs']);
  for (const spec of importsDe(c)) if (!OK.has(spec)) p.push(`import fora da lista: ${spec}`);
  if (BANCO.test(c)) p.push('toca o Postgres/adaptador do banco/adminTelegram: o vigia roda quando o banco está SEM COTA e não pode acordá-lo nem gravar nele');
  if (!/import\s*\{\s*sendTelegram\s*\}\s*from\s*'\.\/contextTelegram\.mjs'/.test(c)) p.push('o envio precisa usar o remetente SEM banco (contextTelegram.mjs)');
  if (/\.message\b/.test(c)) p.push('lê .message de erro (o log é público e a mensagem pode trazer URL/segredo)');
  if (/\bconsole\./.test(c)) p.push('console.* no orquestrador (quem loga é o run-scan, só com contagem e código)');
  const relogios = [...c.matchAll(/Date\.now\s*\(/g)].length;
  const padroes = [...c.matchAll(/nowMs\s*=\s*Date\.now\(\)/g)].length;
  if (relogios !== padroes) p.push('Date.now() fora do parâmetro padrão `nowMs = Date.now()`: o relógio vem por parâmetro');
  if (/new Date\(\s*\)/.test(c)) p.push('new Date() sem argumento é o relógio global');
  if (/\bprocess\.(?!env\b)/.test(c) || /process\.exit/.test(c)) p.push('mexe em process (saída/ambiente) além de process.env');
  if (!/if \(!url\) return \{ ok: false, skipped: 'sem_url' \};/.test(c)) p.push('a saída antecipada "sem URL" sumiu (sem a URL o vigia não pode fazer nada)');
  if ((c.match(/if \(!url\) return \{ ok: false, skipped: 'sem_url' \};/g) || []).length !== 2) p.push('as duas funções (vigia e fechamento) precisam sair cedo sem a URL');
  // Grava o episódio ANTES de qualquer envio de aviso de stop/alvo: sem o livro gravado, o aviso se repetiria.
  const iGrava = c.indexOf('rtdb.setEpisode(');
  const iAlerta = c.indexOf('buildWatchAlert(');
  if (iGrava < 0) p.push('não grava o episódio');
  else if (iAlerta >= 0 && iGrava > iAlerta) p.push('envia aviso de stop/alvo ANTES de gravar o episódio');
  // Confere as regras publicadas ANTES de qualquer envio, no vigia E no fechamento (achado do Codex, PR #572).
  const nPre = [...c.matchAll(/await rtdb\.ensureWritable\(\)/g)].length;
  if (nPre !== 2) p.push(`as duas funções (vigia e fechamento) precisam chamar rtdb.ensureWritable() antes de enviar; achei ${nPre}`);
  const iPre = c.indexOf('await rtdb.ensureWritable()');
  if (iPre < 0 || (c.indexOf('enviarComPausa(') >= 0 && iPre > c.indexOf('enviarComPausa('))) p.push('a conferência das regras publicadas precisa vir antes do primeiro envio do vigia');
  const iFechaFn = c.indexOf('export async function closeObservationEpisode');
  const iPreFecha = c.indexOf('await rtdb.ensureWritable()', iFechaFn);
  if (iFechaFn >= 0 && (iPreFecha < 0 || iPreFecha > c.indexOf('await enviar(texto)', iFechaFn))) p.push('o fechamento precisa conferir as regras antes de mandar o aviso de volta');
  // Só vigia com retrato bom.
  if (!/episode\.status === 'watching' && ops\.length > 0/.test(c)) p.push('o vigia precisa rodar só com o episódio em "watching"');
  // Envia primeiro, marca depois (pelo menos uma vez, nunca zero).
  const iEnviar = c.indexOf('const r = await enviarComPausa(texto);', iAlerta);
  if (iAlerta < 0 || iEnviar < 0) p.push('o envio do aviso de stop/alvo sumiu');
  else {
    if (c.slice(iAlerta, iEnviar).includes('marcar(')) p.push('o aviso é marcado no livro ANTES de ser enviado (se o envio falhar, o aviso se perderia)');
    if (!c.slice(iEnviar).includes('await marcar(')) p.push('depois de enviar o aviso, ele precisa ser marcado no livro');
  }
  // Fechamento: avisa antes de marcar o fim (se o envio falhar, o fim não é marcado).
  const iFecha = c.indexOf('export async function closeObservationEpisode');
  const corpoFecha = iFecha >= 0 ? c.slice(iFecha) : '';
  const iAvisoVolta = corpoFecha.indexOf('await enviar(texto)');
  const iFim = corpoFecha.indexOf('patchEpisode({ ended_at');
  if (iAvisoVolta < 0 || iFim < 0 || iFim < iAvisoVolta) p.push('o fechamento precisa avisar na volta ANTES de marcar o fim do episódio');
  return p;
}

export function problemasDoArmazenamentoDoVigia(texto) {
  const c = semComentarioJs(texto);
  const p = [];
  const OK = new Set(['firebase-admin/app', 'firebase-admin/database', './scanTimeout.mjs', './observationSnapshot.mjs', './observationRules.mjs', './observationStore.mjs', './observationWatch.mjs']);
  for (const spec of importsDe(c)) if (!OK.has(spec)) p.push(`import fora da lista: ${spec}`);
  if (BANCO.test(c)) p.push('toca o Postgres/adaptador do banco/adminTelegram');
  if (/FIREBASE_DATABASE_URL/.test(c)) p.push('lê FIREBASE_DATABASE_URL: a URL do vigia é OBSERVATION_DATABASE_URL (a outra move os marcadores de alerta)');
  if (/\bgetDatabase\s*\(/.test(c)) p.push('getDatabase() usa o app PADRÃO; o vigia usa getDatabaseWithUrl com app nomeado');
  if (!/initializeApp\([^;]*,\s*OBSERVATION_APP_NAME\s*\)/.test(c)) p.push('initializeApp precisa receber o NOME do app (nunca o app padrão)');
  const caminho = /EPISODE_PATH\s*=\s*'([^']+)'/.exec(c)?.[1];
  if (caminho !== 'observation/episode') p.push('EPISODE_PATH precisa ser o nó fixo observation/episode');
  // Gravação: só no episódio, e só DEPOIS de conferir as regras publicadas.
  const gravacoes = [...c.matchAll(/\.ref\(([^)]*)\)\s*\.(set|update|remove|push|transaction)\(/g)].map((m) => `${m[1].trim()}.${m[2]}`);
  const esperadas = ['EPISODE_PATH.set', 'EPISODE_PATH.update'];
  if (JSON.stringify([...gravacoes].sort()) !== JSON.stringify(esperadas)) p.push(`gravações permitidas: ${esperadas.join(' e ')}; achei: ${gravacoes.join(' | ') || 'nenhuma'}`);
  if (/SNAPSHOT_PATH\)\s*\.(set|update|remove|push|transaction)/.test(c)) p.push('o vigia nunca escreve no retrato (quem o escreve é a O1)');
  for (const [nome, marca] of [['setEpisode', '.set(episode)'], ['patchEpisode', '.update(updates)']]) {
    const i = c.indexOf(`async function ${nome}(`);
    const corpo = i >= 0 ? c.slice(i, c.indexOf('\n  }\n', i)) : '';
    const iRegras = corpo.indexOf('await ensureRulesSafe(');
    const iGrava = corpo.indexOf(marca);
    if (iRegras < 0 || iGrava < 0 || iRegras > iGrava) p.push(`${nome} precisa conferir as regras publicadas ANTES de gravar`);
  }
  if (!/problemasDasRegrasDoRtdb\(\s*publicadas\s*\)\.length\s*>\s*0\)\s*throw codeError\('regras_abertas'\)/.test(c)) p.push('não recusa a gravação quando as regras publicadas expõem o nó');
  if (!/catch \{\s*throw codeError\('regras_nao_verificadas'\)/.test(c)) p.push('não falha para o lado seguro quando não consegue ler as regras publicadas');
  // O resultado "seguro" é lembrado só depois de conferido.
  const iLembra = c.indexOf('regrasVerificadas = true;');
  const iAbertas = c.indexOf("throw codeError('regras_abertas')");
  if (iLembra < 0 || iAbertas < 0 || iLembra < iAbertas) p.push('o resultado da conferência só pode ser lembrado DEPOIS de recusar as regras abertas');
  // O `update` só aceita chaves conhecidas, e o episódio gravado precisa parecer um episódio.
  if (!/async function ensureWritable\(\) \{[\s\S]*?await ensureRulesSafe\(getDb\(\)\);/.test(c)) p.push('ensureWritable precisa conferir as regras publicadas');
  if (!/keys\.every\(validPatchKey\)/.test(c)) p.push('o update do episódio precisa validar as chaves');
  if (!/typeof episode\.started_at !== 'string'/.test(c)) p.push('o episódio gravado precisa ser validado');
  if (/\.message\b/.test(c)) p.push('lê .message de erro (pode trazer URL do projeto; o log é público)');
  if (/\bconsole\./.test(c)) p.push('console.* no armazenamento do vigia');
  return p;
}

export function problemasDasVelas(texto) {
  const c = semComentarioJs(texto);
  const p = [];
  const OK = new Set(['../src/lib/httpRetry.js', './observationWatch.mjs']);
  for (const spec of importsDe(c)) if (!OK.has(spec)) p.push(`import fora da lista: ${spec}`);
  if (BANCO.test(c)) p.push('toca o Postgres/adaptador do banco/adminTelegram');
  if (!/BINANCE_BASE_URL\s*=\s*'https:\/\/data-api\.binance\.vision\/api\/v3'/.test(c)) p.push('a fonte das velas precisa ser a Binance Spot (data-api.binance.vision), a mesma do cron');
  if (/fapi\.binance/.test(c)) p.push('Futures dá 451 em datacenter dos EUA (item 4 de docs/known-risks.md)');
  if (/\.message\b/.test(c)) p.push('lê .message de erro (pode citar a URL)');
  if (/\bconsole\./.test(c)) p.push('console.* na busca de velas');
  if (/apikey|api_key|X-MBX-APIKEY|Authorization/i.test(c)) p.push('a busca de velas é pública: nenhuma chave');
  const iValida = c.indexOf('if (!isValidSymbol(symbol)) return');
  const iPede = c.indexOf('await fetchFn(');
  if (iValida < 0 || iPede < 0 || iValida > iPede) p.push('o símbolo (dado do banco) precisa ser validado ANTES de entrar na URL');
  if (!/SYMBOL_RE\s*=\s*\/\^\[A-Z0-9\]\{2,20\}\$\//.test(c)) p.push('a regra do símbolo precisa ser só maiúsculas e números (2 a 20)');
  const ctx = /context:\s*([^,}]+)/.exec(c)?.[1]?.trim();
  if (ctx !== 'FIXED_CONTEXT' || !/FIXED_CONTEXT\s*=\s*'[^'$]*'/.test(c)) p.push('o contexto do retry vai para o log PÚBLICO: precisa ser um texto fixo, nunca o símbolo');
  if (!/c\.openTime \+ CANDLE_MS <= nowMs/.test(c)) p.push('só vela FECHADA decide');
  return p;
}

export function problemasDoRunScanO2(texto) {
  const p = [];
  if (!/from '\.\/observationWatcher\.mjs'/.test(texto)) p.push('import do vigia ausente');
  if ((texto.match(/runObservationWatch\(/g) || []).length !== 1) p.push('runObservationWatch deveria ser chamado uma única vez (dentro do wrapper seguro)');
  if ((texto.match(/closeObservationEpisode\(/g) || []).length !== 1) p.push('closeObservationEpisode deveria ser chamado uma única vez (dentro do wrapper seguro)');

  // Wrappers: nunca fatais, no máximo uma vez, com prazo e mensagem FIXA.
  const wRun = /async function runObservationWatchSafely\(\) \{[\s\S]*?\n\}\n/.exec(texto)?.[0] ?? '';
  const wClose = /async function closeObservationEpisodeSafely\(\) \{[\s\S]*?\n\}\n/.exec(texto)?.[0] ?? '';
  if (!wRun) p.push('wrapper runObservationWatchSafely ausente');
  else {
    if (!/if \(observationWatchRan\) return;\s*\n\s*observationWatchRan = true;/.test(wRun)) p.push('o vigia precisa rodar no máximo uma vez por processo');
    if (!/withTimeout\(runObservationWatch\(\{\}\), OBSERVATION_WATCH_TIMEOUT_MS/.test(wRun)) p.push('o vigia precisa ter prazo (withTimeout)');
    if (!/catch \{\s*\n\s*console\.warn\('[^']*'\);/.test(wRun)) p.push('o catch do vigia precisa ser sem variável e com mensagem FIXA');
    if (/process\.exit|forceExit|exitCode|throw |backend\./.test(wRun)) p.push('o wrapper do vigia mexe no código de saída, lança ou usa o banco');
  }
  if (!wClose) p.push('wrapper closeObservationEpisodeSafely ausente');
  else {
    if (!/withTimeout\(closeObservationEpisode\(\{\}\), OBSERVATION_CLOSE_TIMEOUT_MS/.test(wClose)) p.push('o fechamento precisa ter prazo (withTimeout)');
    if (!/catch \{\s*\n\s*console\.warn\('[^']*'\);/.test(wClose)) p.push('o catch do fechamento precisa ser sem variável e com mensagem FIXA');
    if (/process\.exit|forceExit|exitCode|throw |backend\./.test(wClose)) p.push('o wrapper do fechamento mexe no código de saída, lança ou usa o banco');
  }

  // Ponto 1: no `.catch` (queda real: o scan lança), só para cota do banco, ANTES do forceExit.
  const iCatch = texto.indexOf('.catch(async (err) => {');
  const corpoCatch = iCatch >= 0 ? texto.slice(iCatch, texto.indexOf('forceExit(1);', iCatch) + 'forceExit(1);'.length) : '';
  if (!corpoCatch) p.push('o .catch do ponto de entrada sumiu');
  else if (!/if \(classifyFailure\(err\?\.message\)\.kind === 'db_quota'\) await runObservationWatchSafely\(\);/.test(corpoCatch)) p.push('o .catch precisa chamar o vigia SÓ para cota do banco (classifyFailure === db_quota), antes do forceExit');

  // Ponto 2: falha por ativo dentro de main(), no bloco do retrato (O1), guardado por `bancoComFalha`.
  const bloco = /try \{\s*\n\s*const bancoComFalha[\s\S]*?\} catch \{\s*\n\s*console\.warn\('[^']*'\);\s*\n\s*\}/.exec(texto)?.[0] ?? '';
  if (!/if \(bancoComFalha\) await runObservationWatchSafely\(\);/.test(bloco)) p.push('o bloco do retrato precisa chamar o vigia quando o banco falhou na passada');
  else if (bloco.indexOf('runObservationWatchSafely') > bloco.indexOf('publishObservationSnapshot(')) p.push('o vigia precisa ser chamado ANTES de decidir pelo retrato');
  if (/publishObservationSnapshot\([^)]*\)[\s\S]{0,40}runObservationWatchSafely/.test(bloco) && !/bancoComFalha\s*\n?\s*\?/.test(bloco)) p.push('o retrato não pode ser regravado quando o banco falhou');

  // Ponto 3: fechamento só em passada limpa, logo depois do aviso de volta do banco.
  if (!/await announceQuotaRecoveryIfClean\(\);\s*\n\s*if \(!sawDbQuotaFailure\) await closeObservationEpisodeSafely\(\);/.test(texto)) p.push('o fechamento do episódio precisa vir logo depois de announceQuotaRecoveryIfClean e só se !sawDbQuotaFailure');
  return p;
}

export function problemasDoScanYmlO2(yml) {
  const c = semComentarioYml(yml);
  const p = [];
  for (const nome of ['OBSERVATION_DATABASE_URL', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (!new RegExp(`^\\s+${nome}:\\s*\\$\\{\\{\\s*secrets\\.`, 'm').test(c)) p.push(`falta ${nome} no passo "npm run scan" (o vigia precisa dele)`);
  }
  if (/^\s+FIREBASE_DATABASE_URL:/m.test(c)) p.push('FIREBASE_DATABASE_URL como variável do scan moveria os marcadores de alerta do Firestore para o RTDB');
  return p;
}

// --- testes -----------------------------------------------------------------------------------------------------------------------------------

const planta = (arq, de, para) => {
  const t = ler(arq);
  if (!t.includes(de)) throw new Error(`trecho a plantar não existe em ${arq}: ${de}`);
  return t.replace(de, para);
};

describe('tripwire O2b: arquivos reais seguem as regras', () => {
  it('orquestrador', () => expect(problemasDoOrquestrador(ler(ARQ.orquestrador))).toEqual([]));
  it('armazenamento do vigia', () => expect(problemasDoArmazenamentoDoVigia(ler(ARQ.armazenamento))).toEqual([]));
  it('busca de velas', () => expect(problemasDasVelas(ler(ARQ.velas))).toEqual([]));
  it('run-scan.mjs', () => expect(problemasDoRunScanO2(ler(ARQ.runScan))).toEqual([]));
  it('scan.yml', () => expect(problemasDoScanYmlO2(ler(ARQ.scanYml))).toEqual([]));
});

describe('tripwire O2b: variantes plantadas são acusadas', () => {
  const casos = [
    // orquestrador
    ['orquestrador importa o adaptador do banco', () => problemasDoOrquestrador(`import { backend } from './adminEntities.js';\n${ler(ARQ.orquestrador)}`)],
    ['orquestrador importa o Telegram com banco', () => problemasDoOrquestrador(`import { notifyStopHit } from './adminTelegram.js';\n${ler(ARQ.orquestrador)}`)],
    ['orquestrador importa pg', () => problemasDoOrquestrador(`import pg from 'pg';\n${ler(ARQ.orquestrador)}`)],
    ['orquestrador cita DATABASE_URL', () => problemasDoOrquestrador(`${ler(ARQ.orquestrador)}\nexport const u = process.env.DATABASE_URL;`)],
    ['orquestrador importa algo fora da lista', () => problemasDoOrquestrador(`import fs from 'node:fs';\n${ler(ARQ.orquestrador)}`)],
    ['orquestrador lê .message', () => problemasDoOrquestrador(planta(ARQ.orquestrador, "return { ok: false, erro: safeErrorCode(err) };\n  }\n}\n\n/**\n * O banco voltou", "return { ok: false, erro: err.message };\n  }\n}\n\n/**\n * O banco voltou"))],
    ['orquestrador loga', () => problemasDoOrquestrador(`${ler(ARQ.orquestrador)}\nconsole.log('x');`)],
    ['orquestrador usa o relógio global', () => problemasDoOrquestrador(`${ler(ARQ.orquestrador)}\nexport const t = Date.now();`)],
    ['orquestrador usa new Date()', () => problemasDoOrquestrador(`${ler(ARQ.orquestrador)}\nexport const t = new Date();`)],
    ['orquestrador sai do processo', () => problemasDoOrquestrador(`${ler(ARQ.orquestrador)}\nprocess.exit(1);`)],
    ['orquestrador sem o remetente sem banco', () => problemasDoOrquestrador(planta(ARQ.orquestrador, "import { sendTelegram } from './contextTelegram.mjs';", "import { sendTelegram } from './outro.mjs';"))],
    ['vigia sem saída antecipada sem URL', () => problemasDoOrquestrador(planta(ARQ.orquestrador, "    if (!url) return { ok: false, skipped: 'sem_url' };\n\n    const rtdb = store ?? createObservationWatchStore({ env });\n    const enviar = send ?? ((text) => sendTelegram({ text, env }));\n    const velas", "    const rtdb = store ?? createObservationWatchStore({ env });\n    const enviar = send ?? ((text) => sendTelegram({ text, env }));\n    const velas"))],
    ['vigia vigia com retrato velho', () => problemasDoOrquestrador(planta(ARQ.orquestrador, "episode.status === 'watching' && ops.length > 0", "ops.length > 0"))],
    ['vigia marca antes de enviar', () => problemasDoOrquestrador(planta(ARQ.orquestrador, "            const r = await enviarComPausa(texto);\n            if (!r.ok) { bump(resumo.send_errors, r.reason); continue; }", "            await marcar({ alerts_sent: 1 }, {});\n            const r = await enviarComPausa(texto);\n            if (!r.ok) { bump(resumo.send_errors, r.reason); continue; }"))],
    ['fechamento marca o fim antes de avisar', () => problemasDoOrquestrador(planta(ARQ.orquestrador, "    let notified = false;\n    if (ep.announced === true) {", "    await rtdb.patchEpisode({ ended_at: 'x' });\n    let notified = false;\n    if (ep.announced === true) {"))],
    ['vigia sem conferir as regras antes de enviar', () => problemasDoOrquestrador(planta(ARQ.orquestrador, "    const gravavel = await rtdb.ensureWritable();\n    if (!gravavel.ok) return { ok: false, erro: safeCode(gravavel.erro ?? gravavel.skipped) };\n    if (decisao.kind", "    if (decisao.kind"))],
    ['fechamento sem conferir as regras antes do aviso de volta', () => problemasDoOrquestrador(planta(ARQ.orquestrador, "    // Mesma regra do vigia: não manda o aviso de volta sem poder marcar o fim (senão repetiria a cada scan).\n    const gravavel = await rtdb.ensureWritable();\n    if (!gravavel.ok) return { ok: false, erro: safeCode(gravavel.erro ?? gravavel.skipped) };\n", ""))],
    ['store: ensureWritable sem conferir as regras', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, "      await ensureRulesSafe(getDb());\n      return { ok: true };", "      getDb();\n      return { ok: true };"))],
    ['velas com o símbolo no contexto do retry', () => problemasDasVelas(planta(ARQ.velas, "context: FIXED_CONTEXT", "context: `${symbol} 15m`"))],
    ['velas com contexto fixo que interpola', () => problemasDasVelas(planta(ARQ.velas, "const FIXED_CONTEXT = 'vigia (velas de 15 min)';", "const FIXED_CONTEXT = `vigia ${'x'}`;"))],
    // armazenamento do vigia
    ['store importa o banco', () => problemasDoArmazenamentoDoVigia(`import pg from 'pg';\n${ler(ARQ.armazenamento)}`)],
    ['store lê FIREBASE_DATABASE_URL', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, 'env?.OBSERVATION_DATABASE_URL', 'env?.FIREBASE_DATABASE_URL'))],
    ['store usa o app padrão', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, 'firebase.getDatabaseWithUrl(url, app)', 'firebase.getDatabase()'))],
    ['store sem o nome do app', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, 'databaseURL: url }, OBSERVATION_APP_NAME)', 'databaseURL: url })'))],
    ['store com outro caminho de episódio', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, "export const EPISODE_PATH = 'observation/episode';", "export const EPISODE_PATH = 'systemAlerts/episode';"))],
    ['store apaga o nó', () => problemasDoArmazenamentoDoVigia(`${ler(ARQ.armazenamento)}\nexport const apagar = (db) => db.ref(EPISODE_PATH).remove();`)],
    ['store escreve no retrato', () => problemasDoArmazenamentoDoVigia(`${ler(ARQ.armazenamento)}\nexport const x = (db) => db.ref(SNAPSHOT_PATH).set(1);`)],
    ['store grava sem conferir as regras (set)', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, "      await ensureRulesSafe(banco);\n      await withTimeout(banco.ref(EPISODE_PATH).set(episode)", "      await withTimeout(banco.ref(EPISODE_PATH).set(episode)"))],
    ['store grava sem conferir as regras (update)', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, "      await ensureRulesSafe(banco);\n      await withTimeout(banco.ref(EPISODE_PATH).update(updates)", "      await withTimeout(banco.ref(EPISODE_PATH).update(updates)"))],
    ['store confere as regras DEPOIS de gravar', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, "      await ensureRulesSafe(banco);\n      await withTimeout(banco.ref(EPISODE_PATH).set(episode), timeoutMs, 'observationWatchSet');", "      await withTimeout(banco.ref(EPISODE_PATH).set(episode), timeoutMs, 'observationWatchSet');\n      await ensureRulesSafe(banco);"))],
    ['store não recusa regra aberta', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, "throw codeError('regras_abertas');", "/* segue */;"))],
    ['store segue gravando se não lê as regras', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, "throw codeError('regras_nao_verificadas'); // sem repetir nada do erro (pode trazer a URL do projeto)", "return;"))],
    ['store lembra o resultado antes de recusar', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, "    if (problemasDasRegrasDoRtdb(publicadas).length > 0) throw codeError('regras_abertas');\n    regrasVerificadas = true;", "    regrasVerificadas = true;\n    if (problemasDasRegrasDoRtdb(publicadas).length > 0) throw codeError('regras_abertas');"))],
    ['store sem validar as chaves do update', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, 'keys.length === 0 || !keys.every(validPatchKey)', 'keys.length === 0'))],
    ['store sem validar o episódio', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, "typeof episode.started_at !== 'string'", 'false'))],
    ['store lê .message', () => problemasDoArmazenamentoDoVigia(planta(ARQ.armazenamento, "      return { ok: false, erro: safeErrorCode(err) };\n    }\n  }\n\n  async function setEpisode", "      return { ok: false, erro: err.message };\n    }\n  }\n\n  async function setEpisode"))],
    ['store com console', () => problemasDoArmazenamentoDoVigia(`${ler(ARQ.armazenamento)}\nconsole.log('x');`)],
    // velas
    ['velas importam o banco', () => problemasDasVelas(`import { backend } from './adminEntities.js';\n${ler(ARQ.velas)}`)],
    ['velas pela Futures', () => problemasDasVelas(planta(ARQ.velas, 'https://data-api.binance.vision/api/v3', 'https://fapi.binance.com/fapi/v1'))],
    ['velas com chave', () => problemasDasVelas(`${ler(ARQ.velas)}\nexport const h = { 'X-MBX-APIKEY': 'x' };`)],
    ['velas sem validar o símbolo antes do pedido', () => problemasDasVelas(planta(ARQ.velas, 'if (!isValidSymbol(symbol)) return { ok: false, reason: \'simbolo_invalido\' };', ''))],
    ['velas aceitam símbolo minúsculo', () => problemasDasVelas(planta(ARQ.velas, 'const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;', 'const SYMBOL_RE = /^[A-Za-z0-9]{2,20}$/;'))],
    ['velas incluem a vela aberta', () => problemasDasVelas(planta(ARQ.velas, '.filter((c) => c.openTime + CANDLE_MS <= nowMs)', '.filter((c) => true)'))],
    ['velas leem .message', () => problemasDasVelas(planta(ARQ.velas, '    } catch {\n      // De propósito não olhamos `err.message`: pode conter a URL.\n      return { ok: false, reason: \'rede\' };', '    } catch (err) {\n      return { ok: false, reason: err.message };'))],
    ['velas com console', () => problemasDasVelas(`${ler(ARQ.velas)}\nconsole.log('x');`)],
    // run-scan
    ['run-scan sem o import do vigia', () => problemasDoRunScanO2(planta(ARQ.runScan, "from './observationWatcher.mjs'", "from './outro.mjs'"))],
    ['run-scan com o vigia chamado sem o wrapper', () => problemasDoRunScanO2(`${ler(ARQ.runScan)}\nawait runObservationWatch({});`)],
    ['run-scan com o fechamento chamado sem o wrapper', () => problemasDoRunScanO2(`${ler(ARQ.runScan)}\nawait closeObservationEpisode({});`)],
    ['run-scan com o vigia sem rodar uma vez só', () => problemasDoRunScanO2(planta(ARQ.runScan, '  if (observationWatchRan) return;\n  observationWatchRan = true;\n', ''))],
    ['run-scan com o vigia sem prazo', () => problemasDoRunScanO2(planta(ARQ.runScan, 'withTimeout(runObservationWatch({}), OBSERVATION_WATCH_TIMEOUT_MS, \'observationWatch\')', 'runObservationWatch({})'))],
    ['run-scan com o catch do vigia mostrando o erro', () => problemasDoRunScanO2(planta(ARQ.runScan, "  } catch {\n    console.warn('[scan] vigia indisponível (não crítico)');", "  } catch (e) {\n    console.warn('[scan] vigia indisponível', e.message);"))],
    ['run-scan com o wrapper do vigia saindo do processo', () => problemasDoRunScanO2(planta(ARQ.runScan, "    console.warn('[scan] vigia indisponível (não crítico)');", "    console.warn('[scan] vigia indisponível (não crítico)'); forceExit(2);"))],
    ['run-scan com o fechamento sem prazo', () => problemasDoRunScanO2(planta(ARQ.runScan, 'withTimeout(closeObservationEpisode({}), OBSERVATION_CLOSE_TIMEOUT_MS, \'observationClose\')', 'closeObservationEpisode({})'))],
    ['run-scan sem o gancho no .catch', () => problemasDoRunScanO2(planta(ARQ.runScan, "      if (classifyFailure(err?.message).kind === 'db_quota') await runObservationWatchSafely();\n", ''))],
    ['run-scan com o gancho do .catch para qualquer erro', () => problemasDoRunScanO2(planta(ARQ.runScan, "if (classifyFailure(err?.message).kind === 'db_quota') await runObservationWatchSafely();", 'await runObservationWatchSafely();'))],
    ['run-scan com o gancho do .catch depois do forceExit', () => problemasDoRunScanO2(planta(ARQ.runScan, "      if (classifyFailure(err?.message).kind === 'db_quota') await runObservationWatchSafely();\n      // forceExit", "      // forceExit"))],
    ['run-scan sem o gancho no bloco do retrato', () => problemasDoRunScanO2(planta(ARQ.runScan, "    if (bancoComFalha) await runObservationWatchSafely();", ''))],
    ['run-scan chama o vigia sem o banco ter falhado', () => problemasDoRunScanO2(planta(ARQ.runScan, 'if (bancoComFalha) await runObservationWatchSafely();', 'await runObservationWatchSafely();'))],
    ['run-scan sem o fechamento do episódio', () => problemasDoRunScanO2(planta(ARQ.runScan, "  if (!sawDbQuotaFailure) await closeObservationEpisodeSafely();\n", ''))],
    ['run-scan fecha o episódio mesmo com o banco falhando', () => problemasDoRunScanO2(planta(ARQ.runScan, 'if (!sawDbQuotaFailure) await closeObservationEpisodeSafely();', 'await closeObservationEpisodeSafely();'))],
    ['run-scan fecha o episódio antes do aviso de volta', () => problemasDoRunScanO2(planta(ARQ.runScan, "  await announceQuotaRecoveryIfClean();\n  if (!sawDbQuotaFailure) await closeObservationEpisodeSafely();", "  if (!sawDbQuotaFailure) await closeObservationEpisodeSafely();\n  await announceQuotaRecoveryIfClean();"))],
    // scan.yml
    ['scan.yml sem o segredo do Telegram', () => problemasDoScanYmlO2(planta(ARQ.scanYml, 'TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}', 'X: 1'))],
    ['scan.yml sem a credencial do Firebase', () => problemasDoScanYmlO2(planta(ARQ.scanYml, 'FIREBASE_SERVICE_ACCOUNT_JSON: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}', 'X: 1'))],
    ['scan.yml sem a URL da observação', () => problemasDoScanYmlO2(planta(ARQ.scanYml, 'OBSERVATION_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}', 'X: 1'))],
    ['scan.yml com FIREBASE_DATABASE_URL', () => problemasDoScanYmlO2(planta(ARQ.scanYml, 'OBSERVATION_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}', 'OBSERVATION_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}\n          FIREBASE_DATABASE_URL: ${{ secrets.FIREBASE_DATABASE_URL }}'))],
  ];

  it.each(casos)('%s', (_nome, montar) => {
    expect(montar().length).toBeGreaterThan(0);
  });
});
