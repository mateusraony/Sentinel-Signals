// Item 298 — trava do workflow e dos arquivos da retenção do system_logs. É a única rotina automática que APAGA dado deste banco, então as regras são
// estreitas: permissão mínima, só 2 segredos (banco), modo "simular" por padrão no botão manual e "aplicar" só no agendado, entrada do workflow nunca
// dentro de um `run:`, cron diário (o orçamento do Neon só entende cron diário). Cada regra tem variantes PLANTADAS que precisam ser acusadas
// (guard nunca testado contra o próprio alvo é suposição — .claude/rules/testing.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WORKFLOW = '.github/workflows/logs-retention.yml';
const SEGREDOS = new Set(['DATABASE_URL', 'DATABASE_SSL_CA']);
const MODO_OK = /^\s*RETENCAO_MODO:\s*\$\{\{\s*github\.event_name == 'schedule' && 'aplicar' \|\| inputs\.modo\s*\}\}\s*$/;
const DIAS_OK = /^\s*RETENCAO_DIAS:\s*\$\{\{\s*inputs\.dias\s*\}\}\s*$/;

const semComentario = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** Texto de todos os `run:` (linha única ou bloco `|`), para conferir que nenhuma expressão `${{ }}` entra no shell. */
function textoDosRun(codigo) {
  const linhas = codigo.split('\n');
  const out = [];
  for (let i = 0; i < linhas.length; i += 1) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(linhas[i]);
    if (!m) continue;
    const resto = m[2].trim();
    if (resto && !/^[|>][+-]?$/.test(resto)) { out.push(resto); continue; }
    const indent = m[1].length;
    for (let j = i + 1; j < linhas.length; j += 1) {
      const ind = /^(\s*)/.exec(linhas[j])[1].length;
      if (linhas[j].trim() !== '' && ind <= indent) break;
      out.push(linhas[j]);
    }
  }
  return out.join('\n');
}

