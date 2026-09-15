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

// A versão que o `setup-node` do ci.yml entrega. `node-version: 22` resolve
// para o último 22.x, não para 22.0.0 — usar 22.0.0 acusaria falso positivo em
// qualquer pacote que exija `^22.9.0` (firebase-admin, por exemplo).
const NODE_CI = '22.11.0';

/**
 * Resolvido (P2, subida de Node 20→22 em todos os workflows exceto server/,
 * que fica em Node 20 de propósito): `firebase-admin@14` exige `>=22` e
 * agora está dentro da faixa suportada pelo CI — nada precisa de passivo
 * aceito aqui. Set vazio mantido (não a constante inteira removida) porque o
 * padrão "catraca" continua valendo pra qualquer dependência futura que
 * precise do mesmo tratamento.
 */
const PASSIVO_CONHECIDO = new Set([]);

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
