// Modo de observação sem banco, ENSAIO do vigia (docs/known-risks.md item 299, addendum 6): roda o caminho real do vigia sem gravar NADA.
// Lê o retrato REAL no RTDB, confere as regras publicadas, busca as velas REAIS na Binance e manda 2 mensagens "ENSAIO" no Telegram: um relatório e um exemplo do
// formato do aviso de stop (com valores inventados). Não grava episódio, não marca livro, não toca o Postgres.
// Aqui: RTDB falso (que não guarda null/vazio e recusa chave inválida), Binance e Telegram injetados.
import { describe, it, expect, vi } from 'vitest';
import { runObservationRehearsal, describeRehearsalResult } from './observationRehearsal.mjs';
import { createObservationWatchStore } from './observationWatchStore.mjs';
import { createFakeRtdb, createFakeFirebase, REGRAS_SEGURAS, REGRAS_ABERTAS } from './__fixtures__/fakeRtdb.js';
import { CANDLE_MS } from './observationWatch.mjs';
import { TELEGRAM_MAX_CHARS } from './contextTelegram.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const URL = 'https://projeto-default-rtdb.firebaseio.com';
const CRED = JSON.stringify({ type: 'service_account', project_id: 'p', private_key: 'k', client_email: 'e@p.iam.gserviceaccount.com' });
const ENV = { OBSERVATION_DATABASE_URL: URL, FIREBASE_SERVICE_ACCOUNT_JSON: CRED, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'chat' };
const AGORA = T0 + 20 * MIN; // o retrato é de T0 (20 min atrás)

const op = (id, symbol = 'BTCUSDT', extra = {}) => ({
  id, symbol, side: 'BUY', status: 'SIGNAL_CONFIRMED', tp1_hit: false, entry_price: 100, current_stop: 95, initial_stop: 95, tp1: 110, tp2: 120,
  entry_candle_time_15m: iso(T0 - 60 * MIN), ...extra,
});
const snapshot = ({ ops = [], at = T0, dropped = 0 } = {}) => ({
  version: 1, snapshot_at: iso(at), scan_id: 'x', counts: { operations: ops.length, assets: 0 }, dropped_operations: dropped, telegram_filters: null, operations: ops, assets: [],
});

// velas calmas de 15 min de T0-4h até T0+2h; `toque` troca a máxima/mínima de uma delas
const velasCalmas = (toque = {}) => Array.from({ length: 25 }, (_, k) => {
  const openTime = T0 - 4 * 60 * MIN + k * CANDLE_MS;
  return { openTime, open: 100, high: 101, low: 99, close: 100, ...(toque[openTime] ?? {}) };
});

function montar({ snap, rules = REGRAS_SEGURAS, velas = {}, sendImpl, rtdbFail = {}, env = ENV } = {}) {
  const initial = { observation: {} };
  if (snap) initial.observation.snapshot = snap;
  const rtdb = createFakeRtdb({ rules, initial, fail: rtdbFail });
  const store = createObservationWatchStore({ env, firebase: createFakeFirebase(rtdb), timeoutMs: 100 });
  const enviados = [];
  const send = vi.fn(async (text) => {
    if (sendImpl) { const r = await sendImpl(text, enviados.length); if (!r.ok) return r; }
    enviados.push(text);
    return { ok: true };
  });
  const getCandles = vi.fn(async ({ symbol, startMs, nowMs }) => {
    const v = velas[symbol] ?? velasCalmas();
    if (v.erro) return { ok: false, reason: v.erro };
    return { ok: true, candles: v.filter((c) => c.openTime >= startMs && c.openTime + CANDLE_MS <= nowMs), pages: 1 };
  });
  const run = (extra = {}) => runObservationRehearsal({ env, store, send, getCandles, nowMs: AGORA, ...extra });
  return { rtdb, store, send, enviados, getCandles, run };
}

describe('ensaio — desligado', () => {
  it('sem OBSERVATION_DATABASE_URL: não lê, não busca, não envia', async () => {
    const m = montar({ snap: snapshot(), env: { ...ENV, OBSERVATION_DATABASE_URL: '' } });
    const r = await m.run({ env: { ...ENV, OBSERVATION_DATABASE_URL: '' } });
    expect(r).toEqual({ ok: false, skipped: 'sem_url' });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.getCandles).not.toHaveBeenCalled();
    expect(m.rtdb.calls).toEqual([]);
  });
});

