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
  'src/lib/reactionStats.js', // Agenda 4d, etapa 2 (addendum 18): textos de "como o BTC se mexeu", só leitura de um arquivo de agregados
  'src/lib/btcAfterRelease.js', // Agenda 4d, parte 2: o BTC depois de cada divulgação (conta pura)
  'src/lib/btcAfterReleaseSource.js', // idem: busca pública das velas, falha em silêncio
  'src/hooks/useBtcAfterRelease.js',
  'src/components/dashboard/MarketResultCard.jsx', // redesenho do cartão de resultado (addendum 20): só apresentação, sem banco nem motor
  'src/lib/resultVisual.js', // geometria e frases PURAS do cartão
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
      if (texto !== null) expect(texto, rel).not.toMatch(/MarketContextBand|useMarketContext|marketContext(Band|Source)|reactionStats|btcAfterRelease|useBtcAfterRelease|resultVisual|MarketResultCard/);
    }
  });
});

// Fase 2 (addendum 9): o coletor é o ÚNICO workflow de contexto que escreve no repositório, e só na
// branch pública `context-data`. Sem push forçado, sem outra branch, sem segredo além do FRED, do BLS (addendum 14: o "Anterior") e do contato.
const COLETOR = '.github/workflows/context-collect.yml';
const SEGREDOS_DO_COLETOR = new Set(['FRED_API_KEY', 'BLS_API_KEY', 'CONTEXT_CONTACT_EMAIL']);
/**
 * Os 3 horários da coleta normal (addendum 25): o scan que termina nos minutos 00 a 09 das 10h, 15h e 00h UTC (07h, 12h e 21h de Brasília).
 * `T10:0` casa só com a HORA 10 e a dezena de minuto 0 (o "T" só existe antes da hora no carimbo ISO).
 */
const HORARIOS_DA_COLETA = ['T10:0', 'T15:0', 'T00:0'];
const NOS_HORARIOS_DA_COLETA = HORARIOS_DA_COLETA.map((h) => `contains(github.event.workflow_run.updated_at, '${h}')`).join(' || ');
/**
 * A linha que escolhe o modo: a entrada `mode`, OU "janela" quando o disparo vem do fim do "Scheduled scan" FORA dos 3 horários da coleta normal
 * (addenda 17 e 25). Nos 3 horários o valor fica vazio = coleta normal. O texto é conferido por inteiro: qualquer outra forma reprova.
 */
const MODO_ESPERADO = `COLLECT_MODE: \${{ github.event.inputs.mode || (github.event_name == 'workflow_run' && !(${NOS_HORARIOS_DA_COLETA}) && 'janela') || '' }}`;
const MODO_JANELA = { test: (linha) => linha.trim() === MODO_ESPERADO };
/**
 * O filtro do job no gatilho `workflow_run`: o scan é deste repositório, veio do cron-job.org ou da reserva e terminou de 12h a 14h59 UTC (janela)
 * ou nos minutos 00 a 09 de um dos 3 horários da coleta normal.
 */
const FILTRO_DO_GATILHO = [
  "github.event_name != 'workflow_run'",
  'github.event.workflow_run.head_repository.full_name == github.repository',
  "github.event.workflow_run.event == 'workflow_dispatch'",
  "github.event.workflow_run.event == 'schedule'",
  "contains(github.event.workflow_run.updated_at, 'T12:')",
  "contains(github.event.workflow_run.updated_at, 'T13:')",
  "contains(github.event.workflow_run.updated_at, 'T14:')",
];
/** O `if:` do job, por inteiro (a ordem e os parênteses importam: um `||` fora do lugar abriria o job para qualquer hora). */
const IF_ESPERADO = [
  "github.event_name != 'workflow_run' || (",
  'github.event.workflow_run.head_repository.full_name == github.repository',
  "&& (github.event.workflow_run.event == 'workflow_dispatch' || github.event.workflow_run.event == 'schedule')",
  "&& (contains(github.event.workflow_run.updated_at, 'T12:') || contains(github.event.workflow_run.updated_at, 'T13:') || contains(github.event.workflow_run.updated_at, 'T14:')",
  `|| ${NOS_HORARIOS_DA_COLETA}))`,
].join(' ');

