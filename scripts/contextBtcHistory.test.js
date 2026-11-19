// Item 285, addendum 27 — o que o BTC fez nas últimas divulgações. Sem rede de verdade: o fetch é falso e entrega velas de 1 min montadas aqui.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadReactions, summarizeReactions, readHistoryFile, partialMoves, loadMovesSince, loadBtcDay, REACTION_COUNT } from './contextBtcHistory.mjs';
import { nyToUtc } from './contextTime.mjs';

const MIN = 60 * 1000;
const t0Of = (date) => nyToUtc(date, '08:30').ms;
const HISTORY = { version: 1, dates: { CPI: ['2026-10-24', '2026-09-11', '2026-08-12', '2026-07-15'], FOMC: undefined } };

/** 61 velas de 1 min a partir de t0−1 min: a referência fecha em 100 e o fechamento do minuto t0+(n−1) é 100·(1+pct[n]/100). */
function klinesBody(t0, pct) {
  const rows = [];
  for (let i = 0; i < 61; i += 1) {
    const minute = i - 1; // −1 = referência
    let close = 100;
    if (minute >= 0) {
      const marks = Object.keys(pct).map(Number).sort((a, b) => a - b);
      const upTo = marks.find((m) => minute + 1 <= m) ?? marks[marks.length - 1];
      close = 100 * (1 + pct[upTo] / 100);
    }
    const t = t0 + (i - 1) * MIN;
    rows.push([t, String(close), String(close * 1.001), String(close * 0.999), String(close), '1', t + 59999, '1', 1, '1', '1', '0']);
  }
  return JSON.stringify(rows);
}

const fakeBinance = (byT0) => vi.fn(async (url) => {
  const start = Number(new URL(url).searchParams.get('startTime'));
  const t0 = start + MIN;
  const body = byT0.get(t0);
  if (body === undefined) return { ok: false, status: 400, text: async () => '' };
  return { ok: true, status: 200, text: async () => body };
});

