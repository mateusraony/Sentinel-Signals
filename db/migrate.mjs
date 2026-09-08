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

export async function applySchema(databaseUrl, schemaPath = SCHEMA_PATH) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL não está setada — nada a fazer.');
  }
  const sql = await readFile(schemaPath, 'utf8');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(sql);
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
