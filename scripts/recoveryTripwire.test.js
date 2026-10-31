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

  it('o número é validado ANTES do backup (um número errado não gasta backup)', () => {
    const val = job('validar');
    expect(val).toMatch(/\[\[ "\$NUMERO_TESTE" =~ \^\[0-9\]\+\$ \]\]/);
    expect(val).toMatch(/NUMERO_TESTE: \$\{\{ inputs\.numero_teste \}\}/);
    expect(job('backup')).toMatch(/needs: validar/);
  });

  it('o backup da recuperação tem nome próprio (-pre-recuperacao-<número>) passado por `with:`', () => {
    const bk = job('backup');
    expect(bk).toMatch(/sufixo: -pre-recuperacao-\$\{\{ inputs\.numero_teste \}\}/);
    expect(bk).not.toMatch(/\brun:/); // chamada de workflow reutilizável: nada de shell aqui
  });

  it('o job aplicar tem folga sobre o prazo máximo da aplicação (170 min + 5 de último recurso)', () => {
    expect(job('apply')).toMatch(/timeout-minutes: (19\d|2\d\d)/);
  });
});

describe('backup-postgres.yml e restore-postgres.yml (nome próprio do backup da recuperação)', () => {
  const strip = (t) => t.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const backup = strip(read('.github/workflows/backup-postgres.yml'));
  const restore = strip(read('.github/workflows/restore-postgres.yml'));

  it('o backup diário aceita ser chamado pela recuperação (workflow_call com o campo sufixo)', () => {
    expect(backup).toMatch(/^\s+workflow_call:\s*\n\s+inputs:\s*\n\s+sufixo:/m);
  });

  it('o sufixo entra por env, só no formato exato, e nunca dentro de uma linha de shell', () => {
    expect(backup).toMatch(/BACKUP_SUFFIX: \$\{\{ inputs\.sufixo \}\}/);
    expect(backup).toMatch(/\[\[ "\$BACKUP_SUFFIX" =~ \^\(-pre-recuperacao-\[0-9\]\+\)\?\$ \]\]/);
    const shellLines = backup.split('\n').filter((l) => !/^\s*[A-Z_]+: /.test(l));
    for (const l of shellLines) expect(l).not.toMatch(/inputs\.sufixo/);
  });

  it('um backup por vez (o diário e o da recuperação empurram na mesma branch)', () => {
    expect(backup).toMatch(/concurrency:\s*\n\s+group: backup-postgres\s*\n\s+cancel-in-progress: false/);
  });

  it('a limpeza dos 30 mais recentes NÃO apaga os backups -pre-recuperacao-', () => {
    expect(backup).toMatch(/ls -1 postgres-backup-\?\?\?\?-\?\?-\?\?\.dump /);
    expect(backup).not.toMatch(/ls -1 postgres-backup-\*\.dump/);
    expect(backup).toMatch(/BACKUP_NAME=/);
  });

  it('a restauração aceita um arquivo escolhido (campo opcional, nome exato) e, vazio, usa o diário mais recente', () => {
    expect(restore).toMatch(/workflow_dispatch:\s*\n\s+inputs:\s*\n\s+arquivo:/);
    expect(restore).toMatch(/ARQUIVO: \$\{\{ inputs\.arquivo \}\}/);
    expect(restore).toMatch(/postgres-backup-\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\(-pre-recuperacao-\[0-9\]\+\)\?\\\.dump/);
    expect(restore).toMatch(/ls -1 \/tmp\/backups\/postgres-backup-\?\?\?\?-\?\?-\?\?\.dump/);
    const shellLines = restore.split('\n').filter((l) => !/^\s*[A-Z_]+: /.test(l));
    for (const l of shellLines) expect(l).not.toMatch(/inputs\.arquivo/);
  });
});