function problemasDaRetencao(yml) {
  const codigo = semComentario(yml);
  const p = [];
  if (!/^permissions:\s*\n\s+contents:\s*read\s*\n(?!\s+\S)/m.test(codigo)) p.push('permissões: esperado só `contents: read`');
  if (/:\s*write\b/.test(codigo)) p.push('permissões: há escrita');
  for (const [, nome] of codigo.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (!SEGREDOS.has(nome.toUpperCase())) p.push(`segredo não permitido: ${nome}`);
  if (/\bsecrets\b(?!\.[A-Za-z0-9_])/.test(codigo)) p.push('uso indireto de `secrets`');
  if (!/secrets\.DATABASE_URL\b/.test(codigo) || !/secrets\.DATABASE_SSL_CA\b/.test(codigo)) p.push('faltam DATABASE_URL e/ou DATABASE_SSL_CA (db/workflowsDatabaseCa.test.js)');
  if (/TELEGRAM|FIREBASE|SERVICE_ACCOUNT|BACKUP_DEPLOY_KEY|api\.telegram\.org|\bcurl\b/i.test(codigo)) p.push('menção a Telegram/Firebase/chave de backup/curl (a retenção só fala com o banco)');
  const checkouts = (codigo.match(/actions\/checkout/g) || []).length;
  if (checkouts < 1 || (codigo.match(/persist-credentials:\s*false/g) || []).length !== checkouts) p.push('checkout sem `persist-credentials: false`');

  // Entrada: só as duas linhas previstas usam `inputs.`; o agendado aplica, o manual segue o que foi escolhido.
  for (const l of codigo.split('\n').filter((x) => /\binputs\./.test(x))) {
    if (!MODO_OK.test(l) && !DIAS_OK.test(l)) p.push(`entrada do workflow fora do permitido: ${l.trim()}`);
  }
  if (!codigo.split('\n').some((l) => MODO_OK.test(l))) p.push('RETENCAO_MODO precisa ser exatamente "agendado = aplicar, manual = o escolhido"');
  if (!codigo.split('\n').some((l) => DIAS_OK.test(l))) p.push('RETENCAO_DIAS precisa vir de inputs.dias');
  if (/\$\{\{/.test(textoDosRun(codigo))) p.push('expressão ${{ }} dentro de um `run:` (injeção de comando)');

  // Botão manual: o padrão é SIMULAR, nunca apagar.
  if (!/^\s{6}modo:\s*\n(?:\s{8}.+\n)*?\s{8}default:\s*simular\s*$/m.test(codigo)) p.push('o campo "modo" do botão manual precisa ter `default: simular`');
  if (/default:\s*['"]?aplicar/.test(codigo)) p.push('algum default é "aplicar"');
  if (!/^\s{8}options:\s*\n\s{10}- simular\s*\n\s{10}- aplicar\s*\n(?!\s{10}-)/m.test(codigo)) p.push('as opções do campo "modo" precisam ser exatamente simular e aplicar');

  // Gatilhos: só botão manual e 1 cron DIÁRIO.
  if (/^\s{2}(push|pull_request|pull_request_target|workflow_run|workflow_call|repository_dispatch):/m.test(codigo)) p.push('gatilho não previsto (só workflow_dispatch e schedule)');
  const crons = [...codigo.matchAll(/^\s+- cron:\s*"([^"]+)"/gm)].map((m) => m[1]);
  if (crons.length !== 1) p.push(`esperado exatamente 1 cron, achei ${crons.length}`);
  for (const c of crons) if (!/^\d{1,2} \d{1,2} \* \* \*$/.test(c)) p.push(`cron que não é diário (o orçamento do Neon só entende diário): ${c}`);

  if (!/^concurrency:\s*\n\s+group:\s*logs-retention\s*\n\s+cancel-in-progress:\s*false\s*$/m.test(codigo)) p.push('concurrency precisa ser `logs-retention` com cancel-in-progress: false');
  const timeout = /timeout-minutes:\s*(\d+)/.exec(codigo);
  if (!timeout || Number(timeout[1]) > 15) p.push('timeout-minutes ausente ou acima de 15');
  if (!/set -o pipefail/.test(codigo)) p.push('sem `set -o pipefail` (a falha do script ficaria mascarada pelo tee)');
  if (!/node scripts\/logs-retention\.mjs/.test(codigo)) p.push('não roda scripts/logs-retention.mjs');
  if (/\bgit\b.*\bpush\b|\bpsql\b|DELETE\s+FROM|DROP\s+|TRUNCATE/i.test(codigo)) p.push('SQL/git push direto no workflow (o SQL mora só em db/logsRetention.mjs)');
  return p;
}

const real = () => readFileSync(join(ROOT, WORKFLOW), 'utf8');
const plantar = (de, para) => {
  const t = real();
  if (!t.includes(de)) throw new Error(`trecho a plantar não existe no workflow: ${de}`);
  return t.replace(de, para);
};

describe('tripwire: workflow da retenção do system_logs (item 298)', () => {
  it('o workflow real segue todas as regras', () => {
    expect(problemasDaRetencao(real())).toEqual([]);
  });

  const VARIANTES = [
    ['permissão de escrita', () => plantar('permissions:\n  contents: read', 'permissions:\n  contents: write')],
    ['segredo do Telegram', () => plantar('RETENCAO_DIAS:', 'TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}\n          RETENCAO_DIAS:')],
    ['segredo de outro serviço', () => plantar('RETENCAO_DIAS:', 'X: ${{ secrets.BACKUP_DEPLOY_KEY }}\n          RETENCAO_DIAS:')],
    ['sem DATABASE_SSL_CA', () => plantar('DATABASE_SSL_CA: ${{ secrets.DATABASE_SSL_CA }}', 'DATABASE_SSL_CA: ""')],
    ['o agendado deixa de aplicar (só simula para sempre)', () => plantar("github.event_name == 'schedule' && 'aplicar' || inputs.modo", 'inputs.modo')],
    ['o agendado aplica E o manual também por padrão', () => plantar('default: simular', 'default: aplicar')],
    ['opção extra no campo modo', () => plantar('- aplicar\n        default', '- aplicar\n          - apagar-tudo\n        default')],
    ['entrada interpolada no shell', () => plantar('node scripts/logs-retention.mjs', 'node scripts/logs-retention.mjs --dias ${{ inputs.dias }}')],
    ['entrada nova fora das duas permitidas', () => plantar('RETENCAO_DIAS:', 'EXTRA: ${{ inputs.modo }}\n          RETENCAO_DIAS:')],
    ['sem pipefail', () => plantar('set -o pipefail\n', '')],
    ['gatilho de push', () => plantar('on:\n', 'on:\n  push:\n    branches: [main]\n')],
    ['cron semanal', () => plantar('"52 4 * * *"', '"52 4 * * 0"')],
    ['2 crons', () => plantar('- cron: "52 4 * * *"', '- cron: "52 4 * * *"\n    - cron: "52 16 * * *"')],
    ['checkout deixando o token', () => plantar('persist-credentials: false', 'persist-credentials: true')],
    ['sem concurrency', () => plantar('concurrency:\n  group: logs-retention\n  cancel-in-progress: false\n', '')],
    ['timeout enorme', () => plantar('timeout-minutes: 10', 'timeout-minutes: 120')],
    ['SQL direto no workflow', () => plantar('node scripts/logs-retention.mjs', 'psql "$DATABASE_URL" -c "DELETE FROM system_logs"; node scripts/logs-retention.mjs')],
    ['curl', () => plantar('node scripts/logs-retention.mjs', 'curl https://exemplo.invalid; node scripts/logs-retention.mjs')],
  ];

  it.each(VARIANTES)('variante plantada é acusada: %s', (_nome, montar) => {
    expect(problemasDaRetencao(montar()).length).toBeGreaterThan(0);
  });

  it('o cron diário é entendido pelo orçamento do Neon (não quebra scripts/neonComputeBudget.test.js)', async () => {
    const { cronMinutesOfDay } = await import('./neonComputeBudget.mjs');
    const cron = /- cron:\s*"([^"]+)"/.exec(real())[1];
    expect(cronMinutesOfDay(cron)).toHaveLength(1);
  });
});

describe('tripwire: arquivos da retenção (item 298)', () => {
  const codigoDe = (arq) => readFileSync(join(ROOT, arq), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('db/logsRetention.mjs é PURO: nenhum import e só a tabela system_logs no SQL', () => {
    const codigo = codigoDe('db/logsRetention.mjs');
    expect(codigo).not.toMatch(/^\s*import\s/m);
    expect(codigo).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
    const tabelas = [...codigo.matchAll(/\b(?:FROM|INTO|UPDATE|TRUNCATE(?:\s+TABLE)?|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
    expect(tabelas.length).toBeGreaterThan(0);
    expect(new Set(tabelas)).toEqual(new Set(['system_logs']));
  });

  it('scripts/logs-retention.mjs só importa o previsto (nada de Telegram, Firebase nem entidades de negócio)', () => {
    const codigo = codigoDe('scripts/logs-retention.mjs');
    const OK = new Set(['node:url', '../db/pgEntitiesCore.mjs', '../db/logsRetention.mjs', '../src/lib/dbQuotaError.js']);
    for (const [, spec] of codigo.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) expect(OK.has(spec), `import fora da lista: ${spec}`).toBe(true);
    expect(codigo).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
    expect(codigo).not.toMatch(/telegram|firebase|adminEntities|\bbackend\b/i);
    // Nunca imprime o ambiente (tem a URL do banco) nem a mensagem crua de um erro.
    expect(codigo).not.toMatch(/console\.(log|error)\([^)]*process\.env/);
    expect(codigo).not.toMatch(/\$\{\s*err\??\.message\s*\}/);
  });
});
