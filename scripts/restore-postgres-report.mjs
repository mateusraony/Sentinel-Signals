// Conecta no banco NOVO (secret RESTORE_DATABASE_URL) e faz uma destas coisas
// (docs/known-risks.md itens 282/283), usadas por .github/workflows/restore-postgres.yml:
//   --check            só prova que a conexão (inclusive o certificado TLS) funciona;
//   --require-empty    falha se o banco já tem dados (nunca restaura por cima);
//   --report           imprime linhas por tabela e tamanho do banco (Markdown);
//   --libpq-env <arq>  grava a CA em arquivo e acrescenta PG_RESTORE_URL em <arq>
//                      ($GITHUB_ENV): a URL do pg_restore com verify-full (o libpq
//                      não lê DATABASE_SSL_CA, só o driver do Node lê).
// Nunca lê DATABASE_URL: o destino é sempre o banco novo, para não existir
// caminho de restaurar por cima do banco vivo. E NÃO existe modo que apague
// dados: a segurança é "o destino precisa estar vazio", não "limpar antes".
import pg from 'pg';
import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { libpqUrlWithCa, pgConnectionConfig, readCaFromEnv } from '../db/pgSsl.mjs';
import { formatRestoreReport, nonEmptyTables, quoteIdent } from './restorePostgresReport.mjs';

const MODES = ['--check', '--require-empty', '--report', '--libpq-env'];

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

/** Grava a CA (0600) e acrescenta PG_RESTORE_URL ao arquivo de ambiente do job. A URL é mascarada no log. */
function writeLibpqEnv(url, envFile) {
  if (!envFile) throw new Error('Uso: restore-postgres-report.mjs --libpq-env <arquivo de ambiente do job>');
  const ca = readCaFromEnv(process.env.DATABASE_SSL_CA);
  if (!ca) {
    throw new Error('DATABASE_SSL_CA não está setada. Sem ela o pg_restore não confere o servidor (sslmode=require só criptografa). Cole o texto do certificado .crt do painel do Supabase no secret DATABASE_SSL_CA.');
  }
  const caPath = join(process.env.RUNNER_TEMP || tmpdir(), 'restore-db-ca.crt');
  writeFileSync(caPath, `${ca}\n`, { mode: 0o600 });
  chmodSync(caPath, 0o600);
  const libpqUrl = libpqUrlWithCa(url, caPath);
  console.log(`::add-mask::${libpqUrl}`);
  appendFileSync(envFile, `PG_RESTORE_URL=${libpqUrl}\n`);
  console.log('Certificado gravado e URL do pg_restore preparada com verify-full.');
}

async function main() {
  const mode = process.argv[2];
  const url = process.env.RESTORE_DATABASE_URL;
  if (!url) throw new Error('RESTORE_DATABASE_URL não está setada.');
  if (!MODES.includes(mode)) {
    throw new Error(`Uso: restore-postgres-report.mjs ${MODES.join(' | ')}`);
  }
  if (mode === '--libpq-env') {
    writeLibpqEnv(url, process.argv[3]);
    return;
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
    const counts = await countRows(client, tables);
    if (mode === '--require-empty') {
      const filled = nonEmptyTables(counts);
      if (filled.length) {
        throw new Error(`O banco novo já tem dados (${filled.map((c) => `${c.table}=${c.rows}`).join(', ')}). Este workflow nunca restaura por cima nem apaga nada. Use um projeto novo e vazio.`);
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
