// docs/known-risks.md item 282 — parte pura do relatório de restauração.
import { describe, it, expect } from 'vitest';
import { formatRestoreReport, nonEmptyTables, quoteIdent } from './restorePostgresReport.mjs';

describe('quoteIdent', () => {
  it('põe aspas e duplica aspas internas', () => {
    expect(quoteIdent('trade_operations')).toBe('"trade_operations"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe('nonEmptyTables', () => {
  it('acusa tabelas com linhas e ignora users/scanner_locks', () => {
    const counts = [
      { table: 'trade_operations', rows: 3 }, { table: 'asset_states', rows: 0 },
      { table: 'users', rows: 1 }, { table: 'scanner_locks', rows: 2 },
    ];
    expect(nonEmptyTables(counts)).toEqual([{ table: 'trade_operations', rows: 3 }]);
  });
});

describe('formatRestoreReport', () => {
  const base = { version: 'PostgreSQL 17.4', counts: [{ table: 'signal_events', rows: 3903 }] };

  it('mostra versão, tamanho em relação ao limite e a tabela de linhas', () => {
    const md = formatRestoreReport({ ...base, dbBytes: 150 * 1024 * 1024 });
    expect(md).toContain('PostgreSQL 17.4');
    expect(md).toContain('150.0 MB');
    expect(md).toContain('(30% de 500.0 MB');
    expect(md).toContain('| `signal_events` | 3903 |');
    expect(md).not.toContain('⚠️');
  });

  it('avisa quando passa de 80% do limite', () => {
    expect(formatRestoreReport({ ...base, dbBytes: 450 * 1024 * 1024 })).toContain('⚠️');
  });
});
