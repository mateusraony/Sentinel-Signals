// docs/known-risks.md item 282 — TLS do Postgres: sem DATABASE_SSL_CA o
// comportamento é o de antes (Neon); com ela, a verificação continua ligada e
// o driver recebe a CA pública do provedor (Supabase assina com CA própria).
import { describe, it, expect } from 'vitest';
import { libpqUrlWithCa, pgConnectionConfig, readCaFromEnv, stripSslMode } from './pgSsl.mjs';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const NEON = 'postgresql://u:p@ep-x.neon.tech/db?sslmode=require';
const SUPABASE = 'postgresql://postgres.abc:senha@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require';

describe('pgConnectionConfig — sem DATABASE_SSL_CA (comportamento de antes)', () => {
  it('URL sem sslmode: nenhum ssl (Postgres local do CI)', () => {
    expect(pgConnectionConfig('postgresql://u:p@localhost:5432/db', {})).toEqual({
      connectionString: 'postgresql://u:p@localhost:5432/db',
    });
  });

  it('URL com sslmode: TLS com verificação ligada, URL intacta', () => {
    expect(pgConnectionConfig(NEON, {})).toEqual({ connectionString: NEON, ssl: { rejectUnauthorized: true } });
    expect(pgConnectionConfig(NEON, { DATABASE_SSL_CA: '   ' })).toEqual({ connectionString: NEON, ssl: { rejectUnauthorized: true } });
  });
});

describe('pgConnectionConfig — com DATABASE_SSL_CA (Supabase)', () => {
  it('passa a CA ao driver, mantém a verificação e tira o sslmode da URL (ele sobrescreveria o ssl)', () => {
    const cfg = pgConnectionConfig(SUPABASE, { DATABASE_SSL_CA: PEM });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true, ca: PEM.trim() });
    expect(cfg.connectionString).toBe('postgresql://postgres.abc:senha@aws-0-sa-east-1.pooler.supabase.com:5432/postgres');
  });

  it('a CA é ignorada quando a URL nem pede TLS (não força SSL no que não pediu)', () => {
    expect(pgConnectionConfig('postgresql://u:p@localhost/db', { DATABASE_SSL_CA: PEM })).toEqual({
      connectionString: 'postgresql://u:p@localhost/db',
    });
  });
});

describe('readCaFromEnv', () => {
  it('sem valor, devolve null', () => {
    expect(readCaFromEnv(undefined)).toBeNull();
    expect(readCaFromEnv('')).toBeNull();
  });

  it('aceita PEM com quebras reais, com \\n literais e em base64', () => {
    expect(readCaFromEnv(PEM)).toBe(PEM.trim());
    expect(readCaFromEnv(PEM.trim().replace(/\n/g, '\\n'))).toBe(PEM.trim());
    expect(readCaFromEnv(Buffer.from(PEM).toString('base64'))).toBe(PEM.trim());
  });

  it('valor que não é certificado LANÇA — falhar alto em vez de conectar sem a verificação pedida', () => {
    expect(() => readCaFromEnv('isto-nao-e-um-certificado')).toThrow(/DATABASE_SSL_CA/);
  });
});

describe('stripSslMode', () => {
  it.each([
    ['postgresql://u:p@h/db?sslmode=require', 'postgresql://u:p@h/db'],
    ['postgresql://u:p@h/db?sslmode=require&application_name=x', 'postgresql://u:p@h/db?application_name=x'],
    ['postgresql://u:p@h/db?application_name=x&sslmode=verify-full', 'postgresql://u:p@h/db?application_name=x'],
    ['postgresql://u:p@h/db', 'postgresql://u:p@h/db'],
  ])('%s', (entrada, esperado) => {
    expect(stripSslMode(entrada)).toBe(esperado);
  });

  it('senha com caracteres especiais fica intacta (não passa por URL())', () => {
    const url = 'postgresql://postgres.a:p%40ss%2Fw%3Ard@h:5432/postgres?sslmode=require';
    expect(stripSslMode(url)).toBe('postgresql://postgres.a:p%40ss%2Fw%3Ard@h:5432/postgres');
  });
});

// Achado do Codex no PR #513: o pg_restore (libpq) não lê DATABASE_SSL_CA, então com
// `sslmode=require` ele criptografava sem conferir o servidor.
describe('libpqUrlWithCa', () => {
  const CA = '/tmp/ca.crt';

  it('troca sslmode por verify-full e aponta a CA, sem mexer em usuário/senha/host', () => {
    const out = libpqUrlWithCa(SUPABASE, CA);
    const u = new URL(out);
    expect(u.searchParams.get('sslmode')).toBe('verify-full');
    expect(u.searchParams.get('sslrootcert')).toBe(CA);
    expect(u.hostname).toBe('aws-0-sa-east-1.pooler.supabase.com');
    expect(u.username).toBe('postgres.abc');
    expect(u.password).toBe('senha');
    expect(u.port).toBe('5432');
    expect(u.pathname).toBe('/postgres');
  });

  it('URL sem sslmode também ganha verify-full, e um sslmode fraco antigo é substituído (não duplicado)', () => {
    expect(libpqUrlWithCa('postgresql://u:p@h:5432/db', CA)).toContain('sslmode=verify-full');
    const out = libpqUrlWithCa('postgresql://u:p@h:5432/db?sslmode=disable&application_name=x', CA);
    expect(out.match(/sslmode=/g)).toHaveLength(1);
    expect(out).toContain('sslmode=verify-full');
    expect(out).toContain('application_name=x');
  });

  it('senha com percent-encoding segue idêntica', () => {
    const out = libpqUrlWithCa('postgresql://postgres.a:p%40ss%2Fw%3Ard@h:5432/postgres?sslmode=require', CA);
    expect(out).toContain('postgres.a:p%40ss%2Fw%3Ard@h:5432');
    expect(new URL(out).password).toBe('p%40ss%2Fw%3Ard');
  });

  it.each(['p#ss', 'p?ss', 'p/ss', 'p@ss'])('senha %s SEM codificar lança, em vez de conectar no host errado', (senha) => {
    expect(() => libpqUrlWithCa(`postgresql://postgres.a:${senha}word@h:5432/postgres`, CA)).toThrow(/senha|letras e números/i);
  });

  it('% mal formado na senha lança (o libpq recusaria no meio do restore)', () => {
    expect(() => libpqUrlWithCa('postgresql://postgres.a:p%ssword@h:5432/postgres', CA)).toThrow(/senha/i);
  });

  it('URL que não é de Postgres lança', () => {
    expect(() => libpqUrlWithCa('https://h/db', CA)).toThrow(/postgresql/);
    expect(() => libpqUrlWithCa('isto não é url', CA)).toThrow(/URL do banco/);
  });
});
