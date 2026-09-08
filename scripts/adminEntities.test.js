// scripts/adminEntities.js virou um re-export fino de db/pgEntitiesCore.mjs
// (Fase 10) — a lógica real (CRUD, CAS, locks) já é testada exaustivamente
// em db/pgEntitiesCore.test.js contra Postgres real; aqui só confirma que o
// re-export em si está correto (mesma referência de `backend`,
// `getAndResetOpCounts` aponta pra `backend.quota.getAndResetOpCounts`).
import { describe, it, expect, vi } from 'vitest';

const { backendMock } = vi.hoisted(() => {
  const getAndResetOpCounts = vi.fn(() => ({ reads: 0, writes: 0 }));
  return { backendMock: { entities: {}, locks: {}, tradeOps: {}, quota: { getAndResetOpCounts } } };
});
vi.mock('../db/pgEntitiesCore.mjs', () => ({ backend: backendMock }));

describe('scripts/adminEntities.js (re-export Postgres)', () => {
  it('backend é a MESMA referência exportada por db/pgEntitiesCore.mjs', async () => {
    const { backend } = await import('./adminEntities.js');
    expect(backend).toBe(backendMock);
  });

  it('getAndResetOpCounts é backend.quota.getAndResetOpCounts (mesma função, acessível sem passar por backend)', async () => {
    const { getAndResetOpCounts } = await import('./adminEntities.js');
    expect(getAndResetOpCounts).toBe(backendMock.quota.getAndResetOpCounts);
  });
});
