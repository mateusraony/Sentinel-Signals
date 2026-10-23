import { describe, it, expect } from 'vitest';
import { shouldRetryQuery } from './query-client.js';

describe('shouldRetryQuery', () => {
  it('mantém 1 tentativa extra para erro comum (comportamento de antes: retry 1)', () => {
    expect(shouldRetryQuery(0, new Error('Failed to fetch'))).toBe(true);
    expect(shouldRetryQuery(1, new Error('Failed to fetch'))).toBe(false);
  });

  it('banco sem cota (db_quota) não é retentado — a recusa se repete até o mês renovar', () => {
    expect(shouldRetryQuery(0, Object.assign(new Error('Banco de dados sem cota.'), { status: 503, code: 'db_quota' }))).toBe(false);
  });
});
