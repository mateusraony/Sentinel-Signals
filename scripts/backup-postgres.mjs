// Backup diário do Postgres/Neon (Fase 8 do plano de migração
// Firestore→Neon, /root/.claude/plans/baseando-nos-dados-que-partitioned-pixel.md)
// — ver .github/workflows/backup-postgres.yml. **Pré-requisito obrigatório
// antes de qualquer decomissão** do backup do Firestore
// (scripts/backup-firestore.mjs/backup.yml continuam rodando em paralelo
// até o cutover real, fase 10 do plano — não são substituídos por isto
// enquanto Firestore ainda for o backend de produção).
//
// Ao contrário do backup do Firestore (que precisou reimplementar um
// snapshot JSON manual + scripts/restore-firestore.mjs próprio, porque o
// export/import oficial do Firestore exige o plano pago Blaze — ver
// docs/known-risks.md item 14), Postgres já tem uma ferramenta nativa e
// madura pra isso, `pg_dump`/`pg_restore` — este script é um wrapper fino
// (monta os argumentos, invoca o binário, confere o código de saída), não
// uma reimplementação.
//
// `--format=custom`: formato binário comprimido, com restauração seletiva
// via `pg_restore` — recomendação oficial do próprio pg_dump para qualquer
// coisa além de um dump trivial (`plain`/SQL puro é mais lento de
// restaurar e não comprime). `--no-owner --no-privileges`: o dump não
// amarra GRANT/OWNER do role de origem (`neondb_owner`) — deixa o arquivo
// portável pra restaurar contra QUALQUER role de destino, sem exigir que o
// role exato exista no banco de restauração.
//
// Tabelas excluídas:
//   - `users` — mesma decisão já tomada pro backup do Firestore
//     (scripts/backup-firestore.mjs): registros de perfil ligados à auth
//     anônima, não é dado que faça sentido restaurar num desastre.
//   - `scanner_locks` — estado de execução efêmero ("quem está rodando
//     agora" no instante exato do backup); zero valor de disaster-recovery,
//     mesmo raciocínio de scripts/migrate-firestore-to-postgres.mjs.
// `tradingview_webhook_events` fica DENTRO do backup de propósito (ao
// contrário da migração de dados) — é um log de auditoria; vale preservar
// num backup mesmo sem servir pra reconstruir estado ao vivo.
//
// Aceito, não resolvido aqui: diferente do backup do Firestore (que já
// precisou limitar `SystemLog` por causa da cota diária de LEITURA),
// Postgres não tem esse teto — mas isso também significa que `system_logs`
// cresce sem limite dentro do dump, dia após dia. `pg_dump` só filtra por
// TABELA inteira, não por linha (um corte por idade exigiria uma query
// customizada, fora do escopo desta fase). Aceito por ora — revisitar se o
// tamanho do backup virar problema real (ainda não rodou nenhuma vez em
// produção pra ter esse dado).
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

export const EXCLUDED_TABLES = ['users', 'scanner_locks'];

// Piso de sanidade do arquivo gerado (docs/known-risks.md item 288, addendum de 01/11/2026). Um dump
// vazio ou cortado seria publicado como "backup do dia" e só apareceria no dia de restaurar. MEDIDO em
// 01/11/2026: o dump (mesmas opções) de um banco com SÓ o db/schema.sql, sem nenhuma linha, tem 17.085
// bytes; o cabeçalho sozinho tem menos de 1 KB. 4.096 fica bem abaixo do menor dump válido do projeto
// e acima de qualquer arquivo vazio/truncado. Não tenta provar que os DADOS estão completos — isso o
// pg_dump já garante pelo código de saída (conferido abaixo).
export const MIN_DUMP_BYTES = 4096;

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Puro (testável sem pg_dump): lança se o tamanho não é um número de bytes plausível para um dump.
export function assertDumpSize(bytes, outPath = 'o arquivo do dump') {
  if (!Number.isFinite(bytes) || bytes < MIN_DUMP_BYTES) {
    throw new Error(
      `${outPath} saiu com ${Number.isFinite(bytes) ? formatBytes(bytes) : 'tamanho desconhecido'} ` +
      `(mínimo esperado ${formatBytes(MIN_DUMP_BYTES)}): parece vazio ou cortado. Nada foi publicado.`,
    );
  }
}

export function buildPgDumpArgs(databaseUrl, outPath) {
  return [
    databaseUrl,
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    ...EXCLUDED_TABLES.map((t) => `--exclude-table=${t}`),
    '--file', outPath,
  ];
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL não está setada.');
  }
  const outPath = process.argv[2] || 'backup.dump';
  const args = buildPgDumpArgs(databaseUrl, outPath);

  console.log(`[backup-postgres] pg_dump -> ${outPath} (excluindo: ${EXCLUDED_TABLES.join(', ')})`);
  const result = spawnSync('pg_dump', args, { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`pg_dump falhou ao iniciar: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`pg_dump saiu com código ${result.status}`);
  }
  const bytes = statSync(outPath).size;
  assertDumpSize(bytes, outPath);
  console.log(`[backup-postgres] salvo em ${outPath} (${formatBytes(bytes)})`);
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error('[backup-postgres] FAILED:', err);
    process.exitCode = 1;
  });
}
