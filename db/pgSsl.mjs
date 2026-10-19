// Opções de conexão TLS do Postgres, num lugar só (docs/known-risks.md item 282).
// Usado por db/pgEntitiesCore.mjs (scan, server/, backup) e db/migrate.mjs.
//
// Regra de sempre: TLS só quando a própria connection string já pede
// (`sslmode=...`, caso do Neon em produção) — nunca força SSL numa conexão que
// não pediu (o Postgres local do CI não tem TLS) e, quando pede, mantém a
// verificação do certificado LIGADA (`rejectUnauthorized: true`).
//
// Novo: `DATABASE_SSL_CA`. Alguns provedores (Supabase) assinam o certificado
// do servidor com uma autoridade própria que o Node não conhece, e a conexão
// falha com "self-signed certificate in certificate chain". A saída segura é
// dar ao driver a CA PÚBLICA do provedor (o arquivo `.crt` que o painel deles
// oferece para baixar), não desligar a verificação. Aceita o PEM como texto
// (com quebras de linha reais ou `\n` literais) ou em base64. Sem a variável,
// o comportamento é exatamente o de antes.

const PEM_MARKER = 'BEGIN CERTIFICATE';

/**
 * Lê a CA da variável de ambiente. Devolve `null` quando não foi pedida e
 * LANÇA quando foi pedida mas não parece um certificado (falhar alto aqui é
 * melhor que cair numa conexão sem a verificação que o usuário configurou).
 * @param {string | undefined} value
 * @returns {string | null}
 */
export function readCaFromEnv(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const asText = raw.replace(/\\n/g, '\n');
  if (asText.includes(PEM_MARKER)) return asText;
  let decoded = '';
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    decoded = '';
  }
  if (decoded.includes(PEM_MARKER)) return decoded.trim();
  throw new Error('DATABASE_SSL_CA não parece um certificado PEM (nem em texto nem em base64). Use o arquivo .crt baixado do painel do provedor do banco.');
}

/** Tira `sslmode=...` da URL: com a CA em mãos, o objeto `ssl` manda (a URL sobrescreveria). */
export function stripSslMode(databaseUrl) {
  return databaseUrl
    .replace(/([?&])sslmode=[^&]*&?/i, (_, sep) => (sep === '?' ? '?' : sep))
    .replace(/[?&]$/, '');
}

/**
 * Parâmetros de conexão do `pg` (Pool/Client) para esta URL.
 * @param {string} databaseUrl
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ connectionString: string, ssl?: { rejectUnauthorized: boolean, ca?: string } }}
 */
export function pgConnectionConfig(databaseUrl, env = process.env) {
  if (!databaseUrl.includes('sslmode=')) return { connectionString: databaseUrl };
  const ca = readCaFromEnv(env.DATABASE_SSL_CA);
  if (!ca) return { connectionString: databaseUrl, ssl: { rejectUnauthorized: true } };
  return { connectionString: stripSslMode(databaseUrl), ssl: { rejectUnauthorized: true, ca } };
}
