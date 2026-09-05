// Tripwire de compatibilidade de Node (docs/known-risks.md item 166 addendum).
//
// O que motivou: `jsdom@30` foi instalado sem ninguém olhar o campo `engines`
// dele (`^22.22.2 || ^24.15.0 || >=26`). A suíte passou LOCAL — o Node desta
// máquina é 22.22.2, exatamente na faixa — e quebrou no CI, que roda Node 20:
//
//   TypeError: webidl.util.markAsUncloneable is not a function
//     ❯ new CacheStorage node_modules/undici/.../cachestorage.js
//     ❯ Object.<anonymous> node_modules/jsdom/lib/api.js
//
// `engines` no npm é ADVISÓRIO: instalar uma dependência que exige um Node mais
// novo que o de produção não dá erro nenhum, só quebra depois, longe da causa.
// Este teste torna isso visível no `npm test`, antes do push.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import semver from 'semver';

// A versão que o `setup-node` do ci.yml entrega. `node-version: 20` resolve
// para o último 20.x, não para 20.0.0 — usar 20.0.0 acusaria falso positivo em
// qualquer pacote que exija `^20.9.0` (eslint, por exemplo).
const NODE_CI = '20.19.0';

/**
 * Passivo conhecido, aceito e NÃO crescente — mesma catraca do typecheck.
 *
 * `firebase-admin@14` declara `>=22` e o `scan.yml` roda Node 20. **É anterior
 * a este item e não foi introduzido aqui.** Hoje funciona (engines é
 * advisório), mas é o relógio de trading rodando um SDK numa versão que o
 * próprio SDK diz não suportar. A correção — subir o Node de todos os
 * workflows — toca o scan ao vivo e é decisão de produto, não de teste.
 * Registrado para não ser esquecido nem "descoberto" de novo do zero.
 */
const PASSIVO_CONHECIDO = new Set(['firebase-admin']);

function engineDe(nome) {
  try {
    return JSON.parse(readFileSync(`node_modules/${nome}/package.json`, 'utf8')).engines?.node ?? null;
  } catch {
    return null;
  }
}

describe('dependências × Node do CI', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const nomes = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];

  it('a versão de Node do ci.yml continua sendo a que este teste assume', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const declarada = ci.match(/node-version:\s*'?"?(\d+)/)?.[1];
    expect(declarada, 'ci.yml mudou de versão de Node — atualize NODE_CI aqui').toBe(semver.major(NODE_CI).toString());
  });

  it('nenhuma dependência exige Node mais novo que o do CI', () => {
    const incompativeis = nomes
      .filter((n) => !PASSIVO_CONHECIDO.has(n))
      .map((n) => [n, engineDe(n)])
      .filter(([, e]) => e && !semver.satisfies(NODE_CI, e))
      .map(([n, e]) => `${n} exige "${e}"`);

    expect(incompativeis, [
      `Estas dependências exigem um Node mais novo que o ${NODE_CI} do CI.`,
      'O npm NÃO impede isso — a instalação passa e a quebra vem depois, longe da causa.',
      'Fixe uma versão compatível (foi assim com jsdom 30 → 26) ou suba o Node do CI.',
    ].join('\n')).toEqual([]);
  });

  it('o passivo conhecido está documentado e não cresceu', () => {
    // Se alguém remover firebase-admin ou ele passar a suportar Node 20, esta
    // entrada vira ruído — o teste avisa em vez de deixar apodrecer.
    for (const nome of PASSIVO_CONHECIDO) {
      const e = engineDe(nome);
      expect(e, `${nome} sumiu ou perdeu engines — tire-o de PASSIVO_CONHECIDO`).toBeTruthy();
      expect(semver.satisfies(NODE_CI, e), `${nome} agora É compatível — tire-o de PASSIVO_CONHECIDO`).toBe(false);
    }
  });
});
