// T-2026-004 em UM clique (.github/workflows/t004-pine-vs-producao.yml). Trava: sem campos (nada de digitar), sem segredo/escrita/banco/Telegram, matriz casada com o PRÉ-REGISTRO
// (a fonte única das moedas, datas e chaves), conferência da configuração em toda rodada e entradas só por env:. Cada regra prova que falha com o defeito plantado.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WF = '.github/workflows/t004-pine-vs-producao.yml';
const PREREG = JSON.parse(readFileSync(join(ROOT, 'docs/experiments/pine-vs-producao-prereg.json'), 'utf8'));

function problemas(yml) {
  const codigo = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const p = [];
  if (!/permissions:\s*\n\s*contents:\s*read\s*\n/.test(codigo)) p.push('permissões: esperado só `contents: read`');
  if (/:\s*write\b/.test(codigo)) p.push('permissões: há escrita');
  if (/secrets\b|DATABASE_URL|TELEGRAM|firebase/i.test(codigo)) p.push('segredo, banco, Telegram ou Firebase (o teste é só leitura de dados públicos)');
  if (!/^on:\s*\n\s*workflow_dispatch:\s*\{\}\s*$/m.test(codigo)) p.push('o gatilho deve ser SÓ `workflow_dispatch: {}` (sem campos para digitar)');
  if (/^\s*inputs:/m.test(codigo)) p.push('campos de entrada (o erro de 25/11 foi justamente digitar/esquecer um campo)');
  if (/^\s*(pull_request|pull_request_target|push|issue_comment|schedule|workflow_run):/m.test(codigo)) p.push('gatilho além do disparo manual');
  // matriz = os 4 casamentos janela x braço do pré-registro
  const linhas = [...codigo.matchAll(/-\s*\{\s*id:\s*(\S+),\s*janela:\s*(\S+),\s*braco:\s*(\S+),\s*rotulo:\s*([^\s}]+)\s*\}/g)].map((m) => ({ id: m[1].replace(',', ''), janela: m[2].replace(',', ''), braco: m[3].replace(',', ''), rotulo: m[4] }));
  const esperadas = [];
  for (const w of PREREG.windows) for (const b of Object.keys(PREREG.arms)) esperadas.push(`${w.label}|${b}`);
  const achadas = linhas.map((l) => `${l.janela}|${l.braco}`);
  if (achadas.sort().join(',') !== esperadas.sort().join(',')) p.push(`a matriz não casa com o pré-registro: esperado ${esperadas.sort().join(',')}, achei ${achadas.join(',')}`);
  for (const l of linhas) if (!/^t004-W\d-[AB]-/.test(l.rotulo) || l.id !== `${l.janela}-${l.braco[0]}`) p.push(`rótulo/id fora do padrão: ${l.id} ${l.rotulo}`);
  // cada rodada prepara pelo pré-registro, roda com --pine-config e CONFERE a configuração usada
  for (const trecho of ['node scripts/t004-prepare.mjs', '--pine-config pine-config-overrides.json', 'node scripts/t004-verify-config.mjs --report backtest-report.json --expect pine-config-overrides.json', 'node scripts/t004-summary.mjs']) {
    if (!codigo.includes(trecho)) p.push(`falta: ${trecho}`);
  }
  if (!codigo.includes('fail-fast: false')) p.push('sem fail-fast: false (um braço com problema derrubaria os outros)');
  // nada digitado/da matriz entra DENTRO de um `run:` (só por env:)
  for (const linha of codigo.split('\n').filter((l) => /^\s*run:/.test(l))) {
    if (/\$\{\{/.test(linha)) p.push(`entrada interpolada no shell: ${linha.trim()}`);
  }
  return p;
}

describe('tripwire: t004-pine-vs-producao.yml (item 308, addendum 2)', () => {
  it('o workflow real passa nas regras', () => {
    expect(problemas(readFileSync(join(ROOT, WF), 'utf8'))).toEqual([]);
  });

  it('prova: pega cada defeito plantado', () => {
    const real = readFileSync(join(ROOT, WF), 'utf8');
    const plantados = [
      real.replace('  workflow_dispatch: {}', '  workflow_dispatch:\n    inputs:\n      pine_config:\n        description: x\n        required: false'),
      real.replace('on:\n  workflow_dispatch: {}', 'on:\n  workflow_dispatch: {}\n  schedule:\n    - cron: "0 * * * *"'),
      real.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
      real.replace('        run: node scripts/t004-prepare.mjs --janela "$JANELA" --braco "$BRACO"', '        env:\n          X: ${{ secrets.ALGO }}\n        run: node scripts/t004-prepare.mjs --janela "$JANELA" --braco "$BRACO"'),
      real.replace('          - { id: W2-B, janela: W2, braco: B_producao, rotulo: t004-W2-B-producao }\n', ''),
      real.replace('braco: A_modo_pine, rotulo: t004-W1-A-modo-pine', 'braco: B_producao, rotulo: t004-W1-A-modo-pine'),
      real.replace('      - name: Conferir que o relatório USOU a configuração do braço\n        run: node scripts/t004-verify-config.mjs --report backtest-report.json --expect pine-config-overrides.json\n\n', ''),
      real.replace(' --pine-config pine-config-overrides.json', ''),
      real.replace('fail-fast: false', 'fail-fast: true'),
      real.replace('run: node scripts/t004-prepare.mjs --janela "$JANELA" --braco "$BRACO"', 'run: node scripts/t004-prepare.mjs --janela ${{ matrix.janela }} --braco "$BRACO"'),
      real.replace('node scripts/t004-summary.mjs --dir reports', 'echo sem-resumo'),
    ];
    plantados.forEach((yml, i) => {
      expect(yml, `variante plantada nº ${i} não mudou o arquivo`).not.toBe(real);
      expect(problemas(yml).length, `variante plantada nº ${i}`).toBeGreaterThan(0);
    });
  });
});
