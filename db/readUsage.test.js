// docs/known-risks.md item 282 — medição de leitura por processo. Sem banco
// real: o `pg` é trocado por um Pool falso, então roda em qualquer máquina
// (os testes que exigem Postgres ficam em pgEntitiesCore.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('pg', () => ({
  default: { Pool: class { query(...args) { return query(...args); } } },
}));

import { backend, estimateRowsBytes, getAndResetReadUsage } from './pgEntitiesCore.mjs';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://usuario:senha@localhost:5432/teste';
  query.mockReset();
  getAndResetReadUsage();
});

describe('estimateRowsBytes', () => {
  it('soma o tamanho do JSON do dado e do id de cada linha', () => {
    const rows = [{ id: 'a1', data: { x: 1 } }, { id: 'b22', data: { nome: 'BTCUSDT' } }];
    expect(estimateRowsBytes(rows)).toBe(JSON.stringify({ x: 1 }).length + 2 + JSON.stringify({ nome: 'BTCUSDT' }).length + 3);
  });

  it('lista vazia e linha sem dado não quebram', () => {
    expect(estimateRowsBytes([])).toBe(0);
    expect(estimateRowsBytes([{ id: 'z' }])).toBe('null'.length + 1);
  });
});

describe('getAndResetReadUsage', () => {
  it('conta consultas, linhas e bytes de filter/list/get, e zera ao ler', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: '1', data: { a: 1 } }, { id: '2', data: { a: 2 } }] });
    query.mockResolvedValueOnce({ rows: [{ id: '3', data: { a: 3 } }] });
    query.mockResolvedValueOnce({ rows: [] });

    await backend.entities.MonitoredAsset.filter({ is_active: true });
    await backend.entities.MonitoredAsset.get('3');
    await backend.entities.MonitoredAsset.list('-created_date', 5);

    const usage = getAndResetReadUsage();
    expect(usage).toMatchObject({ queries: 3, rows: 3 });
    expect(usage.bytes).toBeGreaterThan(0);
    expect(getAndResetReadUsage()).toEqual({ queries: 0, rows: 0, bytes: 0 });
  });

  it('o backend expõe o contador para o scan (backend.usage)', () => {
    expect(typeof backend.usage.getAndResetReadUsage).toBe('function');
  });
});
