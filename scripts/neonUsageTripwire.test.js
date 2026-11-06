// Item 294 — trava de isolamento do medidor do Neon. O medidor existe para NÃO gastar a cota que mede, então: sem banco (nenhum
// DATABASE_URL nem módulo que conecte), permissões mínimas (`contents: read` + `actions: read`), só 3 segredos (o do próprio GitHub e os
// 2 do Telegram, estes só quando há envio) e a entrada do workflow nunca dentro de um `run:`. Cada regra tem variantes PLANTADAS que
// precisam ser acusadas (guard nunca testado contra o próprio alvo é suposição — .claude/rules/testing.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WORKFLOW = '.github/workflows/neon-usage.yml';
const SCRIPTS = ['scripts/neon-usage.mjs', 'scripts/neonUsageMeter.mjs'];
const SEGREDOS = new Set(['GITHUB_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
const COND = "(github.event_name == 'schedule' || inputs.enviar) && secrets.";
const ENTRADA_OK = [
  /^\s*ENVIAR:\s*\$\{\{\s*github\.event_name == 'schedule' \|\| inputs\.enviar\s*\}\}\s*$/,
  /^\s*TELEGRAM_BOT_TOKEN:\s*\$\{\{\s*\(github\.event_name == 'schedule' \|\| inputs\.enviar\) && secrets\.TELEGRAM_BOT_TOKEN \|\| ''\s*\}\}\s*$/,
  /^\s*TELEGRAM_CHAT_ID:\s*\$\{\{\s*\(github\.event_name == 'schedule' \|\| inputs\.enviar\) && secrets\.TELEGRAM_CHAT_ID \|\| ''\s*\}\}\s*$/,
];

const semComentario = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

function problemasDoMedidor(yml) {
  const codigo = semComentario(yml);
  const p = [];
  if (!/^permissions:\s*\n\s+contents:\s*read\s*\n\s+actions:\s*read\s*\n/m.test(codigo)) p.push('permissões: esperado só `contents: read` e `actions: read`');
  if (/:\s*write\b/.test(codigo)) p.push('permissões: há escrita');
  if (/DATABASE_URL|FIREBASE|SERVICE_ACCOUNT|NEON_API_KEY|PGPASSWORD|PGHOST/i.test(codigo)) p.push('menção a banco/credencial de banco (o medidor não pode acordar o Neon)');
  for (const [, nome] of codigo.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (!SEGREDOS.has(nome.toUpperCase())) p.push(`segredo não permitido: ${nome}`);
  if (/\bsecrets\b(?!\.[A-Za-z0-9_])/.test(codigo)) p.push('uso indireto de `secrets`');
  for (const l of codigo.split('\n').filter((x) => /secrets\.TELEGRAM_/.test(x))) if (!l.includes(COND)) p.push(`segredo do Telegram fora da condição de envio: ${l.trim()}`);
  const checkouts = (codigo.match(/actions\/checkout/g) || []).length;
  if (checkouts < 1 || (codigo.match(/persist-credentials:\s*false/g) || []).length !== checkouts) p.push('checkout sem `persist-credentials: false`');
  for (const l of codigo.split('\n').filter((x) => /\binputs\./.test(x))) if (!ENTRADA_OK.some((re) => re.test(l))) p.push(`entrada do workflow fora do permitido: ${l.trim()}`);
  if (/^\s{2}(push|pull_request|pull_request_target|workflow_run):/m.test(codigo)) p.push('gatilho não previsto (só workflow_dispatch e schedule)');
  if (!/workflow_dispatch/.test(codigo) || !/^\s+- cron:/m.test(codigo)) p.push('faltam workflow_dispatch e/ou schedule');
  if (/\bgit\b.*\bpush\b/.test(codigo)) p.push('git push');
  if (/curl|api\.telegram\.org/.test(codigo)) p.push('envio fora do script testado');
  if (!/node scripts\/neon-usage\.mjs/.test(codigo)) p.push('não roda o medidor');
  if (!/^concurrency:/m.test(codigo)) p.push('sem concurrency');
  return p;
}

const IMPORTS_OK = new Set(['node:fs', 'node:path', 'node:url', './neonComputeBudget.mjs', './neonUsageMeter.mjs', './contextTelegram.mjs']);
function problemasDosScripts(texto) {
  const codigo = texto.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const p = [];
  for (const [, spec] of codigo.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) if (!IMPORTS_OK.has(spec)) p.push(`import fora da lista: ${spec}`);
  if (/\bimport\s*\(/.test(codigo) || /\brequire\s*\(/.test(codigo)) p.push('import dinâmico / require');
  // A palavra DATABASE_URL aparece de forma legítima no DETECTOR de workflows (`usesNeonDatabase`); o proibido é LER a URL do banco do ambiente.
  if (/process\.env\.DATABASE|env\??\.DATABASE|\bpg\b|firebase|adminEntities|adminTelegram|@\/api/i.test(codigo)) p.push('leitura da URL do banco, driver, Firebase ou o canal do Sentinel (grava log no Postgres)');
  return p;
}

const real = () => readFileSync(join(ROOT, WORKFLOW), 'utf8');

describe('tripwire: workflow do medidor do Neon (item 294)', () => {
  it('o workflow real segue todas as regras', () => {
    expect(problemasDoMedidor(real())).toEqual([]);
  });

  it('PROVA: pega escrita, banco, segredo a mais, Telegram sem condição, checkout com credencial, entrada no script e gatilho a mais', () => {
    const y = real();
    const tg = "TELEGRAM_BOT_TOKEN: ${{ (github.event_name == 'schedule' || inputs.enviar) && secrets.TELEGRAM_BOT_TOKEN || '' }}";
    const exec = 'node scripts/neon-usage.mjs';
    expect(y).toContain(tg);
    expect(y).toContain(exec);
    const plantados = [
      y.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
      y.replace('  actions: read\n', '  actions: write\n'),
      y.replace('  actions: read\n', ''),
      y.replace('NEON_BILLING_DAY: ${{ vars.NEON_BILLING_DAY }}', 'DATABASE_URL: ${{ secrets.DATABASE_URL }}'),
      y.replace('NEON_BILLING_DAY: ${{ vars.NEON_BILLING_DAY }}', 'X: ${{ secrets.NEON_API_KEY }}'),
      y.replace('NEON_BILLING_DAY: ${{ vars.NEON_BILLING_DAY }}', 'X: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}'),
      y.replace('NEON_BILLING_DAY: ${{ vars.NEON_BILLING_DAY }}', 'X: ${{ secrets.BLS_API_KEY }}'),
      y.replace('NEON_BILLING_DAY: ${{ vars.NEON_BILLING_DAY }}', "X: ${{ secrets['TELEGRAM_BOT_TOKEN'] }}"),
      y.replace('NEON_BILLING_DAY: ${{ vars.NEON_BILLING_DAY }}', 'X: ${{ toJSON(secrets) }}'),
      y.replace(tg, 'TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}'),
      y.replace(tg, "TELEGRAM_BOT_TOKEN: ${{ true && secrets.TELEGRAM_BOT_TOKEN || '' }}"),
      y.replace('persist-credentials: false', 'persist-credentials: true'),
      y.replace(exec, `${exec} \${{ inputs.enviar }}`),
      y.replace(exec, `echo "\${{ github.event.inputs.enviar }}"\n          ${exec}`),
      y.replace('on:\n  workflow_dispatch:', 'on:\n  pull_request:\n  workflow_dispatch:'),
      y.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'),
      y.replace(exec, `${exec}\n          git push origin HEAD`),
      y.replace(exec, `${exec}\n          curl https://api.telegram.org/botX/sendMessage`),
      y.replace(exec, 'echo sem medidor'),
      y.replace('concurrency:\n  group: neon-usage\n  cancel-in-progress: false\n', ''),
    ];
    plantados.forEach((yml, i) => expect(problemasDoMedidor(yml).length, `variante plantada nº ${i}`).toBeGreaterThan(0));
  });

  it('PROVA: não acusa o inocente (comentário que cita DATABASE_URL, o nome do segredo em minúscula quando permitido)', () => {
    const y = real();
    expect(y).toMatch(/#.*DATABASE_URL/); // o cabeçalho explica que NÃO tem DATABASE_URL
    expect(problemasDoMedidor(y)).toEqual([]);
    expect(problemasDoMedidor(y.replace('secrets.GITHUB_TOKEN', 'secrets.github_token'))).toEqual([]);
  });

  it('o medidor não entra na conta do banco do orçamento (não cita DATABASE_URL fora de comentário)', () => {
    expect(/DATABASE_URL/.test(semComentario(real()))).toBe(false);
  });
});

describe('tripwire: os scripts do medidor não conectam em banco', () => {
  it('só importam módulos de Node, entre si, o orçamento (puro) e o remetente de Telegram sem banco', () => {
    for (const f of SCRIPTS) expect(problemasDosScripts(readFileSync(join(ROOT, f), 'utf8')), f).toEqual([]);
  });

  it('os módulos reaproveitados (orçamento e remetente de Telegram) também não importam nada', () => {
    for (const f of ['scripts/neonComputeBudget.mjs', 'scripts/contextTelegram.mjs']) {
      expect((readFileSync(join(ROOT, f), 'utf8').match(/^\s*import\s/gm) || []).length, f).toBe(0);
    }
  });

  it('PROVA: pega banco, Firebase, o canal do Sentinel e import dinâmico plantados', () => {
    const base = readFileSync(join(ROOT, 'scripts/neon-usage.mjs'), 'utf8');
    const ancora = "import fs from 'node:fs';";
    expect(base).toContain(ancora);
    for (const extra of [
      "import pg from 'pg';",
      "import { backend } from '@/api/entities';",
      "import { sendTelegramNotification } from './adminTelegram.js';",
      "import { db } from './adminEntities.js';",
      "import admin from 'firebase-admin';",
      "const x = await import('./outro.mjs');",
      "const url = process.env.DATABASE_URL;",
    ]) expect(problemasDosScripts(base.replace(ancora, `${ancora}\n${extra}`)).length, extra).toBeGreaterThan(0);
  });
});
