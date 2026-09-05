// Tripwire estrutural do item 165 (docs/known-risks.md).
//
// A primeira execução da auditoria em produção falhou em 3 de 5 checagens com
// `FAILED_PRECONDITION: The query requires an index`. Causa: consultas do tipo
// `filter({ campo }, '-created_date')` — filtro num campo, ordenação em outro,
// o que no Firestore exige índice COMPOSTO.
//
// A correção não foi criar os índices (seria um índice novo em `systemLogs`, a
// coleção mais escrita do projeto, e um deploy manual como pré-requisito do
// diagnóstico). Foi ler ordenando só por `created_date` — servido pelo índice
// automático de campo único — e filtrar em memória.
//
// Este teste trava a FORMA, não o caso: qualquer `.filter(` novo aqui volta a
// exigir índice, e o erro só apareceria contra o banco real, que nenhuma
// sessão de desenvolvimento alcança.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'health-audit.mjs'), 'utf8');

describe('consultas da auditoria de saúde', () => {
  // A regra real não é "sem filter" — é "sem consulta que exija índice
  // COMPOSTO". Duas formas são seguras e ambas são usadas hoje:
  //   list('-created_date', N)          → ordenação sem filtro
  //   filter({campo}, undefined, N)     → igualdade sem ordenação
  // O que exige índice composto é filtro + ordenação em campo diferente.
  it('nenhuma consulta combina filtro COM ordenação', () => {
    const filtrosComSort = SRC.match(/backend\.entities\.\w+\.filter\([^)]*,\s*'[^']+'/g) ?? [];
    expect(
      filtrosComSort,
      `filtro + ordenação exige índice composto — foi o que quebrou em produção: ${filtrosComSort.join(', ')}`,
    ).toEqual([]);
  });

  it('todo filtro passa `undefined` no lugar da ordenação, explicitamente', () => {
    const filtros = SRC.match(/backend\.entities\.\w+\.filter\([^)]*\)/g) ?? [];
    for (const f of filtros) {
      expect(f, `${f}: passe undefined como 2º argumento para deixar claro que não há ordenação`)
        .toMatch(/,\s*undefined\s*,/);
    }
  });

  it('toda leitura de coleção tem teto explícito', () => {
    const leituras = SRC.match(/backend\.entities\.\w+\.(list|filter)\([^)]*\)/g) ?? [];
    expect(leituras.length).toBeGreaterThan(0);
    for (const leitura of leituras) {
      // Sem limite, a consulta varre a coleção inteira — o oposto do contrato
      // de uma auditoria que existe para diagnosticar falta de cota.
      expect(leitura, `${leitura} não passa um teto de leitura`).toMatch(/,\s*LIMITE_\w+\s*\)/);
    }
  });

  // Achado do Codex (PR #311): a janela por recência sozinha deixa um erro da
  // madrugada ser expulso por log rotineiro, e a auditoria roda 1×/dia.
  it('lê erros por NÍVEL, não só pela janela de recência', () => {
    expect(
      SRC,
      'sem a amostra por nível, um erro antigo é expulso por log info e a auditoria reporta "nenhum erro"',
    ).toMatch(/SystemLog\.filter\(\s*\{\s*level:\s*'error'\s*\}/);
  });

  it('o orçamento declarado é a soma dos tetos reais', () => {
    const tetos = [...SRC.matchAll(/^const (LIMITE_\w+) = (\d+);$/gm)].map(([, , n]) => Number(n));
    const soma = tetos.reduce((a, b) => a + b, 0);
    const declarado = SRC.match(/no MÁXIMO (\d+) documentos/);
    expect(tetos.length).toBeGreaterThan(0);
    expect(Number(declarado[1]), 'o comentário do orçamento saiu de sincronia com os tetos').toBe(soma);
  });
});
