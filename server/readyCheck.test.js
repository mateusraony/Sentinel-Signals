// checkDatabaseReady foi extraído de server/index.js (rota GET /ready) pra
// este arquivo pra poder testar sem precisar de um Postgres real nem das
// credenciais do firebase-admin que index.js exige no carregamento do módulo
// — mesmo motivo de rateLimit.js/requireOwner.js. `pool` é um mock simples
// (só precisa de `.query`), não o pool real do pg.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkDatabaseReady } from './readyCheck.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('checkDatabaseReady', () => {
  it('devolve ok + latência quando o SELECT 1 responde dentro do timeout', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    const result = await checkDatabaseReady(pool, 5000);
    expect(result.status).toBe('ok');
    expect(result.database).toBe('ok');
    expect(result.database_latency_ms).toBeGreaterThanOrEqual(0);
    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('devolve error quando a query rejeita (banco indisponível)', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const result = await checkDatabaseReady(pool, 5000);
    expect(result.status).toBe('error');
    expect(result.database).toBe('error');
    expect(result.error).toBe('connection refused');
  });

  it('devolve error se a query nunca resolve (timeout próprio, não trava para sempre)', async () => {
    vi.useFakeTimers();
    const pool = { query: () => new Promise(() => {}) }; // nunca resolve nem rejeita
    const promise = checkDatabaseReady(pool, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result.status).toBe('error');
    expect(result.error).toBe('timeout');
  });
});
