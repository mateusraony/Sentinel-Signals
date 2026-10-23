// docs/known-risks.md item 283 (achado do Codex no PR #513): quem troca de banco
// para um provedor com CA própria (Supabase) precisa que TODO workflow que abre
// conexão Node com o banco repasse `DATABASE_SSL_CA`. Esquecer um só faz o job
// falhar no TLS só no dia em que alguém roda — este teste acusa antes.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), '.github', 'workflows');

// Workflows que usam `secrets.DATABASE_URL` mas NÃO abrem conexão Node com o banco:
const SEM_CONEXAO_NODE = {
  // pg_dump/libpq direto: o libpq não lê DATABASE_SSL_CA (usa sslmode da própria URL).
  'backup-postgres.yml': 'pg_dump (libpq) — não lê DATABASE_SSL_CA',
  // só compara com o banco vivo para RECUSAR rodar; a conexão usa RESTORE_DATABASE_URL.
  'restore-postgres.yml': 'DATABASE_URL só entra na comparação "destino ≠ banco vivo"',
};

const workflows = readdirSync(DIR).filter((f) => f.endsWith('.yml'));

describe('workflows que conectam no banco repassam DATABASE_SSL_CA', () => {
  const usaBanco = workflows.filter((f) => /secrets\.DATABASE_URL\b/.test(readFileSync(join(DIR, f), 'utf8')));

  it('há workflows que usam o banco (a regra não está vazia)', () => {
    expect(usaBanco.length).toBeGreaterThan(3);
  });

  it.each(usaBanco.filter((f) => !(f in SEM_CONEXAO_NODE)))('%s repassa secrets.DATABASE_SSL_CA', (f) => {
    expect(readFileSync(join(DIR, f), 'utf8')).toMatch(/secrets\.DATABASE_SSL_CA\b/);
  });

  it('a lista de exceções não esconde workflow que nem existe mais', () => {
    for (const f of Object.keys(SEM_CONEXAO_NODE)) expect(workflows).toContain(f);
  });
});
