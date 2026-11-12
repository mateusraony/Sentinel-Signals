// Trava estrutural (docs/known-risks.md item 301): `refetchIntervalInBackground: true` faria uma tela continuar consultando o banco com a aba escondida,
// desfazendo a regra "aba escondida não consulta". O React Query só dispara `refetchInterval` com a página visível — desde que ninguém o desligue.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = join(process.cwd(), 'src');
const arquivos = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? arquivos(p) : /\.(jsx?|tsx?)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
});
const semComentario = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const PADRAO = /refetchIntervalInBackground\s*:\s*true/;

describe('trava: nenhuma tela força o polling em segundo plano', () => {
  it('nenhum arquivo do app liga refetchIntervalInBackground', () => {
    const todos = arquivos(RAIZ);
    expect(todos.length).toBeGreaterThan(100); // não-vacuidade
    const culpados = todos.filter((f) => PADRAO.test(semComentario(readFileSync(f, 'utf8'))));
    expect(culpados).toEqual([]);
  });
  it('a variante plantada seria acusada', () => {
    expect(PADRAO.test(semComentario('useQuery({ refetchIntervalInBackground: true })'))).toBe(true);
  });
  it('um comentário que cita a opção não é falso positivo', () => {
    expect(PADRAO.test(semComentario('// refetchIntervalInBackground: true faria isso'))).toBe(false);
  });
});
