// docs/known-risks.md item 288 — travas estruturais do replay de recuperação.
// 1. No PACOTE que roda no GitHub, o Telegram do SCANNER é o no-op (scripts/backtestTelegram.js):
//    o replay reprocessa dias de velas e não pode disparar alerta de evento velho. O único envio
//    possível é o resumo do modo aplicar (notifyRecoverySummary), importado só pela CLI.
// 2. O workflow: teste a seco só leitura e sem Telegram; aplicar só depois do backup, com o
//    número do teste a seco validado e nunca interpolado dentro de um script de shell.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('pacote do replay de recuperação', () => {
  it('o scanner usa o Telegram no-op e o provedor de velas da recuperação', () => {
    execFileSync(process.execPath, [path.join(root, 'scripts/build-recovery.mjs')], { cwd: root, stdio: 'pipe' });
    const bundle = read('scripts/dist/run-recovery.mjs');
    // esbuild marca cada módulo empacotado com "// caminho/do/arquivo".
    expect(bundle).not.toMatch(/^\/\/ src\/lib\/telegram\.js$/m);
    expect(bundle).toMatch(/^\/\/ scripts\/backtestTelegram\.js$/m);
    // Não-vacuidade: o pacote tem mesmo o scanner e o provedor da recuperação dentro.
    expect(bundle).toMatch(/^\/\/ src\/lib\/scanner\.js$/m);
    expect(bundle).toMatch(/foram pr.{1,10}carregadas/); // esbuild escapa acentos (é)
  }, 60000);

  it('a CLI só importa o envio do RESUMO (nenhum outro aviso do Telegram)', () => {
    const cli = read('scripts/run-recovery.mjs');
    const imports = cli.split('\n').filter((l) => /from '\.\/adminTelegram\.js'/.test(l));
    expect(imports).toEqual(["import { notifyRecoverySummary } from './adminTelegram.js';"]);
    expect(cli).not.toMatch(/src\/lib\/telegram/);
    // Usado em um só lugar: como sendSummary do modo aplicar.
    expect(cli.match(/notifyRecoverySummary/g)).toHaveLength(2);
    expect(cli).toMatch(/sendSummary: notifyRecoverySummary/);
  });
});

describe('workflow recovery.yml', () => {
  const yml = read('.github/workflows/recovery.yml');
  const code = yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const job = (name) => {
    const start = code.indexOf(`\n  ${name}:\n`);
    const rest = code.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  it('só disparo manual (sem schedule: cada execução acorda o Neon)', () => {
    expect(code).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(code).not.toMatch(/schedule:/);
  });

  it('permissões mínimas: ler o código e os workflows/artefatos, nunca escrever', () => {
    expect(code).toMatch(/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
    expect(code).not.toMatch(/: write/);
  });

  it('teste a seco: sem Telegram e com a credencial só-leitura', () => {
    const dry = job('dry-run');
    expect(dry).toMatch(/--mode=dry-run/);
    expect(dry).not.toMatch(/TELEGRAM/);
    expect(dry).toMatch(/DATABASE_URL_READONLY: \$\{\{ secrets\.DATABASE_URL_READONLY \}\}/);
  });

  it('aplicar: só depois do backup, com o número validado e nunca interpolado no shell', () => {
    expect(job('backup')).toMatch(/uses: \.\/\.github\/workflows\/backup-postgres\.yml/);
    const ap = job('apply');
    expect(ap).toMatch(/needs: backup/);
    expect(ap).toMatch(/--mode=apply/);
    expect(ap).toMatch(/\[\[ "\$NUMERO_TESTE" =~ \^\[0-9\]\+\$ \]\]/);
    // `${{ inputs.numero_teste }}` só em `env:`/`with:` — nunca dentro de uma linha de `run:`.
    const runLines = ap.split('\n').filter((l) => /^\s+run: /.test(l) || /^\s{10,}\S/.test(l) && !/:\s/.test(l));
    for (const l of runLines) expect(l).not.toMatch(/inputs\.numero_teste/);
    expect(ap).toMatch(/TELEGRAM_BOT_TOKEN: \$\{\{ secrets\.TELEGRAM_BOT_TOKEN \}\}/);
  });

  it('o backup diário aceita ser chamado pela recuperação (workflow_call)', () => {
    expect(read('.github/workflows/backup-postgres.yml')).toMatch(/^\s+workflow_call: \{\}/m);
  });
});
