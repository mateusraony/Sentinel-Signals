// Conecta no banco NOVO (secret RESTORE_DATABASE_URL) e faz uma de três coisas
// (docs/known-risks.md item 282), usadas por .github/workflows/restore-postgres.yml:
//   --check     só prova que a conexão (inclusive o certificado TLS) funciona;
//   --truncate  apaga as linhas das tabelas que o backup repovoa;
//   --report    imprime linhas por tabela e tamanho do banco (Markdown).
// Nunca lê DATABASE_URL: o destino é sempre o banco novo, para não existir
// caminho de restaurar por cima do banco vivo.
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { pgConnectionConfig } from '../db/pgSsl.mjs';
import { buildTruncateSql, formatRestoreReport, nonEmptyTables, quoteIdent } from './restorePostgresReport.mjs';

async function listTables(client) {
  const { rows } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return rows.map((r) => r.table_name);
}

async function countRows(client, tables) {
  const counts = [];
  for (const table of tables) {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`);
    counts.push({ table, rows: rows[0].n });
  }
  return counts;
}

async function main() {
  const mode = process.argv[2];
  const url = process.env.RESTORE_DATABASE_URL;
  if (!url) throw new Error('RESTORE_DATABASE_URL não está setada.');
  if (!['--check', '--truncate', '--report', '--require-empty'].includes(mode)) {
    throw new Error('Uso: restore-postgres-report.mjs --check | --require-empty | --truncate | --report');
  }
  const client = new pg.Client(pgConnectionConfig(url));
  await client.connect();
  try {
    const { rows: [info] } = await client.query('SELECT version() AS version, current_database() AS db');
    if (mode === '--check') {
      console.log(`Conexão ok: ${info.version} (banco "${info.db}")`);
      return;
    }
    const tables = await listTables(client);
    if (mode === '--truncate') {
      const sql = buildTruncateSql(tables);
      if (sql) await client.query(sql);
      console.log(sql ? `Tabelas limpas: ${tables.length}` : 'Nada a limpar.');
      return;
    }
    const counts = await countRows(client, tables);
    if (mode === '--require-empty') {
      const filled = nonEmptyTables(counts);
      if (filled.length) {
        throw new Error(`O banco novo já tem dados (${filled.map((c) => `${c.table}=${c.rows}`).join(', ')}). Marque "Apagar o que já existe" para refazer, ou use um banco vazio.`);
      }
      console.log('Banco novo vazio, pronto para restaurar.');
      return;
    }
    const { rows: [size] } = await client.query('SELECT pg_database_size(current_database())::bigint AS bytes');
    console.log(formatRestoreReport({ version: info.version, counts, dbBytes: Number(size.bytes) }));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
