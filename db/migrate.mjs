// Runner leve, sem ORM (mesma preferência do projeto por utilitários
// hand-rolled em vez de dependência pesada — ver
// .claude/rules/operating-principles.md, "Reuse antes de criar").
//
// Aplica db/schema.sql inteiro. Cada `CREATE TABLE`/`CREATE INDEX` ali usa
// `IF NOT EXISTS`, então rodar de novo é seguro (idempotente) — não há
// controle de versão de migração incremental porque ainda não existe uma
// 2ª mudança de schema; quando existir, este arquivo ganha um diretório
// `db/migrations/` versionado em vez de reaplicar o schema inteiro (não
// antes disso — YAGNI).
//
// Uso: DATABASE_URL=postgresql://... node db/migrate.mjs
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

// Chave arbitrária fixa, só precisa ser a MESMA em toda chamada — serializa
// chamadores concorrentes de applySchema contra o mesmo banco (achado
// rodando os testes locais desta sessão: 4 arquivos de teste diferentes
// — db/schema.test.js, db/concurrency.test.js, db/pgEntitiesCore.test.js,
// scripts/backup-postgres.test.js — cada um chama applySchema no próprio
// beforeAll, e o vitest roda arquivos em paralelo por padrão; `CREATE TABLE
// IF NOT EXISTS` não é à prova de corrida sob concorrência de verdade sem
// isso — duas conexões concorrentes "veem" a tabela como ausente ao mesmo
// tempo e ambas tentam criar, batendo no catálogo pg_type e corrompendo o
// resto da suíte com erros incoerentes ("duplicate key value violates
// unique constraint pg_type_typname_nsp_index", "relation ... does not
// exist", etc., cada rodada com um erro diferente — a assinatura clássica
// de uma corrida, não um bug de lógica). `pg_advisory_lock` é session-scoped
// — só serializa dentro do MESMO processo `node` se usado do jeito errado;
// aqui funciona porque cada arquivo de teste abre sua PRÓPRIA conexão
// (client novo), então o lock realmente serializa entre processos/threads
// diferentes do vitest.
const SCHEMA_LOCK_KEY = 823456111;

export async function applySchema(databaseUrl, schemaPath = SCHEMA_PATH) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL não está setada — nada a fazer.');
  }
  const sql = await readFile(schemaPath, 'utf8');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
    try {
      await client.query(sql);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  applySchema(process.env.DATABASE_URL)
    .then(() => {
      console.log('[db/migrate] schema.sql aplicado.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[db/migrate] FAILED:', err.message);
      process.exit(1);
    });
}