describe('loadReactions', () => {
  it('busca a janela de cada uma das 3 últimas divulgações e mede +5, +30 e +60 min contra a referência', async () => {
    const map = new Map([
      [t0Of('2026-10-24'), klinesBody(t0Of('2026-10-24'), { 5: 0.1, 30: 0.3, 60: 0.4 })],
      [t0Of('2026-09-11'), klinesBody(t0Of('2026-09-11'), { 5: -0.5, 30: -0.9, 60: -1.2 })],
      [t0Of('2026-08-12'), klinesBody(t0Of('2026-08-12'), { 5: 0, 30: 0.2, 60: 0.1 })],
    ]);
    const fetchImpl = fakeBinance(map);
    const rows = await loadReactions({ kind: 'CPI', history: HISTORY, fetchImpl, sleep: async () => {} });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(rows.map((r) => r.date)).toEqual(['2026-10-24', '2026-09-11', '2026-08-12']);
    expect(rows[0].reaction.moves[5]).toBeCloseTo(0.1, 6);
    expect(rows[0].reaction.moves[30]).toBeCloseTo(0.3, 6);
    expect(rows[0].reaction.moves[60]).toBeCloseTo(0.4, 6);
    expect(rows[1].reaction.moves[60]).toBeCloseTo(-1.2, 6);
    expect(REACTION_COUNT).toBe(3);
  });

  it('só a Binance Spot pública, sem chave, e o intervalo certo (1 min, a partir do minuto antes da divulgação)', async () => {
    const fetchImpl = fakeBinance(new Map());
    await loadReactions({ kind: 'CPI', history: HISTORY, count: 1, fetchImpl, sleep: async () => {} });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin).toBe('https://data-api.binance.vision');
    expect(url.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(url.searchParams.get('interval')).toBe('1m');
    expect(Number(url.searchParams.get('startTime'))).toBe(t0Of('2026-10-24') - MIN);
    expect(url.search).not.toMatch(/key|token|secret/i);
  });

  it('falha em UMA divulgação vira "sem dado" daquela linha; as outras seguem', async () => {
    const map = new Map([[t0Of('2026-09-11'), klinesBody(t0Of('2026-09-11'), { 5: -0.5, 30: -0.9, 60: -1.2 })]]);
    const rows = await loadReactions({ kind: 'CPI', history: HISTORY, fetchImpl: fakeBinance(map), sleep: async () => {} });
    expect(rows.map((r) => r.reaction === null)).toEqual([true, false, true]);
  });

  it('rede que lança, corpo ilegível e vela faltando: sem dado, nunca lança nem inventa número', async () => {
    const lanca = vi.fn(async () => { throw new Error('rede caiu em https://exemplo/segredo'); });
    const a = await loadReactions({ kind: 'CPI', history: HISTORY, fetchImpl: lanca, sleep: async () => {} });
    expect(a.every((r) => r.reaction === null)).toBe(true);
    const lixo = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'não é json' }));
    expect((await loadReactions({ kind: 'CPI', history: HISTORY, fetchImpl: lixo, sleep: async () => {} })).every((r) => r.reaction === null)).toBe(true);
    const t0 = t0Of('2026-10-24');
    const furado = JSON.parse(klinesBody(t0, { 5: 0.1, 30: 0.3, 60: 0.4 })).filter((_, i) => i !== 30); // falta 1 vela no meio
    const fetchFurado = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(furado) }));
    const b = await loadReactions({ kind: 'CPI', history: HISTORY, count: 1, fetchImpl: fetchFurado, sleep: async () => {} });
    expect(b[0].reaction).toBeNull();
  });

  it('429/5xx tentam de novo (até 3 vezes, com espera) e 4xx não', async () => {
    const t0 = t0Of('2026-10-24');
    let n = 0;
    const instavel = vi.fn(async () => {
      n += 1;
      return n < 3 ? { ok: false, status: 429, text: async () => '' } : { ok: true, status: 200, text: async () => klinesBody(t0, { 5: 0.1, 30: 0.3, 60: 0.4 }) };
    });
    const sleep = vi.fn(async () => {});
    const rows = await loadReactions({ kind: 'CPI', history: HISTORY, count: 1, fetchImpl: instavel, sleep });
    expect(instavel).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(rows[0].reaction).not.toBeNull();
    const proibido = vi.fn(async () => ({ ok: false, status: 403, text: async () => '' }));
    await loadReactions({ kind: 'CPI', history: HISTORY, count: 1, fetchImpl: proibido, sleep });
    expect(proibido).toHaveBeenCalledTimes(1);
  });

  it('tipo sem histórico (FOMC, ou arquivo ausente): lista vazia e nenhuma chamada de rede', async () => {
    const fetchImpl = vi.fn();
    expect(await loadReactions({ kind: 'FOMC', history: HISTORY, fetchImpl })).toEqual([]);
    expect(await loadReactions({ kind: 'CPI', history: null, fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('respeita `count`', async () => {
    const fetchImpl = fakeBinance(new Map());
    const rows = await loadReactions({ kind: 'CPI', history: HISTORY, count: 2, fetchImpl, sleep: async () => {} });
    expect(rows.length).toBe(2);
  });
});

describe('summarizeReactions', () => {
  const r = (m60) => ({ date: '2026-10-24', reaction: { moves: { 5: 0, 30: 0, 60: m60 }, rangePct: 1 } });
  it('mediana do TAMANHO (sem sinal), subiu/caiu e casos com número', () => {
    const s = summarizeReactions([r(0.4), r(-1.2), r(0), { date: 'x', reaction: null }]);
    expect(s).toEqual({ total: 4, n: 3, medAbs60: 0.4, up60: 1, down60: 1 });
  });
  it('vazio, nulo e tudo sem dado: sem mediana inventada', () => {
    expect(summarizeReactions([])).toMatchObject({ n: 0, medAbs60: null });
    expect(summarizeReactions(null)).toMatchObject({ total: 0, n: 0, medAbs60: null });
    expect(summarizeReactions([{ date: 'x', reaction: null }])).toMatchObject({ total: 1, n: 0, medAbs60: null });
  });
});

describe('readHistoryFile', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hist-read-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  it('lê o arquivo bom; ausente ou ilegível vira histórico vazio (não lança)', () => {
    expect(readHistoryFile(dir)).toEqual({ version: 1, dates: {} });
    fs.writeFileSync(path.join(dir, 'history.json'), '{ lixo');
    expect(readHistoryFile(dir)).toEqual({ version: 1, dates: {} });
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ version: 1, dates: { CPI: ['2026-10-24'] } }));
    expect(readHistoryFile(dir).dates.CPI).toEqual(['2026-10-24']);
  });
});