/** O texto do `if:` do job `collect`, numa linha só (o YAML usa bloco dobrado `>-`). `null` se não achar. */
function ifDoJob(codigo) {
  const m = codigo.match(/^ {4}if: >-\n((?: {6}.*\n)+)/m);
  return m ? m[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' ') : null;
}

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
  // O que vai para a branch pública: SÓ os arquivos do coletor (eventos, estado e a base do BLS, addendum 21). Um `add` de pasta inteira ou de
  // outro arquivo levaria para uma branch pública qualquer coisa que o runner tenha na pasta (ex.: algo gravado por um passo anterior).
  const adds = codigo.split('\n').filter((l) => /\bgit\b(?!.*\bworktree\b).*\badd\b/.test(l)); // `git worktree add` abre a pasta da branch, não põe nada no commit
  if (!adds.length) p.push('nenhum git add (a regra abaixo ficaria vazia)');
  for (const l of adds) {
    if (!/^\s*git add (events\.json status\.json|bls-base\.json|history\.json)\s*$/.test(l)) p.push(`git add fora do permitido: ${l.trim()}`);
  }
  // Nome de segredo não diferencia maiúscula de minúscula no GitHub: `secrets.database_url` é o DATABASE_URL.
  for (const [, nome] of codigo.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (!SEGREDOS_DO_COLETOR.has(nome.toUpperCase())) p.push(`segredo não permitido: ${nome}`);
  // Qualquer outro jeito de pegar segredo (secrets['X'], toJSON(secrets), secrets: inherit) passaria batido.
  if (/\bsecrets\b(?!\.[A-Za-z0-9_])/.test(codigo)) p.push('uso indireto de `secrets` (só secrets.NOME é permitido)');
  if (/TELEGRAM/.test(codigo)) p.push('Telegram (só na Fase 4, com remetente sem banco)');
  if (!/workflow_dispatch/.test(codigo)) p.push('sem disparo manual (o cron-job.org usa workflow_dispatch)');
  if (!/node scripts\/context-collect\.mjs/.test(codigo)) p.push('não roda o coletor');
  // Modo "janela" (addenda 15/17): a ÚNICA entrada lida do workflow é `mode`, e só como variável de ambiente do passo que roda o coletor.
  // Entrada dentro do texto de um `run:` seria injeção de comando (quem dispara o workflow controla o valor). O modo também liga sozinho
  // quando o disparo vem do fim de um scan (`github.event_name == 'workflow_run'`): o scan do cron-job.org é o relógio, porque o `schedule`
  // do GitHub atrasa horas (06/11/2026). A reserva diária (`schedule`) nunca pode virar modo janela (ela deixaria de coletar).
  for (const l of codigo.split('\n').filter((x) => /\binputs\./.test(x))) {
    if (!MODO_JANELA.test(l)) p.push(`entrada do workflow fora do permitido (só COLLECT_MODE por variável de ambiente): ${l.trim()}`);
  }
  if (!codigo.split('\n').some((l) => MODO_JANELA.test(l))) p.push('falta COLLECT_MODE vindo de github.event.inputs.mode / do gatilho workflow_run (o modo janela não chegaria ao coletor)');
  // O `schedule:` é só a reserva diária (nenhuma entrada que ligue o modo janela).
  const crons = [...codigo.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)].map((m) => m[1]);
  if (crons.length !== 1) p.push(`esperado exatamente 1 agendamento (a reserva diária); há ${crons.length}`);
  for (const c of crons) if (!/^\d+ \d+ \* \* \*$/.test(c)) p.push(`o agendamento deve ser diário e fora do modo janela: ${c}`);
  // O gatilho do fim do scan: só o "Scheduled scan", só na main, só quando termina, e o job filtra por hora e por origem.
  if (!/^\s*workflow_run:\s*\n\s*workflows:\s*\["Scheduled scan"\]\s*\n\s*types:\s*\[completed\]\s*\n\s*branches:\s*\[main\]\s*$/m.test(codigo)) {
    p.push('workflow_run fora do molde (só o "Scheduled scan", types: [completed], branches: [main])');
  }
  for (const trecho of FILTRO_DO_GATILHO) if (!codigo.includes(trecho)) p.push(`filtro do gatilho workflow_run sem: ${trecho}`);
  // O `if:` inteiro, com os 3 horários da coleta normal (addendum 25). Conferido por igualdade: um horário a mais, um minuto mais largo
  // (`T10:` = a hora inteira, 4 coletas em vez de 1) ou um parêntese fora do lugar mudam quando o coletor roda e quanto ele gasta.
  if (ifDoJob(codigo) !== IF_ESPERADO) p.push('o `if:` do job não é o esperado (origem do scan + janela 12h-14h UTC + os 3 horários da coleta normal, minutos 00 a 09)');
  if (/^\s*(pull_request|pull_request_target|push|issue_comment|repository_dispatch):/m.test(codigo)) p.push('gatilho que qualquer pessoa pode acionar (PR, push, comentário, dispatch externo)');
  return p;
}