describe('ensaio — tudo certo', () => {
  const sano = () => montar({ snap: snapshot({ ops: [op('a', 'BTCUSDT'), op('b', 'ETHUSDT')], dropped: 1 }) });

  it('resultado OK, com as contagens', async () => {
    const m = sano();
    const r = await m.run();
    expect(r).toMatchObject({ ok: true, problems: [], operations: 2, dropped: 1, events: 0 });
    expect(r.candles).toMatchObject({ symbols: 2, ok: 2 });
    expect(r.rules).toBe('fechadas');
    expect(r.snapshotAgeMin).toBe(20);
  });
  it('NÃO grava nada no RTDB (nem episódio, nem livro) e só lê/confere regras', async () => {
    const m = sano();
    await m.run();
    expect(m.rtdb.writes()).toEqual([]);
    expect(m.rtdb.read('observation/episode')).toBeUndefined();
    expect(new Set(m.rtdb.calls.map((c) => c.op))).toEqual(new Set(['get', 'rules']));
  });
  it('manda 2 mensagens: o relatório e o exemplo de formato (valores inventados)', async () => {
    const m = sano();
    await m.run();
    expect(m.enviados).toHaveLength(2);
    expect(m.enviados[0]).toMatch(/ENSAIO/);
    expect(m.enviados[0]).toMatch(/nada foi gravado/i);
    expect(m.enviados[1]).toMatch(/ENSAIO/);
    expect(m.enviados[1]).toMatch(/valores inventados/i);
    expect(m.enviados[1]).toMatch(/Stop atingido/);
  });
  it('o relatório diz idade do retrato, regras, velas por símbolo e o resultado', async () => {
    const m = sano();
    await m.run();
    const t = m.enviados[0];
    expect(t).toContain('20 min');
    expect(t).toMatch(/fechadas/);
    expect(t).toContain('BTC/USDT');
    expect(t).toContain('ETH/USDT');
    expect(t).toMatch(/TUDO OK/);
    expect(t).toMatch(/1 opera[^.]*FORA do retrato/);
  });
  it('busca as velas UMA vez por símbolo, numa janela de 2 h até agora', async () => {
    const m = sano();
    await m.run();
    expect(m.getCandles).toHaveBeenCalledTimes(2);
    const { startMs, nowMs } = m.getCandles.mock.calls[0][0];
    expect(nowMs).toBe(AGORA);
    expect(startMs).toBeGreaterThanOrEqual(AGORA - 2 * 60 * MIN - CANDLE_MS);
    expect(startMs).toBeLessThanOrEqual(AGORA - 2 * 60 * MIN + CANDLE_MS);
    expect(startMs % CANDLE_MS).toBe(0);
  });
  it('sem operações vivas: ainda testa a Binance com um símbolo de prova', async () => {
    const m = montar({ snap: snapshot({ ops: [] }) });
    const r = await m.run();
    expect(r).toMatchObject({ ok: true, operations: 0 });
    expect(m.getCandles).toHaveBeenCalledTimes(1);
    expect(m.getCandles.mock.calls[0][0].symbol).toBe('BTCUSDT');
    expect(m.enviados[0]).toMatch(/s[óo] para testar|prova/i);
  });
  it('símbolos repetidos são buscados uma vez; o teto é de 10', async () => {
    const ops = Array.from({ length: 14 }, (_, i) => op(`id${i}`, `MOEDA${i}USDT`));
    const m = montar({ snap: snapshot({ ops: [...ops, op('dup', 'MOEDA0USDT')] }) });
    const r = await m.run();
    expect(m.getCandles).toHaveBeenCalledTimes(10);
    expect(r.candles.symbols).toBe(10);
    expect(m.enviados[0].length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });
});

describe('ensaio — o que o vigia avisaria agora', () => {
  it('conta os eventos que o vigia acharia com o retrato real, sem enviar aviso de verdade', async () => {
    const velas = { BTCUSDT: velasCalmas({ [T0 + 0]: { low: 94 } }) }; // a vela das 10:00 tocou o stop de 95
    const m = montar({ snap: snapshot({ ops: [op('a', 'BTCUSDT')] }), velas });
    const r = await m.run();
    expect(r).toMatchObject({ ok: true, events: 1 });
    expect(m.enviados[0]).toMatch(/avisaria/i);
    expect(m.enviados.filter((t) => /Stop atingido/.test(t))).toHaveLength(1); // só o EXEMPLO de formato
    expect(m.enviados[1]).toMatch(/valores inventados/i);
  });
});

describe('ensaio — retrato mais velho que a janela de velas', () => {
  it('a avaliação é PULADA (a janela de 2 h não cobre o retrato, contar eventos seria parcial) e o retrato velho é problema', async () => {
    const velas = { BTCUSDT: velasCalmas({ [AGORA - 60 * MIN - ((AGORA - 60 * MIN) % CANDLE_MS)]: { low: 90 } }) }; // toque dentro da janela
    const m = montar({ snap: snapshot({ ops: [op('a', 'BTCUSDT')], at: AGORA - 3 * 60 * MIN }), velas });
    const r = await m.run();
    expect(r.events).toBe(0);
    expect(r.problems).toContain('retrato_velho');
    expect(m.enviados[0]).toMatch(/pulada/i);
  });
});

describe('ensaio — problemas viram resultado vermelho, com o código', () => {
  it('sem retrato', async () => {
    const m = montar({});
    const r = await m.run();
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('sem_retrato');
    expect(m.enviados[0]).toMatch(/PROBLEMAS/);
  });
  it('retrato velho (mais de 45 min)', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')], at: T0 - 60 * MIN }) });
    const r = await m.run();
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('retrato_velho');
    expect(m.enviados[0]).toMatch(/velho/i);
  });
  it('retrato de versão desconhecida conta como ilegível', async () => {
    const m = montar({ snap: { ...snapshot({ ops: [op('a')] }), version: 9 } });
    const r = await m.run();
    expect(r.problems).toContain('sem_retrato');
  });
  it('regras publicadas ABERTAS', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')] }), rules: REGRAS_ABERTAS });
    const r = await m.run();
    expect(r.ok).toBe(false);
    expect(r.rules).toBe('abertas');
    expect(r.problems).toContain('regras_abertas');
    expect(m.enviados[0]).toMatch(/ABERTAS/);
    expect(m.rtdb.writes()).toEqual([]);
  });
  it('regras ilegíveis', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')] }), rtdbFail: { rules: () => new Error('x') } });
    const r = await m.run();
    expect(r.rules).toBe('nao_verificadas');
    expect(r.problems).toContain('regras_nao_verificadas');
  });
  it('não consegue ler o RTDB: relatório mesmo assim, com o código', async () => {
    const m = montar({ rtdbFail: { get: () => Object.assign(new Error(`url ${URL}`), { code: 'NETWORK_ERROR' }) } });
    const r = await m.run();
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('leitura_NETWORK_ERROR');
    expect(m.enviados[0]).not.toMatch(/firebaseio/);
  });
  it('velas de um símbolo falharam: os outros seguem e o erro aparece', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a', 'BTCUSDT'), op('b', 'ETHUSDT')] }), velas: { BTCUSDT: { erro: 'http_503' } } });
    const r = await m.run();
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('velas_http_503');
    expect(r.candles).toMatchObject({ symbols: 2, ok: 1 });
    expect(m.enviados[0]).toMatch(/BTC\/USDT.*FALHOU.*http_503/);
  });
  it('vela faltando na janela', async () => {
    const buraco = velasCalmas().filter((c) => c.openTime !== T0 - 30 * MIN);
    const m = montar({ snap: snapshot({ ops: [op('a')] }), velas: { BTCUSDT: buraco } });
    const r = await m.run();
    expect(r.problems).toContain('velas_incompletas');
    expect(r.ok).toBe(false);
  });
  it('símbolo estranho no retrato não vira pedido', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a', 'BTC/../x')] }) });
    const r = await m.run();
    expect(r.problems).toContain('velas_simbolo_invalido');
    expect(m.getCandles).not.toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTC/../x' }));
  });
  it('Telegram falhou: o resultado é vermelho com o código do envio (e o log não leva texto)', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')] }), sendImpl: async () => ({ ok: false, reason: 'http_401' }) });
    const r = await m.run();
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('envio_http_401');
    expect(r.telegram).toBe('http_401');
  });
  it('o 2º envio (exemplo) falhou: vermelho também', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')] }), sendImpl: async (_t, n) => (n === 1 ? { ok: false, reason: 'rede' } : { ok: true }) });
    const r = await m.run();
    expect(r.problems).toContain('envio_rede');
  });
  it('nunca lança', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')] }) });
    const r = await runObservationRehearsal({ env: ENV, store: m.store, send: () => { throw new Error('boom'); }, getCandles: m.getCandles, nowMs: AGORA });
    expect(r.ok).toBe(false);
  });
});

