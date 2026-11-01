// Contexto de Mercado — Fase 3: a leitura de rede da faixa. Rede toda simulada. Prova: busca os 2 arquivos da branch
// pública SEM cabeçalho extra (sem preflight de CORS), tolera `status.json` ruim, e qualquer falha de `events.json`
// vira erro (a faixa mostra "indisponível") — sem nunca depender de chave ou de log.
import { describe, it, expect, vi } from 'vitest';
import { fetchMarketContext } from './marketContextSource.js';
import { CONTEXT_DATA_BASE } from './marketContextBand.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const EVENTS = [{ id: 'CPI-2026-11-10', kind: 'CPI', reference: '2026-10', startsAtUtc: '2026-11-10T13:30:00.000Z', status: 'oficial', firstSeenAt: '2026-10-31T12:00:00.000Z', lastChangedAt: '2026-10-31T12:00:00.000Z' }];
const STATUS = { version: 1, checkedAt: '2026-11-05T10:00:00.000Z', fred: 'ok', eventsCount: 1, coverageUntil: null, hash: 'a'.repeat(64) };

describe('fetchMarketContext', () => {
  it('lê events.json e status.json da branch pública, sem cabeçalho extra', async () => {
    const fetchImpl = vi.fn(async (url) => json(url.endsWith('events.json') ? EVENTS : STATUS));
    const out = await fetchMarketContext({ fetchImpl });
    expect(out.events.map((e) => e.id)).toEqual(['CPI-2026-11-10']);
    expect(out.checkedAtMs).toBe(Date.parse(STATUS.checkedAt));
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([`${CONTEXT_DATA_BASE}/events.json`, `${CONTEXT_DATA_BASE}/status.json`]);
    for (const [, init] of fetchImpl.mock.calls) expect(Object.keys(init)).toEqual(['signal']); // nada de headers → sem preflight
  });

  it('status.json ruim ou ausente não derruba: events vêm, checkedAtMs = null (a faixa fica "desatualizada")', async () => {
    const semStatus = vi.fn(async (url) => (url.endsWith('events.json') ? json(EVENTS) : json({}, 404)));
    expect((await fetchMarketContext({ fetchImpl: semStatus })).checkedAtMs).toBeNull();
    const statusLixo = vi.fn(async (url) => (url.endsWith('events.json') ? json(EVENTS) : json({ checkedAt: 'x' })));
    expect((await fetchMarketContext({ fetchImpl: statusLixo })).checkedAtMs).toBeNull();
    const statusQuebrado = vi.fn(async (url) => { if (url.endsWith('status.json')) throw new Error('rede'); return json(EVENTS); });
    expect((await fetchMarketContext({ fetchImpl: statusQuebrado })).checkedAtMs).toBeNull();
  });

  it('events.json com erro HTTP (ex.: a branch ainda não existe = 404), corpo que não é lista ou rede fora → lança', async () => {
    await expect(fetchMarketContext({ fetchImpl: async () => json({}, 404) })).rejects.toThrow(/HTTP 404/);
    await expect(fetchMarketContext({ fetchImpl: async () => json({ eventos: [] }) })).rejects.toThrow();
    await expect(fetchMarketContext({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } })).rejects.toThrow();
  });

  it('sem fetch no ambiente → lança (vira "indisponível")', async () => {
    await expect(fetchMarketContext({ fetchImpl: null })).rejects.toThrow(/fetch indispon/);
  });

  it('lixo dentro da lista é ignorado, não derruba as linhas boas', async () => {
    const fetchImpl = async (url) => json(url.endsWith('events.json') ? [...EVENTS, { id: 'x', kind: 'ZZZ' }, null] : STATUS);
    expect((await fetchMarketContext({ fetchImpl })).events).toHaveLength(1);
  });
});
