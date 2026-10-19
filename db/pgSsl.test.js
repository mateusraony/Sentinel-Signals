// docs/known-risks.md item 282 — TLS do Postgres: sem DATABASE_SSL_CA o
// comportamento é o de antes (Neon); com ela, a verificação continua ligada e
// o driver recebe a CA pública do provedor (Supabase assina com CA própria).
import { describe, it, expect } from 'vitest';
import { pgConnectionConfig, readCaFromEnv, stripSslMode } from './pgSsl.mjs';

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
