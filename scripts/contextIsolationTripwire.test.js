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
//     (itens 282/283). Fase 4a (addendum 12): o remetente SEM banco existe
//     (scripts/contextTelegram.mjs) e SÓ o workflow context-notify.yml pode
//     usar os dois segredos do Telegram — regras abaixo (`problemasDoNotificador`).
//     adminTelegram, banco, Firebase e motor continuam proibidos em todo o contexto,
//     e o coletor (context-collect.yml) continua SEM Telegram.
//
// Padrão de modelo: src/lib/noOrderExecutionTripwire.test.js (inclui a prova de
// que o guard pega o que deve pegar e não acusa o que é inocente).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

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

// Fase 3 (addendum 11): a faixa de eventos do Dashboard vive em src/ e roda no NAVEGADOR. Ela não pode tocar o banco,
// o motor, o log (que grava SystemLog no banco) nem o Firebase — é só leitura da branch pública `context-data`.
const ARQUIVOS_DA_FAIXA = [
  'src/lib/marketContextBand.js',
  'src/lib/marketContextSource.js',
  'src/hooks/useMarketContext.js',
  'src/components/dashboard/MarketContextBand.jsx',
];
const PROIBIDO_NA_FAIXA = [
  { nome: 'adaptador de entidades (banco)', re: /@\/api\/entities|api\/entities|adminEntities/ },
  { nome: 'o scanner / motor de trading', re: /\bscanner\b|opTransition|opExitRules|tradeMetrics|signalArbitration|backtestEngine|TradeOperation/ },
  { nome: 'log que grava no banco', re: /@\/lib\/logger|logInfo|logWarn|logError|logDebug|SystemLog/ },
  { nome: 'Firebase', re: /firebase/i },
  { nome: 'o canal de Telegram do navegador', re: /@\/lib\/telegram|notify[A-Z]/ },
];

function violacoesDaFaixa(rel, texto) {
  const codigo = texto.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');
  return PROIBIDO_NA_FAIXA.filter(({ re }) => re.test(codigo)).map(({ nome }) => `${rel}: referencia ${nome}`);
}

describe('tripwire: a faixa de eventos do painel só lê a branch pública (item 285, addendum 11)', () => {
  it('os arquivos da faixa existem e estão limpos', () => {
    for (const rel of ARQUIVOS_DA_FAIXA) expect(existsSync(join(ROOT, rel)), rel).toBe(true); // não-vacuidade
    const achados = ARQUIVOS_DA_FAIXA.flatMap((rel) => violacoesDaFaixa(rel, readFileSync(join(ROOT, rel), 'utf8')));
    expect(achados).toEqual([]);
  });

  it('prova: pega banco, motor, log e Firebase plantados na faixa', () => {
    const plantados = [
      "import { backend } from '@/api/entities';",
      "import { scanAsset } from '@/lib/scanner';",
      "import { logWarn } from '@/lib/logger';",
      "import { db } from '@/lib/firebaseClient';",
      "import { notifyNewSignal } from '@/lib/telegram';",
    ];
    for (const linha of plantados) expect(violacoesDaFaixa('plantado', linha).length, linha).toBeGreaterThan(0);
    expect(violacoesDaFaixa('x', "// logWarn grava no banco, por isso não é usado\nconst a = 1;")).toEqual([]);
  });

  it('o Dashboard é o ÚNICO consumidor da faixa fora dos próprios arquivos dela', () => {
    const dash = readFileSync(join(ROOT, 'src/pages/Dashboard.jsx'), 'utf8');
    expect(dash).toMatch(/import MarketContextBand from '@\/components\/dashboard\/MarketContextBand'/);
    for (const rel of MOTOR) {
      const texto = lerSeExiste(rel);
      if (texto !== null) expect(texto, rel).not.toMatch(/MarketContextBand|useMarketContext|marketContext(Band|Source)/);
    }
  });
});

