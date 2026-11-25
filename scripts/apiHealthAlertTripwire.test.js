// docs/known-risks.md item 309 — o aviso "servidor da API FORA DO AR / VOLTOU" (api-health-alert.yml) só LÊ as execuções do próprio repositório e só fala com o Telegram.
// Nunca ganha escrita, banco, Firebase, segredo extra nem gatilho que qualquer pessoa aciona. Cada regra prova que falha com o defeito plantado.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WF = '.github/workflows/api-health-alert.yml';

function problemas(yml) {
  const codigo = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const p = [];
  if (!/permissions:\s*\n\s*contents:\s*read\s*\n\s*actions:\s*read\s*\n/.test(codigo)) p.push('permissões: esperado só `contents: read` e `actions: read`');
  if (/:\s*write\b/.test(codigo)) p.push('permissões: há escrita');
  if (/DATABASE_URL|firebase|BACKUP_DEPLOY_KEY|FRED|BEA_API|BLS_API/i.test(codigo)) p.push('banco, Firebase ou segredo alheio ao aviso');
  const segredos = [...codigo.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
  if (segredos.join(',') !== 'TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID') p.push(`segredos: esperado só os 2 do Telegram, achei ${segredos.join(',') || 'nenhum'}`);
  if (!/^\s*workflow_run:\s*\n\s*workflows:\s*\["Keep sentinel-signals-api warm"\]\s*\n\s*types:\s*\[completed\]\s*\n\s*branches:\s*\[main\]\s*$/m.test(codigo)) p.push('workflow_run fora do molde (só o "Keep sentinel-signals-api warm", types: [completed], branches: [main])');
  if (/^\s*(pull_request|pull_request_target|push|issue_comment|repository_dispatch|workflow_dispatch|schedule):/m.test(codigo)) p.push('gatilho além do fim do keep-warm');
  if (!codigo.includes('github.event.workflow_run.head_repository.full_name == github.repository')) p.push('sem o filtro de origem (head_repository == este repositório)');
  if (!codigo.includes("steps.decisao.outputs.action == 'down' || steps.decisao.outputs.action == 'up'")) p.push('o envio no Telegram não está condicionado à decisão down/up');
  // nada vindo de saída de passo ou do evento entra DENTRO de um `run:` (só por env:)
  for (const bloco of codigo.split('\n').filter((l) => /^\s*run:/.test(l))) {
    if (/\$\{\{/.test(bloco)) p.push(`entrada interpolada no shell: ${bloco.trim()}`);
  }
  if (/\bcurl\b|\bgit push\b/.test(codigo)) p.push('curl ou git push no workflow (o envio é pelo script do Telegram)');
  return p;
}

describe('tripwire: api-health-alert.yml (item 309)', () => {
  it('o workflow real passa nas regras e o nome do keep-warm existe de verdade', () => {
    const real = readFileSync(join(ROOT, WF), 'utf8');
    expect(problemas(real)).toEqual([]);
    expect(readFileSync(join(ROOT, '.github/workflows/keep-warm.yml'), 'utf8')).toMatch(/^name: Keep sentinel-signals-api warm\s*$/m);
  });

  it('prova: pega cada defeito plantado', () => {
    const real = readFileSync(join(ROOT, WF), 'utf8');
    const plantados = [
      real.replace('  actions: read', '  actions: write'),
      real.replace('  contents: read\n  actions: read', '  contents: read'),
      real.replace('          TELEGRAM_CHAT_ID:', '          DB: ${{ secrets.DATABASE_URL }}\n          TELEGRAM_CHAT_ID:'),
      real.replace('          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}\n', ''),
      real.replace('workflows: ["Keep sentinel-signals-api warm"]', 'workflows: ["CI"]'),
      real.replace('    branches: [main]\n', ''),
      real.replace('on:\n  workflow_run:', 'on:\n  pull_request:\n  workflow_run:'),
      real.replace('on:\n  workflow_run:', 'on:\n  schedule:\n    - cron: "0 * * * *"\n  workflow_run:'),
      real.replace('github.event.workflow_run.head_repository.full_name == github.repository', 'true'),
      real.replace("if: ${{ steps.decisao.outputs.action == 'down' || steps.decisao.outputs.action == 'up' }}", 'if: always()'),
      real.replace('run: node scripts/api-health-alert.mjs', 'run: node scripts/api-health-alert.mjs ${{ github.event.workflow_run.head_branch }}'),
      real.replace('run: bash scripts/telegram-workflow-alert.sh', 'run: curl -s https://example.com/${{ secrets.TELEGRAM_BOT_TOKEN }}'),
    ];
    plantados.forEach((yml, i) => {
      expect(yml, `variante plantada nº ${i} não mudou o arquivo`).not.toBe(real);
      expect(problemas(yml).length, `variante plantada nº ${i}`).toBeGreaterThan(0);
    });
  });
});
