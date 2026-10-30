// docs/known-risks.md item 288 — travas estruturais do replay de recuperação.
// 1. O PACOTE que roda no GitHub não contém nenhum remetente de Telegram: o replay reprocessa
//    dias de velas e não pode disparar alerta de evento velho (o scanner é silenciado pelo
//    redirecionamento para scripts/backtestTelegram.js; a CLI não importa o remetente real).
// 2. O workflow do teste a seco é só manual, só leitura e sem os segredos do Telegram.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('pacote do replay de recuperação', () => {
  it('não contém remetente de Telegram e usa o provedor de velas da recuperação', () => {
    execFileSync(process.execPath, [path.join(root, 'scripts/build-recovery.mjs')], { cwd: root, stdio: 'pipe' });
    const bundle = read('scripts/dist/run-recovery.mjs');
    expect(bundle).not.toContain('api.telegram.org');
    // Não-vacuidade: o pacote tem mesmo o scanner e o provedor da recuperação dentro.
    expect(bundle).toContain('persistScanResults');
    expect(bundle).toMatch(/foram pr.{1,10}carregadas/); // esbuild escapa acentos (\u00E9)
  }, 60000);

  it('a CLI não importa o remetente real do Telegram', () => {
    const cli = read('scripts/run-recovery.mjs');
    expect(cli).not.toMatch(/adminTelegram|telegram\.js/);
  });
});

describe('workflow recovery.yml', () => {
  const yml = read('.github/workflows/recovery.yml');
  const code = yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('só disparo manual (sem schedule: cada execução acorda o Neon)', () => {
    expect(code).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(code).not.toMatch(/schedule:/);
  });

  it('permissões mínimas: ler o código e o estado dos workflows', () => {
    expect(code).toMatch(/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
    expect(code).not.toMatch(/contents: write|actions: write/);
  });

  it('sem segredos do Telegram e com a credencial só-leitura do banco', () => {
    expect(code).not.toMatch(/TELEGRAM/);
    expect(code).toMatch(/DATABASE_URL_READONLY: \$\{\{ secrets\.DATABASE_URL_READONLY \}\}/);
  });
});
