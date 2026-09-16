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
    ).toMatch(/SystemLog\.filter\(\s*\{\s*level:\s*'error'/);
  });

  // Achado do sentinel-security-review (2026-09-14): a amostra por nível sem
  // corte de tempo pode ressuscitar um incidente antigo já resolvido como se
  // fosse atual — foi exatamente isso que motivou a auditoria externa.
  it('a amostra de erros por nível também tem corte de recência (created_date >= N dias atrás)', () => {
    expect(
      SRC,
      'sem corte de recência, um erro histórico (ex.: de antes de uma migração de banco) pode reaparecer como incidente atual',
    ).toMatch(/SystemLog\.filter\(\s*\{\s*level:\s*'error',\s*created_date:\s*\{\s*gte:/);
  });

  it('o orçamento declarado é a soma dos tetos reais', () => {
    const tetos = [...SRC.matchAll(/^const (LIMITE_\w+) = (\d+);$/gm)].map(([, , n]) => Number(n));
    const soma = tetos.reduce((a, b) => a + b, 0);
    const declarado = SRC.match(/no MÁXIMO (\d+) documentos/);
    expect(tetos.length).toBeGreaterThan(0);
    expect(Number(declarado[1]), 'o comentário do orçamento saiu de sincronia com os tetos').toBe(soma);
  });

  // Item 179 — o contrato read-only decorativo (getAndResetOpCounts sempre
  // {reads:0,writes:0} no Postgres, gate morto que nunca podia disparar) foi
  // substituído por uma role Postgres real + propagação do erro de permissão.
  describe('contrato read-only real (GRANT Postgres, não contador)', () => {
    it('checar() propaga permission denied (42501) em vez de engolir como achado comum', () => {
      expect(SRC).toMatch(/if \(e\.code === '42501'\) \{\s*throw e;/);
    });

    it('o gate morto de writes>0 foi removido — a proteção não finge ser 2 camadas', () => {
      expect(SRC).not.toMatch(/if \(writes > 0\)/);
    });

    it('DATABASE_URL_READONLY: usa quando presente, avisa alto quando ausente (nunca falha calado)', () => {
      expect(SRC).toContain('process.env.DATABASE_URL = process.env.DATABASE_URL_READONLY');
      expect(SRC).toContain("achados.push('auditoria rodando sem credencial Postgres somente-leitura dedicada");
    });
  });

  // Achado real (auditoria externa, 2026-09-15): as duas seções de falha
  // sistêmica (dentro e fora da janela recente) imprimem até 5 grupos no
  // corpo do relatório (`.slice(0, 5)`), mas só empurravam o PRIMEIRO
  // (`sistemicos[0]`/`sistemicosFora[0]`) pra `achados` — uma 2ª falha
  // sistêmica simultânea nunca chegava no resumo/Telegram, só ficava
  // enterrada no corpo. Travado aqui pra nunca voltar a ser "só o índice 0".
  describe('achados de falha sistêmica cobrem TODOS os grupos listados, não só o 1º', () => {
    it('nenhum achado.push indexa só sistemicos[0]/sistemicosFora[0]', () => {
      expect(SRC).not.toMatch(/achados\.push\(`erro em \$\{sistemicos\[0\]/);
      expect(SRC).not.toMatch(/achados\.push\(`erro em \$\{sistemicosFora\[0\]/);
    });

    it('os dois blocos iteram os grupos listados (mesmo .slice(0, 5) do corpo) antes de empurrar achado', () => {
      const matches = [...SRC.matchAll(/for \(const g of (sistemicos(?:Fora)?)\.slice\(0, 5\)(?:\.filter\(\(g\) => ocorreuRecentemente\(g\)\))?\) \{\s*achados\.push/g)];
      expect(matches.length).toBe(2);
    });
  });

  // Achado real (2026-09-16): um problema já corrigido continuava
  // re-disparando o MESMO alerta no Telegram em toda execução seguinte do
  // health-audit, porque `g.ultimo` seguia dentro da janela de leitura
  // mesmo dias depois do fix já ter sido confirmado. `ocorreuRecentemente`
  // (scripts/healthAuditFormat.mjs) filtra o que vira ACHADO — nunca o que
  // aparece no corpo do relatório, que continua mostrando o histórico
  // completo pra quem abrir o relatório.
  describe('achados de falha sistêmica só disparam Telegram se ainda recentes', () => {
    it('importa ocorreuRecentemente da parte pura, não reimplementa a regra aqui', () => {
      expect(SRC).toMatch(/import \{[^}]*\bocorreuRecentemente\b[^}]*\} from '\.\/healthAuditFormat\.mjs';/);
    });

    it('os dois blocos de achado filtram por recência antes de empurrar pro Telegram', () => {
      const matches = [...SRC.matchAll(/\.slice\(0, 5\)\.filter\(\(g\) => ocorreuRecentemente\(g\)\)\) \{\s*achados\.push/g)];
      expect(matches.length).toBe(2);
    });

    it('o filtro de recência NÃO afeta o corpo do relatório — só o que vira achado', () => {
      // As linhas que imprimem no corpo (via `p(...)`) continuam iterando o
      // .slice(0, 5) sem filtro — mostrar o histórico completo é o ponto.
      const corpo = [...SRC.matchAll(/for \(const g of (sistemicos(?:Fora)?)\.slice\(0, 5\)\) \{\s*p\(/g)];
      expect(corpo.length).toBe(2);
    });
  });
});
