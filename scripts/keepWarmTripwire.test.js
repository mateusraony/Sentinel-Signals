// docs/known-risks.md item 6 (addendum de 06/11/2026) — o "manter o servidor acordado" não pode depender só do `schedule` do GitHub (chegou com 4 a 8 h de
// intervalo em vez de 10 min). Trava as regras do workflow: continua o ping de 10 min, ganha o gatilho do fim do "Scheduled scan" com o filtro de origem,
// e nunca ganha escrita, segredo, banco nem gatilho que qualquer pessoa aciona. Cada regra prova que falha com o defeito plantado.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WF = '.github/workflows/keep-warm.yml';

const FILTRO = [
  "github.event_name != 'workflow_run'",
  'github.event.workflow_run.head_repository.full_name == github.repository',
  "github.event.workflow_run.event == 'workflow_dispatch'",
  "github.event.workflow_run.event == 'schedule'",
];

function problemas(yml) {
  const codigo = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const p = [];
  if (!/permissions:\s*\n\s*contents:\s*read\s*\n/.test(codigo)) p.push('permissões: esperado só `contents: read`');
  if (/:\s*write\b/.test(codigo)) p.push('permissões: há escrita');
  if (/secrets\b|DATABASE_URL|TELEGRAM|firebase/i.test(codigo)) p.push('segredo, banco, Telegram ou Firebase (o ping é público e sem segredo)');
  const crons = [...codigo.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)].map((m) => m[1]);
  if (crons.join('|') !== '*/10 * * * *') p.push(`o ping agendado de 10 min mudou: ${crons.join(' | ') || 'sumiu'}`);
  if (!/^\s*workflow_dispatch:/m.test(codigo)) p.push('sem disparo manual');
  if (!/^\s*workflow_run:\s*\n\s*workflows:\s*\["Scheduled scan"\]\s*\n\s*types:\s*\[completed\]\s*\n\s*branches:\s*\[main\]\s*$/m.test(codigo)) {
    p.push('workflow_run fora do molde (só o "Scheduled scan", types: [completed], branches: [main])');
  }
  for (const trecho of FILTRO) if (!codigo.includes(trecho)) p.push(`filtro do gatilho do scan sem: ${trecho}`);
  if (/^\s*(pull_request|pull_request_target|push|issue_comment|repository_dispatch):/m.test(codigo)) p.push('gatilho que qualquer pessoa pode acionar');
  const curls = codigo.split('\n').filter((l) => /\bcurl\b/.test(l)).map((l) => l.trim());
  if (curls.length !== 1 || !/^run: curl -fsS --max-time 90 https:\/\/sentinel-signals-api\.onrender\.com\/health$/.test(curls[0])) p.push(`o ping deve ser um único GET público em /health: ${curls.join(' || ')}`);
  return p;
}

describe('tripwire: o "manter acordado" tem o ping de 10 min E o gatilho do fim do scan (item 6, addendum de 06/11/2026)', () => {
  it('o workflow real passa nas regras e o nome "Scheduled scan" existe de verdade no scan.yml', () => {
    const real = readFileSync(join(ROOT, WF), 'utf8');
    expect(problemas(real)).toEqual([]);
    expect(readFileSync(join(ROOT, '.github/workflows/scan.yml'), 'utf8')).toMatch(/^name: Scheduled scan\s*$/m);
  });

  it('prova: pega cada defeito plantado (sem o gatilho do scan, filtro furado, escrita, segredo, gatilho aberto, ping alterado)', () => {
    const real = readFileSync(join(ROOT, WF), 'utf8');
    const plantados = [
      real.replace('  workflow_run:\n    workflows: ["Scheduled scan"]\n    types: [completed]\n    branches: [main]\n', ''),
      real.replace('workflows: ["Scheduled scan"]', 'workflows: ["CI"]'),
      real.replace('    branches: [main]\n', ''),
      real.replace('types: [completed]', 'types: [requested]'),
      real.replace('    - cron: "*/10 * * * *"\n', ''),
      real.replace('*/10 * * * *', '0 * * * *'),
      real.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
      real.replace('on:\n  schedule:', 'on:\n  pull_request:\n  schedule:'),
      real.replace('run: curl -fsS --max-time 90 https://sentinel-signals-api.onrender.com/health', 'run: curl -fsS --max-time 90 https://sentinel-signals-api.onrender.com/health -H "x: ${{ secrets.ALGO }}"'),
      real.replace('https://sentinel-signals-api.onrender.com/health', 'https://outro-servidor.example.com/health'),
      ...FILTRO.map((trecho) => real.replace(trecho, 'true')),
    ];
    plantados.forEach((yml, i) => {
      expect(yml, `variante plantada nº ${i} não mudou o arquivo`).not.toBe(real);
      expect(problemas(yml).length, `variante plantada nº ${i}`).toBeGreaterThan(0);
    });
  });
});
