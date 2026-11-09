// Busca das velas em volta da divulgação (Agenda 4d, parte 2): só leitura pública, falha em silêncio.
import { describe, it, expect, vi } from 'vitest';
import { fetchBtcAfterRelease } from './btcAfterReleaseSource';

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 6, 13, 30);
const row = (t, c) => [t, String(c), String(c), String(c), String(c), '1', t + 59999];
const ok = (rows) => async () => ({ status: 200, text: async () => JSON.stringify(rows) });

describe('fetchBtcAfterRelease', () => {
  it('pede ao host que o painel já usa no navegador as 61 velas de 1 min do BTCUSDT, a partir do minuto ANTES da divulgação', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url) => { calls.push(String(url)); return { status: 200, text: async () => '[]' }; });
    await fetchBtcAfterRelease(T0, { fetchImpl });
    expect(calls).toEqual([`https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&startTime=${T0 - MIN}&limit=61`]);
  });
  it('devolve as velas lidas; corpo inválido, status ruim, exceção e ausência de fetch = null (a linha some)', async () => {
    expect(await fetchBtcAfterRelease(T0, { fetchImpl: ok([row(T0 - MIN, 100)]) })).toEqual([{ t: T0 - MIN, o: 100, h: 100, l: 100, c: 100 }]);
    expect(await fetchBtcAfterRelease(T0, { fetchImpl: async () => ({ status: 200, text: async () => 'lixo' }) })).toBeNull();
    expect(await fetchBtcAfterRelease(T0, { fetchImpl: async () => ({ status: 451, text: async () => '[]' }) })).toBeNull();
    expect(await fetchBtcAfterRelease(T0, { fetchImpl: async () => ({ status: 500, text: async () => '[]' }) })).toBeNull();
    expect(await fetchBtcAfterRelease(T0, { fetchImpl: async () => { throw new Error('Failed to fetch'); } })).toBeNull();
    expect(await fetchBtcAfterRelease(T0, { fetchImpl: null })).toBeNull();
    expect(await fetchBtcAfterRelease(Number.NaN, { fetchImpl: ok([]) })).toBeNull();
  });
});