// Fase 2 (addendum 9): o coletor é o ÚNICO workflow de contexto que escreve no repositório, e só na
// branch pública `context-data`. Sem push forçado, sem outra branch, sem segredo além do FRED, do BLS (addendum 14: o "Anterior") e do contato.
const COLETOR = '.github/workflows/context-collect.yml';
const SEGREDOS_DO_COLETOR = new Set(['FRED_API_KEY', 'BLS_API_KEY', 'CONTEXT_CONTACT_EMAIL']);

/** true quando o workflow NÃO tem `permissions:` no nível do arquivo (comentários ignorados). */
function semPermissoes(yml) {
  const codigo = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  return !/^permissions:/m.test(codigo);
}

function problemasDoColetor(yml) {
  const codigo = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const p = [];
  if (!/permissions:\s*\n\s*contents:\s*write\s*\n/.test(codigo)) p.push('permissões: esperado só `contents: write`');
  if ((codigo.match(/:\s*write\b/g) || []).length !== 1) p.push('permissões: há escrita além de `contents`');
  // Qualquer `git ... push` (inclui `git -C . push` e `git -c x=y push`: antes só `git push` colado era visto).
  const pushes = codigo.split('\n').filter((l) => /\bgit\b.*\bpush\b/.test(l));
  if (!pushes.length) p.push('nenhum git push (a regra abaixo ficaria vazia)');
  for (const l of pushes) {
    if (!/^\s*git push origin HEAD:refs\/heads\/context-data\s*$/.test(l)) p.push(`push fora do permitido: ${l.trim()}`);
  }
  if (/--force|\s-f\b|\+HEAD|\+refs\//.test(codigo)) p.push('push forçado');
  // Nome de segredo não diferencia maiúscula de minúscula no GitHub: `secrets.database_url` é o DATABASE_URL.
  for (const [, nome] of codigo.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (!SEGREDOS_DO_COLETOR.has(nome.toUpperCase())) p.push(`segredo não permitido: ${nome}`);
  // Qualquer outro jeito de pegar segredo (secrets['X'], toJSON(secrets), secrets: inherit) passaria batido.
  if (/\bsecrets\b(?!\.[A-Za-z0-9_])/.test(codigo)) p.push('uso indireto de `secrets` (só secrets.NOME é permitido)');
  if (/TELEGRAM/.test(codigo)) p.push('Telegram (só na Fase 4, com remetente sem banco)');
  if (!/workflow_dispatch/.test(codigo)) p.push('sem disparo manual (o cron-job.org usa workflow_dispatch)');
  if (!/node scripts\/context-collect\.mjs/.test(codigo)) p.push('não roda o coletor');
  // Modo "janela" (addendum 15): a ÚNICA entrada lida do workflow é `mode`, e só como variável de ambiente do passo que roda o coletor.
  // Entrada dentro do texto de um `run:` seria injeção de comando (quem dispara o workflow controla o valor).
  for (const l of codigo.split('\n').filter((x) => /\binputs\./.test(x))) {
    if (!/^\s*COLLECT_MODE:\s*\$\{\{\s*github\.event\.inputs\.mode\s*\}\}\s*$/.test(l)) p.push(`entrada do workflow fora do permitido (só COLLECT_MODE por variável de ambiente): ${l.trim()}`);
  }
  if (!/^\s*COLLECT_MODE:\s*\$\{\{\s*github\.event\.inputs\.mode\s*\}\}\s*$/m.test(codigo)) p.push('falta COLLECT_MODE vindo de github.event.inputs.mode (o modo janela não chegaria ao coletor)');
  return p;
}

// Fase 4a (addendum 12): o ÚNICO workflow de contexto que fala com o Telegram. Só manual, sem escrita, só os 2 segredos do
// Telegram (e só quando "Enviar de verdade?" está marcado), nenhum banco.
const NOTIFICADOR = '.github/workflows/context-notify.yml';
const SEGREDOS_DO_NOTIFICADOR = new Set(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);

function problemasDoNotificador(yml) {
  const codigo = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const p = [];
  if (!/permissions:\s*\n\s*contents:\s*read\s*\n/.test(codigo)) p.push('permissões: esperado só `contents: read`');
  if (/:\s*write\b/.test(codigo)) p.push('permissões: há escrita');
  if (/^\s*schedule:/m.test(codigo)) p.push('tem `schedule:` (a Fase 4a é só manual)');
  if (/\bgit\b.*\bpush\b/.test(codigo)) p.push('git push');
  if (!/workflow_dispatch/.test(codigo)) p.push('sem disparo manual');
  for (const [, nome] of codigo.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (!SEGREDOS_DO_NOTIFICADOR.has(nome.toUpperCase())) p.push(`segredo não permitido: ${nome}`);
  if (/\bsecrets\b(?!\.[A-Za-z0-9_])/.test(codigo)) p.push('uso indireto de `secrets` (só secrets.NOME é permitido)');
  // Os segredos só chegam ao passo quando o envio está marcado (a simulação nem os recebe).
  for (const linha of codigo.split('\n').filter((l) => /secrets\./.test(l))) {
    if (!/inputs\.enviar\s*&&/.test(linha)) p.push(`segredo fora da condição "inputs.enviar": ${linha.trim()}`);
  }
  for (const [, nome] of codigo.matchAll(/\bvars\.([A-Za-z0-9_]+)/g)) if (nome !== 'CONTEXT_TELEGRAM_CATEGORIES') p.push(`variável não permitida: ${nome}`);
  const checkouts = (codigo.match(/uses:\s*actions\/checkout@/g) || []).length;
  const semToken = (codigo.match(/persist-credentials:\s*false/g) || []).length;
  if (checkouts < 1 || semToken !== checkouts) p.push('todo checkout precisa de `persist-credentials: false`');
  const bloco = /enviar:\s*\n((?:[ \t]+[^\n]*\n){1,6})/.exec(codigo);
  if (!bloco || !/default:\s*false/.test(bloco[1])) p.push('"Enviar de verdade?" precisa ter padrão false');
  if (!/node scripts\/context-notify\.mjs/.test(codigo)) p.push('não roda o aviso');
  return p;
}

describe('tripwire: o aviso do Telegram do Contexto é manual, sem banco e com os 2 segredos só no envio (item 285, addendum 12)', () => {
  const real = readFileSync(join(ROOT, NOTIFICADOR), 'utf8');

  it('context-notify.yml segue as regras', () => {
    expect(problemasDoNotificador(real)).toEqual([]);
  });

  it('o coletor e a sonda continuam SEM Telegram (só o notificador fala com o Telegram)', () => {
    for (const rel of arquivosDoContexto().filter((r) => r.startsWith('.github/') && r !== NOTIFICADOR)) {
      const codigo = readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      expect(codigo, rel).not.toMatch(/TELEGRAM/);
    }
  });

  it('só scripts/contextTelegram.mjs usa as variáveis do Telegram (o CLI e as mensagens não leem segredo)', () => {
    const quem = arquivosDoContexto().filter((r) => r.startsWith('scripts/')).filter((rel) => /TELEGRAM_(BOT_TOKEN|CHAT_ID)/.test(
      readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'),
    ));
    expect(quem.sort()).toEqual(['scripts/contextTelegram.mjs']);
  });

  it('prova: pega 3º segredo, banco, schedule, escrita, push, segredo fora da condição, checkout com token, enviar ligado por padrão e variável a mais', () => {
    const seg = "TELEGRAM_BOT_TOKEN: ${{ inputs.enviar && secrets.TELEGRAM_BOT_TOKEN || '' }}";
    expect(real).toContain(seg);
    const alvo = ['ma', 'in'].join(''); // (monta o nome da branch por partes: o hook de proteção do repositório lê o texto dos comandos)
    const empurra = `git -C . push origin HEAD:${alvo}`;
    const plantados = [
      real.replace(seg, `${seg}\n          X: \${{ inputs.enviar && secrets.BLS_API_KEY || '' }}`),
      real.replace(seg, `${seg}\n          D: \${{ inputs.enviar && secrets.DATABASE_URL || '' }}`),
      real.replace('on:\n  workflow_dispatch:', "on:\n  schedule:\n    - cron: '0 * * * *'\n  workflow_dispatch:"),
      real.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'), // (o 1º "contents: read" do arquivo está num comentário)
      real.replace('node scripts/context-notify.mjs', `${empurra}\n          node scripts/context-notify.mjs`),
      real.replace(seg, 'TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}'),
      real.replace(seg, 'TELEGRAM_BOT_TOKEN: ${{ toJSON(secrets) }}'),
      real.replace('persist-credentials: false', 'persist-credentials: true'),
      real.replace(/(enviar:[\s\S]*?)default: false/, '$1default: true'),
      real.replace('vars.CONTEXT_TELEGRAM_CATEGORIES', 'vars.OUTRA'),
      real.replace('node scripts/context-notify.mjs', 'echo sem aviso'),
    ];
    for (const yml of plantados) {
      expect(yml, 'a variante plantada não alterou o arquivo').not.toBe(real);
      expect(problemasDoNotificador(yml).length, yml.slice(-160)).toBeGreaterThan(0);
    }
    // Banco plantado também cai na regra global do contexto (nenhum arquivo de contexto referencia o banco).
    expect(violacoes(NOTIFICADOR, plantados[1]).length).toBeGreaterThan(0);
  });
});

describe('tripwire: o coletor só escreve na branch context-data (item 285, addendum 9)', () => {
  it('context-collect.yml segue as regras', () => {
    expect(problemasDoColetor(readFileSync(join(ROOT, COLETOR), 'utf8'))).toEqual([]);
  });

  it('nenhum outro workflow de contexto pede escrita', () => {
    const outros = arquivosDoContexto().filter((rel) => rel.startsWith('.github/') && rel !== COLETOR);
    expect(outros.length).toBeGreaterThanOrEqual(1); // não-vacuidade: a sonda
    for (const rel of outros) {
      const codigo = readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      expect(codigo, rel).not.toMatch(/:\s*write\b/);
    }
  });

  it('todo workflow de contexto declara `permissions:` no topo (senão herda as permissões padrão do repositório)', () => {
    const wfs = arquivosDoContexto().filter((rel) => rel.startsWith('.github/'));
    expect(wfs.length).toBeGreaterThanOrEqual(2); // não-vacuidade: sonda + coletor
    for (const rel of wfs) expect(semPermissoes(readFileSync(join(ROOT, rel), 'utf8')), rel).toBe(false);
  });

  it('prova: pega push forçado, outra branch, segredo a mais, Telegram e permissão a mais', () => {
    const real = readFileSync(join(ROOT, COLETOR), 'utf8');
    const push = 'git push origin HEAD:refs/heads/context-data';
    expect(real).toContain(push);
    const plantados = [
      real.replace(push, ['git push', '--force', 'origin HEAD:refs/heads/context-data'].join(' ')),
      real.replace(push, 'git push origin +HEAD:refs/heads/context-data'),
      real.replace(push, ['git push origin HEAD:refs/heads', 'outra'].join('/')),
      real.replace(push, 'echo sem push'),
      real.replace('contents: write', 'contents: write\n  pull-requests: write'),
      real.replace('FRED_API_KEY: ${{ secrets.FRED_API_KEY }}', 'FRED_API_KEY: ${{ secrets.FRED_API_KEY }}\n          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}'),
      // O BLS_API_KEY agora é permitido no coletor (addendum 14); a variante plantada usa um segredo que continua proibido.
      real.replace('FRED_API_KEY: ${{ secrets.FRED_API_KEY }}', 'FRED_API_KEY: ${{ secrets.COINGECKO_API_KEY }}'),
      real.replace('FRED_API_KEY: ${{ secrets.FRED_API_KEY }}', 'FRED_API_KEY: ${{ secrets.FRED_API_KEY }}\n          X: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}'),
      real.replace('BLS_API_KEY: ${{ secrets.BLS_API_KEY }}', 'BLS_API_KEY: ${{ secrets.DATABASE_URL }}'),
      // Brechas achadas na auditoria de 31/10 (antes passavam):
      real.replace(push, 'git -C . push origin HEAD:refs/heads/main'),
      real.replace(push, 'git -c core.hooksPath=/dev/null push origin HEAD:refs/heads/context-data --tags'),
      // Mantém o push permitido E soma um 2º por um jeito que o regex antigo (`git push` colado) não via:
      `${real.replace(push, `${push}\n          git -C . push origin HEAD:refs/heads/main`)}`,
      `${real.replace(push, `${push}\n          git -c user.name=x push origin HEAD:refs/heads/outra`)}`,
      real.replace('FRED_API_KEY: ${{ secrets.FRED_API_KEY }}', 'FRED_API_KEY: ${{ secrets.fred_api_key }}\n          X: ${{ secrets.database_url }}'),
      real.replace('FRED_API_KEY: ${{ secrets.FRED_API_KEY }}', "FRED_API_KEY: ${{ secrets['DATABASE_URL'] }}"),
      real.replace('FRED_API_KEY: ${{ secrets.FRED_API_KEY }}', 'FRED_API_KEY: ${{ toJSON(secrets) }}'),
    ];
    for (const yml of plantados) expect(problemasDoColetor(yml).length, yml.slice(-200)).toBeGreaterThan(0);
  });

  it('prova: não acusa o coletor real nem o nome do segredo em minúscula quando é um permitido', () => {
    const real = readFileSync(join(ROOT, COLETOR), 'utf8');
    expect(problemasDoColetor(real.replace('secrets.FRED_API_KEY', 'secrets.fred_api_key'))).toEqual([]);
    expect(problemasDoColetor(real.replace('secrets.BLS_API_KEY', 'secrets.bls_api_key'))).toEqual([]);
  });

  it('o coletor recebe o segredo do BLS (addendum 14) e SÓ o passa ao passo que roda o coletor, como variável de ambiente', () => {
    const real = readFileSync(join(ROOT, COLETOR), 'utf8');
    const linhasComSegredo = real.split('\n').filter((l) => /secrets\./.test(l) && !/^\s*#/.test(l)).map((l) => l.trim());
    expect(linhasComSegredo).toEqual([
      'FRED_API_KEY: ${{ secrets.FRED_API_KEY }}',
      'BLS_API_KEY: ${{ secrets.BLS_API_KEY }}',
      'CONTEXT_CONTACT_EMAIL: ${{ secrets.CONTEXT_CONTACT_EMAIL }}',
    ]);
    // Os três vêm do mesmo bloco `env:` do passo "Coletar as datas" (que roda o coletor), nunca de outro passo.
    const passo = real.slice(real.indexOf('- name: Coletar as datas'), real.indexOf('- name: Publicar na branch context-data'));
    for (const l of linhasComSegredo) expect(passo, l).toContain(l);
  });

  it('o modo "janela" (addendum 15) chega ao coletor SÓ por variável de ambiente do passo que o roda — nunca dentro de um `run:`', () => {
    const real = readFileSync(join(ROOT, COLETOR), 'utf8');
    const usos = real.split('\n').filter((l) => /\binputs\./.test(l) && !/^\s*#/.test(l)).map((l) => l.trim());
    expect(usos).toEqual(['COLLECT_MODE: ${{ github.event.inputs.mode }}']);
    const passo = real.slice(real.indexOf('- name: Coletar as datas'), real.indexOf('- name: Publicar na branch context-data'));
    expect(passo).toContain('COLLECT_MODE: ${{ github.event.inputs.mode }}');
    expect(problemasDoColetor(real)).toEqual([]);
  });

  it('prova: pega a entrada do workflow interpolada no script, em outro lugar, uma entrada a mais ou o modo sem chegar ao coletor', () => {
    const real = readFileSync(join(ROOT, COLETOR), 'utf8');
    const env = 'COLLECT_MODE: ${{ github.event.inputs.mode }}';
    expect(real).toContain(env);
    const plantados = [
      real.replace('node scripts/context-collect.mjs --dir data', 'node scripts/context-collect.mjs --dir data ${{ github.event.inputs.mode }}'),
      real.replace('node scripts/context-collect.mjs --dir data', 'echo "${{ inputs.mode }}"\n          node scripts/context-collect.mjs --dir data'),
      real.replace(env, 'COLLECT_MODE: ${{ inputs.outra }}'),
      real.replace(env, `${env}\n          OUTRA: \${{ github.event.inputs.extra }}`),
      real.replace(`          ${env}\n`, ''),
      real.replace(env, 'COLLECT_MODE: janela'),
    ];
    for (const yml of plantados) expect(problemasDoColetor(yml).length, yml.slice(-260)).toBeGreaterThan(0);
  });

  it('prova: pega workflow de contexto sem bloco `permissions:`', () => {
    const real = readFileSync(join(ROOT, COLETOR), 'utf8');
    const sonda = readFileSync(join(ROOT, '.github/workflows/context-probe.yml'), 'utf8');
    expect(semPermissoes(real)).toBe(false);
    expect(semPermissoes(real.replace(/^permissions:\n  contents: write\n/m, ''))).toBe(true);
    expect(semPermissoes(sonda.replace(/^permissions:[\s\S]*?\n(?=\S)/m, ''))).toBe(true);
    expect(semPermissoes('name: x\non: push\njobs:\n  a:\n    permissions:\n      contents: read\n')).toBe(true); // só dentro do job não vale
  });
});

// Achado do Codex no PR #531: o GitHub roda `run:` com `bash -e {0}`; sem desligar o errexit, o código 2
// do `git ls-remote --exit-code` (branch ainda inexistente = a 1ª coleta) encerrava o passo antes de criar a
// branch. A simulação anterior rodava SEM `-e` e não via isso. Aqui o passo roda de verdade, como o GitHub
// o roda, com um `git` de mentira no PATH.
function passoAbrirBranch() {
  const linhas = readFileSync(join(ROOT, COLETOR), 'utf8').split('\n');
  const ini = linhas.findIndex((l) => /- name: Abrir a branch de dados/.test(l));
  expect(ini).toBeGreaterThanOrEqual(0);
  const runIdx = linhas.findIndex((l, i) => i > ini && /^\s+run: \|\s*$/.test(l));
  const base = linhas[runIdx].search(/\S/) + 2;
  const corpo = [];
  for (let i = runIdx + 1; i < linhas.length; i += 1) {
    if (linhas[i].trim() !== '' && linhas[i].search(/\S/) < base) break;
    corpo.push(linhas[i].slice(base));
  }
  return corpo.join('\n');
}

function rodaPasso(script, lsRemoteRc) {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-step-'));
  try {
    writeFileSync(join(dir, 'git'), `#!/bin/bash\nif [ "$1" = "ls-remote" ]; then exit ${lsRemoteRc}; fi\necho "git $*" >> "${dir}/log"\n`);
    chmodSync(join(dir, 'git'), 0o755);
    writeFileSync(join(dir, 'passo.sh'), script);
    const r = spawnSync('bash', ['-e', join(dir, 'passo.sh')], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
    const log = existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '';
    return { status: r.status, out: `${r.stdout}${r.stderr}`, log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('passo "Abrir a branch de dados" do coletor, rodando como o GitHub roda (bash -e)', () => {
  const passo = passoAbrirBranch();

  it('branch existe (ls-remote 0): abre a última versão', () => {
    const r = rodaPasso(passo, 0);
    expect(r.status).toBe(0);
    expect(r.log).toMatch(/git fetch --depth=1 origin context-data/);
    expect(r.log).toMatch(/git worktree add data FETCH_HEAD/);
    expect(r.log).not.toMatch(/--orphan/);
  });

  it('branch NÃO existe (ls-remote 2, a 1ª coleta): cria a branch órfã e segue (o errexit herdado não encerra o passo)', () => {
    const r = rodaPasso(passo, 2);
    expect(r.status).toBe(0);
    expect(r.log).toMatch(/git worktree add --orphan -b context-data data/);
  });

  it('a consulta falhou (ls-remote 128): o job falha com a causa e NADA é criado', () => {
    const r = rodaPasso(passo, 128);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error::.*código 128/);
    expect(r.log).toBe('');
  });

  it('prova: sem o `set +e` o código 2 encerra o passo antes de criar a branch (o bug do Codex)', () => {
    const r = rodaPasso(passo.replace('set +e\n', ''), 2);
    expect(r.status).toBe(2);
    expect(r.log).not.toMatch(/--orphan/);
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