// Fase 4b-3: o movimento DESDE a divulgação, parcial (cada prazo só aparece quando terminou).
describe('partialMoves / loadMovesSince', () => {
  const T0 = Date.parse('2026-12-10T13:30:00.000Z');
  const candlesUntil = (minutes) => {
    const c = [{ t: T0 - MIN, o: 100, h: 100, l: 100, c: 100 }];
    for (let i = 0; i < minutes; i += 1) c.push({ t: T0 + i * MIN, o: 100, h: 101, l: 99, c: 100 + (i + 1) / 10 });
    return c;
  };
  it('só entra o prazo que JÁ terminou (a vela do prazo precisa ter fechado)', () => {
    const m = partialMoves(candlesUntil(31), T0, T0 + 31 * MIN);
    expect(m[5]).toBeCloseTo(0.5, 6);
    expect(m[30]).toBeCloseTo(3, 6);
    expect(m[60]).toBeNull();
  });
  it('a vela que ainda está se formando (prazo não fechou) NÃO conta, mesmo existindo na resposta', () => {
    const m = partialMoves(candlesUntil(31), T0, T0 + 30 * MIN - 1); // faltam 1 ms para o prazo de 30 min fechar
    expect(m[5]).not.toBeNull();
    expect(m[30]).toBeNull();
  });
  it('sem a vela de referência: null; com buraco no meio: só o que tem vela', () => {
    expect(partialMoves(candlesUntil(31).slice(1), T0, T0 + 31 * MIN)).toBeNull();
    expect(partialMoves([], T0, T0)).toBeNull();
    expect(partialMoves(null, T0, T0)).toBeNull();
    const furado = candlesUntil(31).filter((c) => c.t !== T0 + 29 * MIN);
    const m = partialMoves(furado, T0, T0 + 31 * MIN);
    expect(m[5]).not.toBeNull();
    expect(m[30]).toBeNull();
  });
  it('loadMovesSince busca as velas da divulgação; fonte fora do ar ou que lança vira null (nunca lança)', async () => {
    const corpo = JSON.stringify(candlesUntil(31).map((c) => [c.t, String(c.o), String(c.h), String(c.l), String(c.c), '1', c.t + 59999]));
    const ok = vi.fn(async () => ({ ok: true, status: 200, text: async () => corpo }));
    const m = await loadMovesSince({ t0Ms: T0, nowMs: T0 + 31 * MIN, fetchImpl: ok, sleep: async () => {} });
    expect(m[30]).toBeCloseTo(3, 6);
    expect(Number(new URL(ok.mock.calls[0][0]).searchParams.get('startTime'))).toBe(T0 - MIN);
    const fora = vi.fn(async () => ({ ok: false, status: 403, text: async () => '' }));
    expect(await loadMovesSince({ t0Ms: T0, nowMs: T0, fetchImpl: fora, sleep: async () => {} })).toBeNull();
    const lanca = vi.fn(async () => { throw new Error('x'); });
    expect(await loadMovesSince({ t0Ms: T0, nowMs: T0, fetchImpl: lanca, sleep: async () => {} })).toBeNull();
  });
});

// Addendum 35: o BTC no dia (velas de 1 h do dia de Brasília).
describe('loadBtcDay — o BTC do dia, medido', () => {
  const HOUR = 60 * MIN;
  const START = Date.parse('2026-11-19T03:00:00Z'); // 00:00 de Brasília
  const NOW = Date.parse('2026-11-20T00:10:00Z');
  const hourly = (n, { open = 100, close = 101, high = 103, low = 99, skipFirst = false } = {}) => JSON.stringify(Array.from({ length: n }, (_, i) => {
    const t = START + (skipFirst ? i + 1 : i) * HOUR;
    return [t, String(i === 0 ? open : 100), String(i === 1 ? high : 100.5), String(i === 2 ? low : 99.8), String(i === n - 1 ? close : 100.2), '1', t + HOUR - 1, '1', 1, '1', '1', '0'];
  }));
  const ok = (body) => vi.fn(async () => ({ ok: true, status: 200, text: async () => body }));

  it('variação contra a abertura da 1ª vela do dia, amplitude mínima→máxima e a URL certa (1 h, a janela do dia)', async () => {
    const f = ok(hourly(22));
    const r = await loadBtcDay({ dayStartMs: START, nowMs: NOW, fetchImpl: f, sleep: async () => {} });
    expect(r.pct).toBeCloseTo(1, 6); // 100 → 101
    expect(r.rangePct).toBeCloseTo((103 / 99 - 1) * 100, 6);
    expect(r.hours).toBe(22);
    const u = new URL(String(f.mock.calls[0][0]));
    expect(u.origin + u.pathname).toBe('https://data-api.binance.vision/api/v3/klines');
    expect(Object.fromEntries(u.searchParams)).toEqual({ symbol: 'BTCUSDT', interval: '1h', startTime: String(START), endTime: String(NOW), limit: '48' });
  });
  it('sem a vela de abertura do dia (a lista começa depois), vazia, fonte fora do ar ou que lança: null — nunca lança', async () => {
    expect(await loadBtcDay({ dayStartMs: START, nowMs: NOW, fetchImpl: ok(hourly(10, { skipFirst: true })), sleep: async () => {} })).toBeNull();
    expect(await loadBtcDay({ dayStartMs: START, nowMs: NOW, fetchImpl: ok('[]'), sleep: async () => {} })).toBeNull();
    expect(await loadBtcDay({ dayStartMs: START, nowMs: NOW, fetchImpl: vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })), sleep: async () => {} })).toBeNull();
    expect(await loadBtcDay({ dayStartMs: START, nowMs: NOW, fetchImpl: vi.fn(async () => { throw new Error('boom https://x?key=SEGREDO'); }), sleep: async () => {} })).toBeNull();
  });
});
