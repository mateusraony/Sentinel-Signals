// Parte PURA do relatório de restauração do Postgres (docs/known-risks.md
// item 282): sem rede, sem banco, testável. O script que conecta fica em
// scripts/restore-postgres-report.mjs.

/** Entre aspas duplas, como o Postgres exige para um nome vindo do catálogo. */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Tabelas que o dump NÃO traz (scripts/backup-postgres.mjs): nascem vazias no banco novo e o app as escreve sozinho. */
export const TABLES_NOT_IN_DUMP = Object.freeze(['users', 'scanner_locks']);

/** Banco novo já tem dados? Restaurar por cima de linhas existentes falharia no meio (chave repetida). */
export function nonEmptyTables(counts) {
  return counts.filter((c) => c.rows > 0 && !TABLES_NOT_IN_DUMP.includes(c.table));
}

const fmtBytes = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`);

/**
 * Markdown do Job Summary: versão do servidor, linhas por tabela e tamanho do banco
 * contra o limite do plano gratuito do Supabase (500 MB por projeto).
 * @param {{ version: string, counts: Array<{ table: string, rows: number }>, dbBytes: number, limitBytes?: number }} r
 */
export function formatRestoreReport({ version, counts, dbBytes, limitBytes = 500 * 1024 * 1024 }) {
  const pct = ((dbBytes / limitBytes) * 100).toFixed(0);
  const lines = [
    '## Banco novo — depois da restauração',
    '',
    `- Servidor: ${version}`,
    `- Tamanho do banco: **${fmtBytes(dbBytes)}** (${pct}% de ${fmtBytes(limitBytes)}, o limite do plano gratuito do Supabase por projeto)`,
    '',
    '| Tabela | Linhas |',
    '|---|---|',
    ...counts.map((c) => `| \`${c.table}\` | ${c.rows} |`),
  ];
  if (dbBytes > limitBytes * 0.8) {
    lines.push('', '> ⚠️ Passa de 80% do limite: antes de ligar o sistema, vale podar `system_logs` (maior crescimento).');
  }
  return lines.join('\n');
}
