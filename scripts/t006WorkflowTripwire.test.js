// T-2026-006 em UM clique (.github/workflows/t006-so-o-trailing.yml). Mesmas travas do T-2026-004: sem campos, sem segredo/escrita/banco/Telegram, matriz casada com o
// PRÉ-REGISTRO (fonte única), conferência da configuração em toda rodada, entradas só por env:. Cada regra prova que falha com o defeito plantado.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WF = '.github/workflows/t006-so-o-trailing.yml';
const PREREG = JSON.parse(readFileSync(join(ROOT, 'docs/experiments/t006-trailing-prereg.json'), 'utf8'));

function problemas(yml) {
  const codigo = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const p = [];
  if (!/permissions:\s*\n\s*contents:\s*read\s*\n/.test(codigo)) p.push('permissões: esperado só `contents: read`');
  if (/:\s*write\b/.test(codigo)) p.push('permissões: há escrita');
  if (/secrets\b|DATABASE_URL|TELEGRAM|firebase/i.test(codigo)) p.push('segredo, banco, Telegram ou Firebase');
  if (!/^on:\s*\n\s*workflow_dispatch:\s*\{\}\s*$/m.test(codigo)) p.push('o gatilho deve ser SÓ `workflow_dispatch: {}`');
  if (/^\s*inputs:/m.test(codigo)) p.push('campos de entrada');
  if (/^\s*(pull_request|pull_request_target|push|issue_comment|schedule|workflow_run):/m.test(codigo)) p.push('gatilho além do disparo manual');
  const linhas = [...codigo.matchAll(/-\s*\{\s*id:\s*(\S+),\s*janela:\s*(\S+),\s*braco:\s*(\S+),\s*rotulo:\s*([^\s}]+)\s*\}/g)].map((m) => ({ id: m[1].replace(',', ''), janela: m[2].replace(',', ''), braco: m[3].replace(',', ''), rotulo: m[4] }));
  const esperadas = [];
  for (const w of PREREG.windows) for (const b of Object.keys(PREREG.arms)) esperadas.push(`${w.label}|${b}`);
  const achadas = linhas.map((l) => `${l.janela}|${l.braco}`);
  if (achadas.sort().join(',') !== esperadas.sort().join(',')) p.push(`a matriz não casa com o pré-registro: esperado ${esperadas.sort().join(',')}, achei ${achadas.join(',')}`);
  for (const l of linhas) if (l.rotulo !== `t006-${l.janela}-${l.braco}` || l.id !== `${l.janela}-${l.braco}`) p.push(`rótulo/id fora do padrão: ${l.id} ${l.rotulo}`);
  for (const trecho of ['node scripts/t004-prepare.mjs --prereg docs/experiments/t006-trailing-prereg.json', '--pine-config pine-config-overrides.json', 'node scripts/t004-verify-config.mjs --report backtest-report.json --expect pine-config-overrides.json', 'node scripts/t006-summary.mjs']) {
    if (!codigo.includes(trecho)) p.push(`falta: ${trecho}`);
  }
  if (!codigo.includes('fail-fast: false')) p.push('sem fail-fast: false');
  for (const linha of codigo.split('\n').filter((l) => /^\s*run:/.test(l))) {
    if (/\$\{\{/.test(linha)) p.push(`entrada interpolada no shell: ${linha.trim()}`);
  }
  return p;
}

describe('tripwire: t006-so-o-trailing.yml (item 308, addendum 4)', () => {
  it('o workflow real passa nas regras; são 8 rodadas (2 janelas x 4 braços)', () => {
    const real = readFileSync(join(ROOT, WF), 'utf8');
    expect(problemas(real)).toEqual([]);
    expect([...real.matchAll(/janela: W\d/g)]).toHaveLength(8);
  });

  it('o pré-registro tem os 4 braços esperados e a regra congelada', () => {
    expect(Object.keys(PREREG.arms).sort()).toEqual(['A_com_protecao', 'A_modo_pine', 'B_producao', 'B_sem_protecao']);
    expect(PREREG.arms.B_sem_protecao.pine_config).toMatchObject({ preTp1TrailEnabled: false, preTp1StopProtectionEnabled: false });
    expect(PREREG.arms.B_producao.pine_config).toEqual({ skip15mConfirmationEnabled: true });
    expect(PREREG.arms.A_com_protecao.pine_config).toMatchObject({ preTp1TrailEnabled: true, preTp1StopProtectionEnabled: true });
  });

  it('só a proteção muda entre os pares: o resto das chaves é IDÊNTICO (o ponto do teste)', () => {
    const sem = (cfg) => Object.fromEntries(Object.entries(cfg).filter(([k]) => !['preTp1TrailEnabled', 'preTp1StopProtectionEnabled'].includes(k)));
    expect(sem(PREREG.arms.B_sem_protecao.pine_config)).toEqual(sem(PREREG.arms.B_producao.pine_config));
    expect(sem(PREREG.arms.A_modo_pine.pine_config)).toEqual(sem(PREREG.arms.A_com_protecao.pine_config));
  });

  it('prova: pega cada defeito plantado', () => {
    const real = readFileSync(join(ROOT, WF), 'utf8');
    const plantados = [
      real.replace('  workflow_dispatch: {}', '  workflow_dispatch:\n    inputs:\n      pine_config:\n        description: x\n        required: false'),
      real.replace('on:\n  workflow_dispatch: {}', 'on:\n  workflow_dispatch: {}\n  schedule:\n    - cron: "0 * * * *"'),
      real.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
      real.replace('        run: node scripts/t004-prepare.mjs', '        env:\n          X: ${{ secrets.ALGO }}\n        run: node scripts/t004-prepare.mjs'),
      real.replace('          - { id: W2-A_com_protecao, janela: W2, braco: A_com_protecao, rotulo: t006-W2-A_com_protecao }\n', ''),
      real.replace('braco: B_sem_protecao, rotulo: t006-W1-B_sem_protecao', 'braco: B_producao, rotulo: t006-W1-B_sem_protecao'),
      real.replace('      - name: Conferir que o relatório USOU a configuração do braço\n        run: node scripts/t004-verify-config.mjs --report backtest-report.json --expect pine-config-overrides.json\n\n', ''),
      real.replace(' --pine-config pine-config-overrides.json', ''),
      real.replace('fail-fast: false', 'fail-fast: true'),
      real.replace('--janela "$JANELA"', '--janela ${{ matrix.janela }}'),
      real.replace('node scripts/t006-summary.mjs --dir reports', 'echo sem-resumo'),
      real.replace(' --prereg docs/experiments/t006-trailing-prereg.json', ''),
    ];
    plantados.forEach((yml, i) => {
      expect(yml, `variante plantada nº ${i} não mudou o arquivo`).not.toBe(real);
      expect(problemas(yml).length, `variante plantada nº ${i}`).toBeGreaterThan(0);
    });
  });
});
