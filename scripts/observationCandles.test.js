// Modo de observação sem banco, fase O2b (docs/known-risks.md item 299): a busca das velas de 15 min na Binance (Spot, a mesma fonte do cron).
// Provas: só velas FECHADAS, paginação por startTime, símbolo validado antes de entrar na URL, e falha só como CÓDIGO (a mensagem de um erro de rede pode citar a URL).
import { describe, it, expect, vi } from 'vitest';
import { fetchClosedCandles15m, BINANCE_BASE_URL } from './observationCandles.mjs';
import { CANDLE_MS } from './observationWatch.mjs';

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const row = (i, extra = {}) => [T0 + i * CANDLE_MS, '100', String(110 + i), String(90 - i), '105', '12.5', T0 + (i + 1) * CANDLE_MS - 1, '0', 1, '0', '0', '0', ...Object.values(extra)];
const resp = (rows, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => rows, text: async () => 'corpo com SEGREDO' });
const agoraDepoisDa = (i) => T0 + (i + 1) * CANDLE_MS; // a vela i acabou de fechar

describe('fetchClosedCandles15m — pedido', () => {
  it('pede a vela de 15 min do símbolo a partir do startTime, na Binance Spot, sem chave', async () => {
    const fetchFn = vi.fn(async () => resp([row(0)]));
    await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(0), fetchFn });
    const url = new URL(fetchFn.mock.calls[0][0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${BINANCE_BASE_URL}/klines`);
    expect(BINANCE_BASE_URL).toBe('https://data-api.binance.vision/api/v3');
    expect(url.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(url.searchParams.get('interval')).toBe('15m');
    expect(url.searchParams.get('startTime')).toBe(String(T0));
    expect(url.searchParams.get('limit')).toBe('1000');
    expect([...url.searchParams.keys()].sort()).toEqual(['interval', 'limit', 'startTime', 'symbol']);
  });
  it('o contexto do retry (que o httpRetry imprime no log PÚBLICO) é fixo: nunca o símbolo da operação (achado do Codex, PR #572)', async () => {
    const fetchFn = vi.fn(async () => resp([row(0)]));
    await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(0), fetchFn });
    const contexto = String(fetchFn.mock.calls[0][1].context);
    expect(contexto).not.toMatch(/BTC|USDT/);
    expect(contexto).toBe('vigia (velas de 15 min)');
  });
  it('usa poucas tentativas (o vigia roda com a queda em curso, sem 15 s de espera por símbolo)', async () => {
    const fetchFn = vi.fn(async () => resp([row(0)]));
    await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(0), fetchFn });
    const opcoes = fetchFn.mock.calls[0][1];
    expect(opcoes.maxRetries).toBeLessThanOrEqual(2);
    expect(opcoes.attemptTimeoutMs).toBeLessThanOrEqual(10_000);
  });
  it.each(['btcusdt', 'BTC&limit=1', 'BTC USDT', '', 'A', 'X'.repeat(30), 'BTC/USDT', null, undefined, 5])('símbolo %j é recusado ANTES de qualquer pedido', async (symbol) => {
    const fetchFn = vi.fn();
    const r = await fetchClosedCandles15m({ symbol, startMs: T0, nowMs: agoraDepoisDa(0), fetchFn });
    expect(r).toEqual({ ok: false, reason: 'simbolo_invalido' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('relógio ou início inválido não pede nada', async () => {
    const fetchFn = vi.fn();
    expect(await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: NaN, nowMs: 1, fetchFn })).toEqual({ ok: false, reason: 'relogio_invalido' });
    expect(await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: undefined, fetchFn })).toEqual({ ok: false, reason: 'relogio_invalido' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('início depois de agora: nada a buscar, sem pedido', async () => {
    const fetchFn = vi.fn();
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0 + 1000, nowMs: T0, fetchFn });
    expect(r).toEqual({ ok: true, candles: [], pages: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('fetchClosedCandles15m — resultado', () => {
  it('converte as colunas para número', async () => {
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(0), fetchFn: async () => resp([row(0)]) });
    expect(r.ok).toBe(true);
    expect(r.candles).toEqual([{ openTime: T0, open: 100, high: 110, low: 90, close: 105 }]);
  });
  it('descarta a vela ainda ABERTA (só vela fechada decide)', async () => {
    const aberta = row(1);
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(0) + 60_000, fetchFn: async () => resp([row(0), aberta]) });
    expect(r.candles.map((c) => c.openTime)).toEqual([T0]);
  });
  it('a vela que fecha exatamente agora já conta', async () => {
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(1), fetchFn: async () => resp([row(0), row(1)]) });
    expect(r.candles).toHaveLength(2);
  });
  it('remove repetidas e ordena', async () => {
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(2), fetchFn: async () => resp([row(2), row(0), row(1), row(1)]) });
    expect(r.candles.map((c) => c.openTime)).toEqual([T0, T0 + CANDLE_MS, T0 + 2 * CANDLE_MS]);
  });
  it('resposta vazia é ok (a cobertura decide se faltou vela)', async () => {
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(3), fetchFn: async () => resp([]) });
    expect(r).toEqual({ ok: true, candles: [], pages: 1 });
  });
});

describe('fetchClosedCandles15m — paginação', () => {
  const pagina = (de, n) => Array.from({ length: n }, (_, k) => row(de + k));
  it('página cheia (1000) pede a próxima a partir da vela seguinte à última', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(resp(pagina(0, 1000)))
      .mockResolvedValueOnce(resp(pagina(1000, 40)));
    const r = await fetchClosedCandles15m({ symbol: 'ETHUSDT', startMs: T0, nowMs: agoraDepoisDa(1039), fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(new URL(fetchFn.mock.calls[1][0]).searchParams.get('startTime')).toBe(String(T0 + 1000 * CANDLE_MS));
    expect(r.candles).toHaveLength(1040);
    expect(r.pages).toBe(2);
  });
  it('para quando a página vem incompleta', async () => {
    const fetchFn = vi.fn().mockResolvedValue(resp(pagina(0, 999)));
    await fetchClosedCandles15m({ symbol: 'ETHUSDT', startMs: T0, nowMs: agoraDepoisDa(998), fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('janela maior que o teto de páginas: recusa em vez de devolver uma sequência furada', async () => {
    let i = 0;
    const fetchFn = vi.fn(async () => { const p = pagina(i, 1000); i += 1000; return resp(p); });
    const r = await fetchClosedCandles15m({ symbol: 'ETHUSDT', startMs: T0, nowMs: agoraDepoisDa(20_000), maxPages: 3, fetchFn });
    expect(r).toEqual({ ok: false, reason: 'janela_longa' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it('página cheia que já chega ao presente não pede outra', async () => {
    const fetchFn = vi.fn().mockResolvedValue(resp(pagina(0, 1000)));
    await fetchClosedCandles15m({ symbol: 'ETHUSDT', startMs: T0, nowMs: agoraDepoisDa(999), fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('fetchClosedCandles15m — falhas viram só um código', () => {
  it('HTTP de erro', async () => {
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(0), fetchFn: async () => resp([], { ok: false, status: 503 }) });
    expect(r).toEqual({ ok: false, reason: 'http_503' });
    expect(JSON.stringify(r)).not.toMatch(/SEGREDO/);
  });
  it('rede: nunca a mensagem do erro (pode citar a URL)', async () => {
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(0), fetchFn: async () => { throw new Error('fetch failed https://data-api.binance.vision/x?key=SEGREDO'); } });
    expect(r).toEqual({ ok: false, reason: 'rede' });
  });
  it('corpo que não é lista', async () => {
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(0), fetchFn: async () => resp({ code: -1121, msg: 'Invalid symbol.' }) });
    expect(r).toEqual({ ok: false, reason: 'resposta_invalida' });
  });
  it.each([
    ['linha curta', [[T0, '1']]],
    ['preço não numérico', [[T0, '100', 'abc', '90', '105', '1', T0 + 1]]],
    ['abertura não numérica', [['x', '100', '110', '90', '105', '1', 1]]],
    ['linha que não é lista', [{ openTime: T0 }]],
  ])('%s', async (_n, rows) => {
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(0), fetchFn: async () => resp(rows) });
    expect(r).toEqual({ ok: false, reason: 'resposta_invalida' });
  });
  it('JSON ilegível', async () => {
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(0), fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < SEGREDO'); } }) });
    expect(r).toEqual({ ok: false, reason: 'rede' });
    expect(JSON.stringify(r)).not.toMatch(/SEGREDO/);
  });
  it('falha na 2ª página descarta tudo (sequência furada não serve)', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(resp(Array.from({ length: 1000 }, (_, k) => row(k))))
      .mockResolvedValueOnce(resp([], { ok: false, status: 500 }));
    const r = await fetchClosedCandles15m({ symbol: 'BTCUSDT', startMs: T0, nowMs: agoraDepoisDa(1500), fetchFn });
    expect(r).toEqual({ ok: false, reason: 'http_500' });
  });
});