describe('ensaio — texto', () => {
  it('escapa o símbolo vindo do banco e só deixa as marcações do template', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a', '<b>X</b>USDT')] }) });
    await m.run();
    const solto = m.enviados[0].replace(/<\/?(b|i)>/g, '');
    expect(/[<>]/.test(solto)).toBe(false);
  });
  it('cabe no Telegram', async () => {
    const ops = Array.from({ length: 100 }, (_, i) => op(`id${i}`, `M${i}USDT`));
    const m = montar({ snap: snapshot({ ops }) });
    await m.run();
    for (const t of m.enviados) expect(t.length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });
});

describe('describeRehearsalResult — o que vai para o log PÚBLICO', () => {
  it('OK: só contagem', async () => {
    const m = montar({ snap: snapshot({ ops: [op('SEGREDO-ID', 'BTCUSDT')] }) });
    const r = await m.run();
    const linha = describeRehearsalResult(r);
    expect(linha).toMatch(/^\[ensaio\] OK/);
    expect(linha).toMatch(/ops=1/);
    expect(linha).not.toMatch(/SEGREDO-ID|BTC|USDT|\$/);
  });
  it('problemas: só os códigos', () => {
    const linha = describeRehearsalResult({ ok: false, problems: ['regras_abertas', 'velas_http_503'], operations: 1, candles: { symbols: 1, ok: 0 } });
    expect(linha).toMatch(/PROBLEMAS/);
    expect(linha).toContain('regras_abertas');
    expect(linha).toContain('velas_http_503');
  });
  it('código estranho nunca vai para o log', () => {
    const linha = describeRehearsalResult({ ok: false, problems: ['https://x.firebaseio.com/?token=SEGREDO'] });
    expect(linha).not.toMatch(/SEGREDO|firebaseio/);
  });
  it('desligado', () => {
    expect(describeRehearsalResult({ ok: false, skipped: 'sem_url' })).toMatch(/desligado/);
  });
});