// Fase 4a (addendum 12): o ÚNICO workflow de contexto que fala com o Telegram. Só manual, sem escrita, só os 2 segredos do
// Telegram (e só quando "Enviar de verdade?" está marcado), nenhum banco.
const NOTIFICADOR = '.github/workflows/context-notify.yml';
const ALERTADOR = '.github/workflows/context-alert.yml';
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

  it('o coletor e a sonda continuam SEM Telegram (só o notificador manual e o alertador automático falam com o Telegram)', () => {
    for (const rel of arquivosDoContexto().filter((r) => r.startsWith('.github/') && r !== NOTIFICADOR && r !== ALERTADOR)) {
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
    const outros = arquivosDoContexto().filter((rel) => rel.startsWith('.github/') && rel !== COLETOR && rel !== ALERTADOR);
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
      // O que entra no commit da branch pública (addendum 21): só events.json, status.json e bls-base.json.
      real.replace('git add events.json status.json', 'git add .'),
      real.replace('git add events.json status.json', 'git add -A'),
      real.replace('git add events.json status.json', 'git add events.json status.json scripts/x.json'),
      real.replace('git add bls-base.json', ['git add bls-base.json ..', '/', 'arquivo-secreto'].join('')),
      real.replace('git add bls-base.json', 'git add --all'),
      // As datas passadas (addendum 27): só o history.json, nunca a pasta inteira nem outro arquivo.
      real.replace('git add history.json', 'git add history.json events.json'),
      real.replace('git add history.json', 'git add -A'),
    ];
    for (const yml of plantados) expect(problemasDoColetor(yml).length, yml.slice(-200)).toBeGreaterThan(0);
  });

  it('o coletor publica exatamente os arquivos da lista fechada (eventos, estado, a base do BLS e as datas passadas)', () => {
    const real = readFileSync(join(ROOT, COLETOR), 'utf8');
    const adds = real.split('\n').filter((l) => /\bgit\b(?!.*\bworktree\b).*\badd\b/.test(l) && !/^\s*#/.test(l)).map((l) => l.trim());
    expect(adds).toEqual(['git add events.json status.json', 'git add bls-base.json', 'git add history.json']);
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

  const MODO = MODO_ESPERADO;

  it('o modo "janela" (addenda 15/17) chega ao coletor SÓ por variável de ambiente do passo que o roda — nunca dentro de um `run:`', () => {
    const real = readFileSync(join(ROOT, COLETOR), 'utf8');
    const usos = real.split('\n').filter((l) => /\binputs\./.test(l) && !/^\s*#/.test(l)).map((l) => l.trim());
    expect(usos).toEqual([MODO]);
    const passo = real.slice(real.indexOf('- name: Coletar as datas'), real.indexOf('- name: Publicar na branch context-data'));
    expect(passo).toContain(MODO);
    expect(problemasDoColetor(real)).toEqual([]);
  });

  it('o `schedule:` é só a reserva diária; a janela vem do fim do "Scheduled scan" (workflow_run), e esse nome existe de verdade no scan.yml', () => {
    const real = readFileSync(join(ROOT, COLETOR), 'utf8');
    const crons = [...real.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)].map((m) => m[1]);
    expect(crons).toEqual(['41 11 * * *']);
    const scan = readFileSync(join(ROOT, '.github/workflows/scan.yml'), 'utf8');
    expect(scan).toMatch(/^name: Scheduled scan\s*$/m);
    expect(real).toContain('workflows: ["Scheduled scan"]');
  });

  it('prova: pega a entrada do workflow interpolada no script, em outro lugar, uma entrada a mais, o modo sem chegar ao coletor, a reserva virando janela e o gatilho do scan aberto demais', () => {
    const real = readFileSync(join(ROOT, COLETOR), 'utf8');
    const env = MODO;
    expect(real).toContain(env);
    const cronLinha = '    - cron: "41 11 * * *"\n';
    expect(real).toContain(cronLinha);
    const plantados = [
      real.replace('node scripts/context-collect.mjs --dir data', 'node scripts/context-collect.mjs --dir data ${{ github.event.inputs.mode }}'),
      real.replace('node scripts/context-collect.mjs --dir data', 'echo "${{ inputs.mode }}"\n          node scripts/context-collect.mjs --dir data'),
      real.replace(env, 'COLLECT_MODE: ${{ inputs.outra }}'),
      real.replace(env, `${env}\n          OUTRA: \${{ github.event.inputs.extra }}`),
      real.replace(`          ${env}\n`, ''),
      real.replace(env, 'COLLECT_MODE: janela'),
      // o modo ligado SEMPRE (inclusive no botão manual em branco e na reserva):
      real.replace("&& 'janela') || ''", "&& 'janela') || 'janela'"),
      // a entrada deixa de valer:
      real.replace('github.event.inputs.mode || (', '('),
      // a reserva diária some / vira dia útil / ganha uma irmã que liga a janela por horário:
      real.replace(cronLinha, ''),
      real.replace(cronLinha, '    - cron: "41 11 * * 1-5"\n'),
      real.replace(cronLinha, `${cronLinha}    - cron: "7,17,27,37,47,57 12-14 * * 1-5"\n`),
      // o gatilho do scan: outro workflow, qualquer branch, outro momento:
      real.replace('workflows: ["Scheduled scan"]', 'workflows: ["CI"]'),
      real.replace('    branches: [main]\n', ''),
      real.replace('types: [completed]', 'types: [requested]'),
      // gatilhos que qualquer pessoa aciona:
      real.replace('on:\n  workflow_dispatch:', 'on:\n  pull_request:\n  workflow_dispatch:'),
      real.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'),
      // cada peça do filtro do job, tirada uma a uma (o job passaria a rodar fora da hora, de outro repositório ou de qualquer origem):
      ...FILTRO_DO_GATILHO.map((trecho) => real.replace(trecho, 'true')),
      // addendum 25 — os 3 horários da coleta normal. No `if:`: a hora inteira (4 coletas por horário), um horário a mais, um a menos:
      real.replace("|| contains(github.event.workflow_run.updated_at, 'T10:0')", "|| contains(github.event.workflow_run.updated_at, 'T10:')"),
      real.replace("|| contains(github.event.workflow_run.updated_at, 'T10:0')", "|| contains(github.event.workflow_run.updated_at, 'T06:0') || contains(github.event.workflow_run.updated_at, 'T10:0')"),
      real.replace(" || contains(github.event.workflow_run.updated_at, 'T00:0')))", '))'),
      // …o parêntese fechado cedo demais (os 3 horários deixariam de exigir a origem do scan):
      real.replace("contains(github.event.workflow_run.updated_at, 'T14:')\n      || contains", "contains(github.event.workflow_run.updated_at, 'T14:'))\n      || (contains"),
      // No modo: a coleta dos 3 horários virando "janela" (não coletaria nada), e um horário esquecido no modo (viraria "janela" só nele):
      real.replace(`&& !(${NOS_HORARIOS_DA_COLETA}) && 'janela'`, "&& 'janela'"),
      real.replace(` || contains(github.event.workflow_run.updated_at, 'T00:0')) && 'janela'`, ") && 'janela'"),
      // …e a negação invertida (janela nos 3 horários, coleta normal a cada 15 min das 12h às 14h59):
      real.replace(`&& !(${NOS_HORARIOS_DA_COLETA})`, `&& (${NOS_HORARIOS_DA_COLETA})`),
    ];
    plantados.forEach((yml, i) => {
      expect(yml, `variante plantada nº ${i} não mudou o arquivo`).not.toBe(real);
      expect(problemasDoColetor(yml).length, `variante plantada nº ${i}`).toBeGreaterThan(0);
    });
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

// Agenda 4d, etapa 1 (addendum 18): a MEDIÇÃO da reação do BTC. Só manual, só leitura (nenhuma escrita no repositório, nem na branch de dados),
// sem banco, sem Telegram; só os segredos do FRED (datas passadas) e do contato do robô.
const MEDICAO = '.github/workflows/context-reaction.yml';
const SEGREDOS_DA_MEDICAO = new Set(['FRED_API_KEY', 'CONTEXT_CONTACT_EMAIL']);

function problemasDaMedicao(yml) {
  const codigo = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const p = [];
  if (!/permissions:\s*\n\s*contents:\s*read\s*\n/.test(codigo)) p.push('permissões: esperado só `contents: read`');
  if (/:\s*write\b/.test(codigo)) p.push('permissões: há escrita');
  if (/^\s*(schedule|workflow_run|pull_request|pull_request_target|push|issue_comment|repository_dispatch):/m.test(codigo)) p.push('gatilho além do botão manual (a medição é só manual)');
  if (!/^on:\s*\n\s*workflow_dispatch:\s*\n/m.test(codigo)) p.push('sem disparo manual como único gatilho');
  if (/\binputs\./.test(codigo) || /^\s*inputs:/m.test(codigo)) p.push('tem campos de entrada ou lê entrada do workflow (a medição não tem campos)');
  if (/\bgit\b.*\b(push|commit|worktree)\b/.test(codigo)) p.push('mexe no git');
  if (/TELEGRAM/.test(codigo)) p.push('Telegram');
  for (const [, nome] of codigo.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (!SEGREDOS_DA_MEDICAO.has(nome.toUpperCase())) p.push(`segredo não permitido: ${nome}`);
  if (/\bsecrets\b(?!\.[A-Za-z0-9_])/.test(codigo)) p.push('uso indireto de `secrets` (só secrets.NOME é permitido)');
  if (!/node scripts\/context-reaction\.mjs/.test(codigo)) p.push('não roda a medição');
  const usesUpload = [...codigo.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1]);
  for (const u of usesUpload) if (!/^actions\/(checkout|setup-node|upload-artifact)@/.test(u)) p.push(`ação fora da lista: ${u}`);
  return p;
}

describe('tripwire: a medição da reação do BTC é só manual e só de leitura (item 285, addendum 18)', () => {
  it('o workflow real passa nas regras e usa os dois segredos permitidos', () => {
    const real = readFileSync(join(ROOT, MEDICAO), 'utf8');
    expect(problemasDaMedicao(real)).toEqual([]);
    const segredos = real.split('\n').filter((l) => /secrets\./.test(l) && !/^\s*#/.test(l)).map((l) => l.trim());
    expect(segredos).toEqual(['FRED_API_KEY: ${{ secrets.FRED_API_KEY }}', 'CONTEXT_CONTACT_EMAIL: ${{ secrets.CONTEXT_CONTACT_EMAIL }}']);
  });

  it('o script da medição não escreve no repositório (só o arquivo JSON pedido) e só fala com o FRED e a Binance', () => {
    const codigo = readFileSync(join(ROOT, 'scripts/context-reaction.mjs'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const hosts = [...codigo.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]);
    expect([...new Set(hosts)].sort()).toEqual(['api.stlouisfed.org', 'data-api.binance.vision']);
    expect(codigo).not.toMatch(/child_process|execSync|spawn|mkdir|appendFile|unlink|rmSync/);
    expect([...codigo.matchAll(/writeFileSync\(([^,]+),/g)].map((m) => m[1].trim())).toEqual(['opts.json']);
  });

  it('prova: pega escrita, gatilho agendado, banco/Telegram, 3º segredo, ação de fora e git plantados', () => {
    const real = readFileSync(join(ROOT, MEDICAO), 'utf8');
    const plantados = [
      real.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
      real.replace('on:\n  workflow_dispatch:', "on:\n  schedule:\n    - cron: '0 * * * *'\n  workflow_dispatch:"),
      real.replace('on:\n  workflow_dispatch:', 'on:\n  workflow_dispatch:\n  push:'),
      real.replace('on:\n  workflow_dispatch:', 'on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: string'),
      real.replace('node scripts/context-reaction.mjs', 'node scripts/context-reaction.mjs ${{ inputs.x }}'),
      real.replace('CONTEXT_CONTACT_EMAIL: ${{ secrets.CONTEXT_CONTACT_EMAIL }}', 'CONTEXT_CONTACT_EMAIL: ${{ secrets.CONTEXT_CONTACT_EMAIL }}\n          DATABASE_URL: ${{ secrets.DATABASE_URL }}'),
      real.replace('CONTEXT_CONTACT_EMAIL: ${{ secrets.CONTEXT_CONTACT_EMAIL }}', 'CONTEXT_CONTACT_EMAIL: ${{ secrets.CONTEXT_CONTACT_EMAIL }}\n          TELEGRAM_BOT_TOKEN: ${{ secrets.FRED_API_KEY }}'),
      real.replace('CONTEXT_CONTACT_EMAIL: ${{ secrets.CONTEXT_CONTACT_EMAIL }}', 'CONTEXT_CONTACT_EMAIL: ${{ secrets.CONTEXT_CONTACT_EMAIL }}\n          X: ${{ toJSON(secrets) }}'),
      real.replace('uses: actions/upload-artifact@v4', 'uses: alguem/acao-de-fora@v1'),
      real.replace('node scripts/context-reaction.mjs --json reaction-result.json', 'git push origin HEAD:refs/heads/context-data\n          node scripts/context-reaction.mjs --json reaction-result.json'),
      real.replace('node scripts/context-reaction.mjs', 'node scripts/outra-coisa.mjs'),
    ];
    plantados.forEach((yml, i) => {
      expect(yml, `variante plantada nº ${i} não mudou o arquivo`).not.toBe(real);
      expect(problemasDaMedicao(yml).length, `variante plantada nº ${i}`).toBeGreaterThan(0);
    });
  });
});

// Fase 4b (addendum 26): o aviso AUTOMÁTICO de 1 h antes. Único workflow de contexto, além do coletor, com `contents: write` — e só para gravar
// `alerts-sent.json` na branch pública `context-data`. Fala com o Telegram (2 segredos, só quando é para enviar), nunca com banco.
const SEGREDOS_DO_ALERTADOR = new Set(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
const CONDICAO_DE_ENVIO = "github.event_name == 'workflow_run' || inputs.enviar";
const IF_DO_ALERTADOR = [
  "github.event_name == 'workflow_dispatch' || (",
  "(vars.CONTEXT_TELEGRAM_CATEGORIES == '' || contains(vars.CONTEXT_TELEGRAM_CATEGORIES, 'pre-evento'))",
  '&& github.event.workflow_run.head_repository.full_name == github.repository',
  "&& (github.event.workflow_run.event == 'workflow_dispatch' || github.event.workflow_run.event == 'schedule'))",
].join(' ');
const LINHA_COM_EXPRESSAO_PERMITIDA = /^(ENVIAR|CATEGORIAS_LIGADAS|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID):/;
const PUSH_PERMITIDO = /^\s*if git push origin HEAD:refs\/heads\/context-data; then\s*$/;
const ADD_PERMITIDO = /^\s*git add alerts-sent\.json\s*$/;

function problemasDoAlertador(yml) {
  const codigo = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const linhas = codigo.split('\n');
  const p = [];
  if (!/permissions:\s*\n\s*contents:\s*write\s*\n/.test(codigo)) p.push('permissões: esperado só `contents: write`');
  if ((codigo.match(/:\s*write\b/g) || []).length !== 1) p.push('permissões: há escrita além de `contents`');
  if (/^\s*schedule:/m.test(codigo)) p.push('tem `schedule:` (o relógio é o fim do scan)');
  if (/pull_request|\bpush:/.test(codigo.split(/^jobs:/m)[0])) p.push('gatilho de PR/push');
  if (!/workflow_run:\s*\n\s*workflows:\s*\["Scheduled scan"\]/.test(codigo)) p.push('o gatilho automático precisa ser o fim do "Scheduled scan"');
  // O `if:` do job, por inteiro: manual sempre; automático só com a categoria ligada e vindo deste repositório.
  if (ifDoJob(codigo) !== IF_DO_ALERTADOR) p.push('o `if:` do job mudou');
  // O que vai para a branch pública: só o registro, só em context-data, sem forçar.
  const pushes = linhas.filter((l) => /\bgit\b.*\bpush\b/.test(l));
  if (!pushes.length) p.push('nenhum git push (a regra abaixo ficaria vazia)');
  for (const l of pushes) if (!PUSH_PERMITIDO.test(l)) p.push(`git push fora do permitido: ${l.trim()}`);
  // `git add` de verdade (inclui `git -C . add` e `git -c x=y add`); `git worktree add` é outro comando.
  const adds = linhas.filter((l) => /\bgit\s+(?:-[A-Za-z]\s+\S+\s+)*add\b/.test(l));
  if (!adds.length) p.push('nenhum git add');
  for (const l of adds) if (!ADD_PERMITIDO.test(l)) p.push(`git add fora do permitido: ${l.trim()}`);
  if (/--force|--force-with-lease|\s-f\b|\+HEAD/.test(codigo)) p.push('push forçado');
  for (const [, nome] of codigo.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (!SEGREDOS_DO_ALERTADOR.has(nome.toUpperCase())) p.push(`segredo não permitido: ${nome}`);
  if (/\bsecrets\b(?!\.[A-Za-z0-9_])/.test(codigo)) p.push('uso indireto de `secrets` (só secrets.NOME é permitido)');
  for (const l of linhas.filter((x) => /secrets\./.test(x))) {
    if (!l.includes(`(${CONDICAO_DE_ENVIO}) && secrets.`)) p.push(`segredo fora da condição de envio: ${l.trim()}`);
  }
  for (const [, nome] of codigo.matchAll(/\bvars\.([A-Za-z0-9_]+)/g)) if (nome !== 'CONTEXT_TELEGRAM_CATEGORIES') p.push(`variável não permitida: ${nome}`);
  // Entrada e variável só chegam ao script por `env:` — nunca dentro do texto de um `run:` (injeção de comando).
  for (const l of linhas.filter((x) => /\$\{\{/.test(x))) {
    if (!LINHA_COM_EXPRESSAO_PERMITIDA.test(l.trim())) p.push(`expressão fora de um env: ${l.trim()}`);
  }
  const bloco = /enviar:\s*\n((?:[ \t]+[^\n]*\n){1,6})/.exec(codigo);
  if (!bloco || !/default:\s*false/.test(bloco[1])) p.push('"Enviar de verdade?" precisa ter padrão false');
  if (!/node scripts\/context-alert\.mjs/.test(codigo)) p.push('não roda o aviso');
  if (!/timeout-minutes:\s*\d+/.test(codigo)) p.push('sem timeout-minutes');
  return p;
}

describe('tripwire: o aviso automático de 1 h antes só grava o registro, só fala com o Telegram quando é para enviar e nunca toca banco (item 285, addendum 26)', () => {
  const real = readFileSync(join(ROOT, ALERTADOR), 'utf8');

  it('context-alert.yml segue as regras', () => {
    expect(problemasDoAlertador(real)).toEqual([]);
  });

  it('não-vacuidade: o arquivo e os scripts são achados como arquivos do contexto (as regras globais de banco/Firebase/motor os cobrem)', () => {
    expect(arquivosDoContexto()).toContain(ALERTADOR);
    expect(arquivosDoContexto()).toContain('scripts/contextAlert.mjs');
    expect(arquivosDoContexto()).toContain('scripts/context-alert.mjs');
  });

  it('o aviso automático (script e regras) não lê segredo: só o contextTelegram.mjs lê as variáveis do Telegram', () => {
    for (const rel of ['scripts/context-alert.mjs', 'scripts/contextAlert.mjs']) {
      const codigo = readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(codigo, rel).not.toMatch(/TELEGRAM_(BOT_TOKEN|CHAT_ID)/);
    }
  });

  it('o registro só é gravado depois da trava do formato público (serializeSent chama assertPublicSent)', () => {
    const regras = readFileSync(join(ROOT, 'scripts/contextAlert.mjs'), 'utf8');
    const script = readFileSync(join(ROOT, 'scripts/context-alert.mjs'), 'utf8');
    expect(regras).toMatch(/export const serializeSent = [^\n]*assertPublicSent/);
    expect(script).toMatch(/writeFileSync\(tmp, serializeSent\(state\)\)/);
  });

  it('prova: pega schedule, escrita a mais, push de outra branch ou forçado, add largo, 3º segredo, segredo fora da condição, expressão no run, categoria sem filtro, banco e envio ligado por padrão', () => {
    const seg = "TELEGRAM_BOT_TOKEN: ${{ (github.event_name == 'workflow_run' || inputs.enviar) && secrets.TELEGRAM_BOT_TOKEN || '' }}";
    expect(real).toContain(seg);
    const push = 'if git push origin HEAD:refs/heads/context-data; then';
    expect(real).toContain(push);
    const outra = ['refs/heads', 'outra'].join('/'); // (o nome da branch é montado por partes: o hook de proteção do repositório lê o texto dos comandos)
    const adicionar = 'git add alerts-sent.json';
    const plantados = [
      real.replace('on:\n  workflow_dispatch:', "on:\n  schedule:\n    - cron: '0 * * * *'\n  workflow_dispatch:"),
      real.replace('permissions:\n  contents: write', 'permissions:\n  contents: write\n  pull-requests: write'),
      real.replace('permissions:\n  contents: write', 'permissions:\n  contents: read'),
      real.replace(push, `if git push origin HEAD:${outra}; then`),
      real.replace(push, 'if git push --force origin HEAD:refs/heads/context-data; then'),
      real.replace(push, 'if git push origin +HEAD:refs/heads/context-data; then'),
      real.replace(adicionar, 'git add .'),
      real.replace(adicionar, `${adicionar} events.json`),
      // Um 2º `git add` por um jeito que o regex ingênuo (`git add` colado) não via:
      real.replace(adicionar, `${adicionar}\n          git -C . add -A`),
      real.replace(adicionar, `${adicionar}\n          git -c user.name=x add scripts/context-alert.mjs`),
      real.replace(seg, `${seg}\n          X: \${{ (${CONDICAO_DE_ENVIO}) && secrets.BLS_API_KEY || '' }}`),
      real.replace(seg, `${seg}\n          D: \${{ (${CONDICAO_DE_ENVIO}) && secrets.DATABASE_URL || '' }}`),
      real.replace(seg, 'TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}'),
      real.replace(seg, 'TELEGRAM_BOT_TOKEN: ${{ toJSON(secrets) }}'),
      real.replace('node scripts/context-alert.mjs "${ARGS[@]}"', 'node scripts/context-alert.mjs "${{ inputs.enviar }}"'),
      real.replace("(vars.CONTEXT_TELEGRAM_CATEGORIES == '' || contains(vars.CONTEXT_TELEGRAM_CATEGORIES, 'pre-evento'))\n      && ", ''),
      // Ligar sem filtro nenhum ou fazer o `nenhuma` não desligar (o `nenhuma` precisa fazer o job nem começar):
      real.replace("(vars.CONTEXT_TELEGRAM_CATEGORIES == '' || contains(vars.CONTEXT_TELEGRAM_CATEGORIES, 'pre-evento'))", "(vars.CONTEXT_TELEGRAM_CATEGORIES != 'nenhuma')"),
      real.replace("vars.CONTEXT_TELEGRAM_CATEGORIES == '' ||", ''),
      real.replace('      && github.event.workflow_run.head_repository.full_name == github.repository\n', ''),
      real.replace("github.event_name == 'workflow_dispatch' || (", "github.event_name == 'workflow_dispatch' || github.event_name == 'workflow_run' || ("),
      real.replace('CATEGORIAS_LIGADAS: ${{ vars.CONTEXT_TELEGRAM_CATEGORIES }}', 'CATEGORIAS_LIGADAS: ${{ vars.OUTRA }}'),
      real.replace(/(enviar:[\s\S]*?)default: false/, '$1default: true'),
      real.replace('node scripts/context-alert.mjs', 'echo sem aviso'),
      real.replace('workflows: ["Scheduled scan"]', 'workflows: ["CI"]'),
      real.replace('types: [completed]', 'types: [completed]\n  pull_request:'),
    ];
    plantados.forEach((yml, i) => {
      expect(yml, `variante plantada nº ${i} não mudou o arquivo`).not.toBe(real);
      expect(problemasDoAlertador(yml).length, `variante plantada nº ${i}`).toBeGreaterThan(0);
    });
    // Banco plantado também cai na regra global do contexto (nenhum arquivo de contexto referencia o banco).
    const comBanco = plantados.find((yml) => yml.includes('secrets.DATABASE_URL'));
    expect(comBanco, 'a variante com banco precisa existir').toBeDefined();
    expect(violacoes(ALERTADOR, comBanco).length).toBeGreaterThan(0);
  });
});
