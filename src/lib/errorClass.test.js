import { describe, it, expect } from 'vitest';
import { classifyError, ERROR_CLASS } from './errorClass.js';

const withProps = (err, props) => Object.assign(err, props);

describe('classifyError', () => {
  it('"Failed to fetch" do navegador e "fetch failed" do Node são NETWORK', () => {
    expect(classifyError(new TypeError('Failed to fetch'))).toBe(ERROR_CLASS.NETWORK);
    expect(classifyError(new TypeError('fetch failed'))).toBe(ERROR_CLASS.NETWORK);
  });

  it('código de rede em err.cause (undici) é NETWORK; ETIMEDOUT é TIMEOUT', () => {
    expect(classifyError(withProps(new TypeError('x'), { cause: { code: 'ECONNREFUSED' } }))).toBe(ERROR_CLASS.NETWORK);
    expect(classifyError(withProps(new TypeError('x'), { cause: { code: 'ETIMEDOUT' } }))).toBe(ERROR_CLASS.TIMEOUT);
  });

  it('AbortError (timeout por tentativa de httpRetry.js) é TIMEOUT', () => {
    expect(classifyError(withProps(new Error('The operation was aborted.'), { name: 'AbortError' }))).toBe(ERROR_CLASS.TIMEOUT);
  });

  it('status HTTP via err.status (callBackend): 401/403 AUTH, 429 RATE_LIMIT, 504 TIMEOUT, 5xx HTTP_5XX, 4xx HTTP_4XX', () => {
    expect(classifyError(withProps(new Error('Invalid or expired token.'), { status: 401 }))).toBe(ERROR_CLASS.AUTH);
    expect(classifyError(withProps(new Error('x'), { status: 403 }))).toBe(ERROR_CLASS.AUTH);
    expect(classifyError(withProps(new Error('x'), { status: 429 }))).toBe(ERROR_CLASS.RATE_LIMIT);
    expect(classifyError(withProps(new Error('x'), { status: 504 }))).toBe(ERROR_CLASS.TIMEOUT);
    expect(classifyError(withProps(new Error('Erro interno.'), { status: 500 }))).toBe(ERROR_CLASS.HTTP_5XX);
    expect(classifyError(withProps(new Error('x'), { status: 404 }))).toBe(ERROR_CLASS.HTTP_4XX);
  });

  it('status no texto ("Request failed with status 503") também é reconhecido', () => {
    expect(classifyError(new Error('Request failed with status 503'))).toBe(ERROR_CLASS.HTTP_5XX);
  });

  it('erros do driver pg (SQLSTATE 08/53/57 e mensagens de conexão) são DATABASE', () => {
    expect(classifyError(withProps(new Error('x'), { code: '57P01' }))).toBe(ERROR_CLASS.DATABASE);
    expect(classifyError(withProps(new Error('x'), { code: '08006' }))).toBe(ERROR_CLASS.DATABASE);
    expect(classifyError(new Error('Connection terminated unexpectedly'))).toBe(ERROR_CLASS.DATABASE);
    expect(classifyError(new Error('timeout exceeded when trying to connect'))).toBe(ERROR_CLASS.DATABASE);
  });

  it('não reconhecido (ou null/undefined) é UNKNOWN, nunca lança', () => {
    expect(classifyError(new Error('algo estranho'))).toBe(ERROR_CLASS.UNKNOWN);
    expect(classifyError(null)).toBe(ERROR_CLASS.UNKNOWN);
    expect(classifyError(undefined)).toBe(ERROR_CLASS.UNKNOWN);
    expect(classifyError('texto solto')).toBe(ERROR_CLASS.UNKNOWN);
  });
});
