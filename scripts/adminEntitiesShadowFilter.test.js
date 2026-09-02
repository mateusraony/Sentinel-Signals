// docs/known-risks.md item 141/143: 3o espelho da mesma tradução range→where()
// nativo cobrida em src/api/entities.test.js e scripts/adminEntities.test.js
// — classifyFilter (src/lib/queryFilters.js) só descreve a semântica
// pretendida, a chamada .where() real de scripts/adminEntitiesShadow.js é
// duplicada à mão (mesmo padrão de scripts/adminEntities.js, deliberadamente
// não compartilhado — ver o comentário de cabeçalho do próprio arquivo). Um
// bug de tradução aqui (ex.: só aplicar a 1a constraint de um range de 2) não
// afeta produção diretamente (modo sombra é read/write só em coleções
// experimentais), mas divergiria silenciosamente do que os outros dois
// backends fazem para o MESMO filtro — exatamente a classe de bug que este
// arquivo já promete evitar não compartilhando código (comentário acima).
//
// Ao contrário de adminEntitiesShadowTripwire.test.js, este arquivo IMPORTA
// o módulo (como scripts/adminEntities.test.js já faz para seu par) — o
// guard `if (!getApps().length)` é satisfeito mockando firebase-admin/app
// para devolver uma app já "inicializada", então cert(JSON.parse(...)) nunca
// roda e FIREBASE_SERVICE_ACCOUNT_JSON não precisa existir no ambiente de
// teste.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { collectionMock, whereMock, getMock } = vi.hoisted(() => {
  const getMock = vi.fn();
  const whereMock = vi.fn().mockReturnThis();
  const collectionMock = vi.fn(() => ({
    add: vi.fn(),
    doc: vi.fn(() => ({})),
    where: whereMock,
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    get: getMock,
  }));
  return { collectionMock, whereMock, getMock };
});

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(),
  cert: vi.fn(),
  getApps: () => [{}],
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: collectionMock,
    runTransaction: vi.fn(),
    batch: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.resetModules();
  collectionMock.mockClear();
  whereMock.mockClear();
  getMock.mockReset();
  getMock.mockResolvedValue({ docs: [] });
});

describe('adminEntitiesShadow — filter() traduz range para .where() nativo (item 143)', () => {
  it('{ gte } vira uma única constraint where(field, ">=", operand)', async () => {
    const { backend } = await import('./adminEntitiesShadow.js');
    await backend.entities.TradeOperation.filter({ created_date: { gte: '2026-10-01T00:00:00.000Z' } });
    const calls = whereMock.mock.calls.filter(([field]) => field === 'created_date');
    expect(calls).toEqual([['created_date', '>=', '2026-10-01T00:00:00.000Z']]);
  });

  it('{ gte, lt } vira DUAS constraints where() no mesmo campo — intervalo [a, b)', async () => {
    const { backend } = await import('./adminEntitiesShadow.js');
    await backend.entities.TradeOperation.filter({
      created_date: { gte: '2026-10-01T00:00:00.000Z', lt: '2026-11-01T00:00:00.000Z' },
    });
    const calls = whereMock.mock.calls.filter(([field]) => field === 'created_date');
    expect(calls).toEqual(
      expect.arrayContaining([
        ['created_date', '>=', '2026-10-01T00:00:00.000Z'],
        ['created_date', '<', '2026-11-01T00:00:00.000Z'],
      ]),
    );
    expect(calls).toHaveLength(2);
  });

  it('igualdade simples continua where(field, "==", valor) — não regride', async () => {
    const { backend } = await import('./adminEntitiesShadow.js');
    await backend.entities.TradeOperation.filter({ status: 'RUNNER_ACTIVE' });
    expect(whereMock).toHaveBeenCalledWith('status', '==', 'RUNNER_ACTIVE');
  });
});
