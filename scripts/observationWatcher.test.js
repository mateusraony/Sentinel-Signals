// Modo de observação sem banco, fase O2b (docs/known-risks.md item 299): o orquestrador do vigia e o fechamento do episódio na volta do banco.
// Usa o armazenamento REAL do vigia sobre um Realtime Database FALSO que se comporta como o de verdade (não guarda null nem vazio, recusa chave inválida),
// com Telegram e Binance injetados. Provas: cada aviso sai UMA vez, falha de envio é tentada de novo, ids com pontuação funcionam no livro, e nada do que vai
// para o log leva texto de mensagem, símbolo, preço ou id.
import { describe, it, expect, vi } from 'vitest';
import { runObservationWatch, closeObservationEpisode, describeWatchResult, describeCloseResult } from './observationWatcher.mjs';
import { createObservationWatchStore, EPISODE_PATH } from './observationWatchStore.mjs';
import { createFakeRtdb, createFakeFirebase, REGRAS_SEGURAS, REGRAS_ABERTAS } from './__fixtures__/fakeRtdb.js';
import { CANDLE_MS, encodeKeyPart } from './observationWatch.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const URL = 'https://projeto-default-rtdb.firebaseio.com';
const CRED = JSON.stringify({ type: 'service_account', project_id: 'p', private_key: 'k', client_email: 'e@p.iam.gserviceaccount.com' });
const ENV = { OBSERVATION_DATABASE_URL: URL, FIREBASE_SERVICE_ACCOUNT_JSON: CRED, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'chat' };

const op = (id, symbol = 'BTCUSDT', side = 'BUY', extra = {}) => ({
  id, symbol, side, status: 'SIGNAL_CONFIRMED', tp1_hit: false, entry_price: 100, current_stop: 95, initial_stop: 95, tp1: 110, tp2: 120,
  entry_candle_time_15m: iso(T0 - 60 * MIN), ...extra,
});
const snapshot = ({ ops = [], at = T0, dropped = 0 } = {}) => ({
  version: 1, snapshot_at: iso(at), scan_id: 'x', counts: { operations: ops.length, assets: 0 }, dropped_operations: dropped, telegram_filters: null, operations: ops, assets: [],
});
const candle = (i, high, low) => ({ openTime: T0 + i * CANDLE_MS, open: 100, high, low, close: 100 });
const calm = (n) => Array.from({ length: n }, (_, i) => candle(i, 101, 99));

function montar({ snap, episode, rules = REGRAS_SEGURAS, velas = {}, sendImpl, rtdbFail = {} } = {}) {
  const initial = { observation: {} };
  if (snap) initial.observation.snapshot = snap;
  if (episode) initial.observation.episode = episode;
  const rtdb = createFakeRtdb({ rules, initial, fail: rtdbFail });
  const store = createObservationWatchStore({ env: ENV, firebase: createFakeFirebase(rtdb), timeoutMs: 100 });
  const enviados = [];
  const send = vi.fn(async (text) => {
    if (sendImpl) { const r = await sendImpl(text, enviados.length); if (!r.ok) return r; }
    enviados.push(text);
    return { ok: true };
  });
  const getCandles = vi.fn(async ({ symbol, startMs, nowMs }) => {
    const v = velas[symbol];
    if (v === undefined) return { ok: true, candles: [], pages: 1 };
    if (v.erro) return { ok: false, reason: v.erro };
    return { ok: true, candles: v.filter((c) => c.openTime >= startMs && c.openTime + CANDLE_MS <= nowMs), pages: 1 };
  });
  const sleep = vi.fn(async () => {});
  const run = (nowMs, extra = {}) => runObservationWatch({ env: ENV, store, send, getCandles, nowMs, sleep, pauseMs: 1100, ...extra });
  return { rtdb, store, send, enviados, getCandles, sleep, run };
}

describe('runObservationWatch — desligado e falhas de infraestrutura', () => {
  it('sem OBSERVATION_DATABASE_URL: não faz nada (nem lê, nem envia)', async () => {
    const m = montar({ snap: snapshot() });
    const r = await runObservationWatch({ env: { ...ENV, OBSERVATION_DATABASE_URL: '' }, store: m.store, send: m.send, getCandles: m.getCandles, nowMs: T0 });
    expect(r).toEqual({ ok: false, skipped: 'sem_url' });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.rtdb.calls).toEqual([]);
  });
  it('não consegue ler o RTDB: devolve o código e não envia nada', async () => {
    const m = montar({ rtdbFail: { get: () => Object.assign(new Error(`falha em ${URL}`), { code: 'NETWORK_ERROR' }) } });
    const r = await m.run(T0 + 5 * MIN);
    expect(r).toMatchObject({ ok: false, erro: 'NETWORK_ERROR' });
    expect(m.send).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toMatch(/firebaseio/);
  });
  it.each([['observation/snapshot'], ['observation/episode']])('falha ao ler SÓ %s: nada de aviso (não dá para confundir "não consegui ler" com "não existe")', async (caminho) => {
    const m = montar({ snap: snapshot({ ops: [op('a')] }), rtdbFail: { [`get:${caminho}`]: () => Object.assign(new Error('x'), { code: 'NETWORK_ERROR' }) } });
    const r = await m.run(T0 + 15 * MIN);
    expect(r).toEqual({ ok: false, erro: 'NETWORK_ERROR' });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.rtdb.writes()).toEqual([]);
  });
  it('não consegue GRAVAR o episódio (regras abertas): não envia aviso que não saberia marcar como enviado', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')] }), rules: REGRAS_ABERTAS, velas: { BTCUSDT: [candle(0, 101, 90), ...calm(1).slice(1)] } });
    const r = await m.run(T0 + 20 * MIN);
    expect(r).toMatchObject({ ok: false, erro: 'regras_abertas' });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.rtdb.writes()).toEqual([]);
  });
});

describe('runObservationWatch — sem retrato utilizável', () => {
  it('sem retrato: abre o episódio, avisa UMA vez que não está vigiando e não busca vela nenhuma', async () => {
    const m = montar({});
    const r1 = await m.run(T0);
    expect(r1).toMatchObject({ ok: true, status: 'no_snapshot' });
    expect(m.enviados).toHaveLength(1);
    expect(m.enviados[0]).toMatch(/N[ÃA]O est[áa] vigiando/i);
    expect(m.getCandles).not.toHaveBeenCalled();
    const r2 = await m.run(T0 + 15 * MIN);
    expect(r2).toMatchObject({ ok: true, status: 'no_snapshot' });
    expect(m.enviados).toHaveLength(1); // não repete a cada passada (o RTDB não guarda o null do snapshot_at: a ida e volta não pode reabrir o episódio)
    expect(m.rtdb.read(EPISODE_PATH)).toMatchObject({ status: 'no_snapshot', start_notice_sent: true, announced: true });
  });
  it('retrato velho demais NO INÍCIO da queda: avisa uma vez e não vigia', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')], at: T0 }), velas: { BTCUSDT: [candle(0, 101, 90)] } });
    const r = await m.run(T0 + 3 * 60 * MIN);
    expect(r).toMatchObject({ ok: true, status: 'stale' });
    expect(m.enviados).toHaveLength(1);
    expect(m.enviados[0]).toMatch(/N[ÃA]O est[áa] vigiando/i);
    expect(m.enviados[0]).toMatch(/2 h/);
    expect(m.getCandles).not.toHaveBeenCalled();
    await m.run(T0 + 5 * 60 * MIN);
    expect(m.enviados).toHaveLength(1);
  });
  it('a queda longa NÃO desliga o vigia: 2 dias depois do retrato bom (episódio aberto a 30 min do retrato) segue vigiando', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')], at: T0 }), velas: { BTCUSDT: calm(300) } });
    await m.run(T0 + 30 * MIN);
    const r = await m.run(T0 + 2 * 24 * 60 * MIN);
    expect(r).toMatchObject({ ok: true, status: 'watching' });
    expect(m.getCandles).toHaveBeenCalledTimes(2);
  });
});

describe('runObservationWatch — vigiando', () => {
  const dois = () => snapshot({ ops: [op('a', 'BTCUSDT'), op('b', 'ETHUSDT', 'SELL', { current_stop: 105, tp1: 90, tp2: 80 })] });

  it('1ª passada: manda "ligado" uma vez, busca as velas UMA vez por símbolo e não avisa nada se nada tocou', async () => {
    const m = montar({ snap: dois(), velas: { BTCUSDT: calm(3), ETHUSDT: calm(3) } });
    const r = await m.run(T0 + 30 * MIN);
    expect(r).toMatchObject({ ok: true, status: 'watching', operations: 2, alerts: 0 });
    expect(m.enviados).toHaveLength(1);
    expect(m.enviados[0]).toMatch(/Modo de observação ligado/);
    expect(m.getCandles).toHaveBeenCalledTimes(2);
    const r2 = await m.run(T0 + 45 * MIN);
    expect(r2.alerts).toBe(0);
    expect(m.enviados).toHaveLength(1); // o "ligado" não se repete
  });
  it('várias operações do MESMO símbolo: busca as velas uma vez só', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a', 'BTCUSDT'), op('b', 'BTCUSDT', 'SELL', { current_stop: 105, tp1: 90, tp2: 80 }), op('c', 'BTCUSDT')] }), velas: { BTCUSDT: calm(2) } });
    await m.run(T0 + 30 * MIN);
    expect(m.getCandles).toHaveBeenCalledTimes(1);
  });
  it('pede as velas a partir da PRÓXIMA abertura depois do retrato (a vela que o atravessa não vale)', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')], at: T0 + 7 * MIN }), velas: { BTCUSDT: calm(3) } });
    await m.run(T0 + 45 * MIN);
    expect(m.getCandles.mock.calls[0][0]).toMatchObject({ symbol: 'BTCUSDT', startMs: T0 + 15 * MIN, nowMs: T0 + 45 * MIN });
  });
  it('retrato exatamente na abertura de uma vela: ela vale e é a primeira pedida', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')], at: T0 }), velas: { BTCUSDT: calm(3) } });
    await m.run(T0 + 45 * MIN);
    expect(m.getCandles.mock.calls[0][0].startMs).toBe(T0);
  });
  it('stop tocado: UM aviso, o livro grava, e as passadas seguintes não repetem', async () => {
    const m = montar({ snap: dois(), velas: { BTCUSDT: [candle(0, 101, 94), candle(1, 101, 99)], ETHUSDT: calm(2) } });
    const r1 = await m.run(T0 + 30 * MIN);
    expect(r1).toMatchObject({ ok: true, alerts: 1 });
    const alerta = m.enviados.find((t) => /Stop atingido/.test(t));
    expect(alerta).toContain('BTC/USDT');
    expect(alerta).toContain('95.0000');
    const ep = m.rtdb.read(EPISODE_PATH);
    expect(ep.alerts_sent).toBe(1);
    expect(ep.sent[encodeKeyPart('a')].stop.at).toBe(iso(T0 + 30 * MIN));
    const antes = m.enviados.length;
    const r2 = await m.run(T0 + 45 * MIN);
    expect(r2.alerts).toBe(0);
    expect(m.enviados).toHaveLength(antes);
  });
  it('TP1 numa passada e o stop (breakeven) numa passada seguinte: dois avisos, cada um uma vez', async () => {
    const velas = { BTCUSDT: [candle(0, 112, 101), candle(1, 105, 101)], ETHUSDT: calm(3) };
    const m = montar({ snap: dois(), velas });
    await m.run(T0 + 15 * MIN); // só a vela 0 fechou: TP1
    expect(m.enviados.filter((t) => /TP1 atingido/.test(t))).toHaveLength(1);
    velas.BTCUSDT.push(candle(2, 105, 99.5)); // abaixo da entrada: stop no breakeven
    await m.run(T0 + 45 * MIN);
    const stops = m.enviados.filter((t) => /Stop atingido/.test(t));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatch(/TP1 já tinha sido atingido/);
    await m.run(T0 + 60 * MIN);
    expect(m.enviados.filter((t) => /Stop atingido|TP1 atingido/.test(t))).toHaveLength(2);
    expect(m.rtdb.read(EPISODE_PATH).alerts_sent).toBe(2);
  });
  it('TP1 e stop na MESMA passada: os dois avisos saem, em ordem, com pausa entre eles', async () => {
    const m = montar({ snap: dois(), velas: { BTCUSDT: [candle(0, 112, 101), candle(1, 105, 99.5)], ETHUSDT: calm(2) } });
    const r = await m.run(T0 + 30 * MIN);
    expect(r.alerts).toBe(2);
    const ordem = m.enviados.map((t) => (/TP1 atingido/.test(t) ? 'tp1' : /Stop atingido/.test(t) ? 'stop' : 'outro'));
    expect(ordem).toEqual(['outro', 'tp1', 'stop']);
    expect(m.enviados[2]).toMatch(/TP1 já tinha sido atingido/);
    expect(m.sleep).toHaveBeenCalledWith(1100);
  });
  it('não pausa antes da primeira mensagem de uma passada que só manda uma', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')] }), velas: { BTCUSDT: [candle(0, 101, 94)] } });
    m.send.mockClear();
    await m.run(T0 + 15 * MIN); // "ligado" + stop = 2 mensagens, 1 pausa entre elas
    expect(m.sleep).toHaveBeenCalledTimes(1);
  });
  it('venda: o stop é a máxima', async () => {
    const m = montar({ snap: dois(), velas: { BTCUSDT: calm(2), ETHUSDT: [candle(0, 105, 99)] } });
    const r = await m.run(T0 + 15 * MIN);
    expect(r.alerts).toBe(1);
    expect(m.enviados.find((t) => /Stop atingido/.test(t))).toContain('ETH/USDT');
  });
  it('id com ponto, barra e # (proibidos em chave do RTDB) funciona no livro', async () => {
    const feio = op('op.1/x#y$z[1]', 'BTCUSDT');
    const m = montar({ snap: snapshot({ ops: [feio] }), velas: { BTCUSDT: [candle(0, 101, 94)] } });
    const r = await m.run(T0 + 15 * MIN);
    expect(r).toMatchObject({ ok: true, alerts: 1 });
    expect(m.rtdb.read(EPISODE_PATH).sent[encodeKeyPart('op.1/x#y$z[1]')].stop).toBeTruthy();
    await m.run(T0 + 30 * MIN);
    expect(m.enviados.filter((t) => /Stop atingido/.test(t))).toHaveLength(1);
  });
  it('dois ids que só diferem por pontuação têm avisos separados', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a.b', 'BTCUSDT'), op('a/b', 'ETHUSDT')] }), velas: { BTCUSDT: [candle(0, 101, 94)], ETHUSDT: [candle(0, 101, 94)] } });
    const r = await m.run(T0 + 15 * MIN);
    expect(r.alerts).toBe(2);
  });
  it('mesmo id repetido no retrato não duplica o aviso na mesma passada', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a'), op('a')] }), velas: { BTCUSDT: [candle(0, 101, 94)] } });
    const r = await m.run(T0 + 15 * MIN);
    expect(r.alerts).toBe(1);
  });
});

describe('runObservationWatch — falhas no meio do caminho', () => {
  it('envio falhou: o aviso NÃO é marcado e sai na passada seguinte', async () => {
    let falhar = true;
    const m = montar({
      snap: snapshot({ ops: [op('a')] }), velas: { BTCUSDT: [candle(0, 101, 94), candle(1, 101, 99)] },
      sendImpl: async (text) => (falhar && /Stop atingido/.test(text) ? { ok: false, reason: 'rede' } : { ok: true }),
    });
    const r1 = await m.run(T0 + 15 * MIN);
    expect(r1).toMatchObject({ ok: true, alerts: 0, send_errors: { rede: 1 } });
    expect(m.rtdb.read(EPISODE_PATH).alerts_sent).toBe(0);
    falhar = false;
    const r2 = await m.run(T0 + 30 * MIN);
    expect(r2.alerts).toBe(1);
    expect(m.enviados.filter((t) => /Stop atingido/.test(t))).toHaveLength(1);
  });
  it('"ligado" que falhou no envio é tentado de novo na passada seguinte', async () => {
    let falhar = true;
    const m = montar({ snap: snapshot({ ops: [op('a')] }), velas: { BTCUSDT: calm(3) }, sendImpl: async () => (falhar ? { ok: false, reason: 'http_429' } : { ok: true }) });
    await m.run(T0 + 15 * MIN);
    expect(m.enviados).toHaveLength(0);
    falhar = false;
    await m.run(T0 + 30 * MIN);
    expect(m.enviados).toHaveLength(1);
    expect(m.enviados[0]).toMatch(/ligado/);
  });
  it('falha de envio do "ligado" é contada por código', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')] }), velas: { BTCUSDT: calm(2) }, sendImpl: async () => ({ ok: false, reason: 'http_429' }) });
    const r = await m.run(T0 + 15 * MIN);
    expect(r).toMatchObject({ ok: true, send_errors: { http_429: 1 } });
  });
  it('falha ao gravar a marca depois de enviar: conta o erro e segue (pode repetir o aviso, nunca perdê-lo)', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')] }), velas: { BTCUSDT: [candle(0, 101, 94)] } });
    await m.run(T0 + 5 * MIN); // abre o episódio e manda o "ligado"
    m.rtdb.calls.length = 0;
    // a partir daqui toda gravação por update falha
    const rtdb2 = m.rtdb;
    const original = rtdb2.db.ref.bind(rtdb2.db);
    rtdb2.db.ref = (p) => { const r = original(p); return { ...r, update: async () => { throw Object.assign(new Error('x'), { code: 'NETWORK_ERROR' }); } }; };
    const r = await m.run(T0 + 20 * MIN);
    expect(r).toMatchObject({ ok: true, mark_errors: 1 });
    expect(m.enviados.filter((t) => /Stop atingido/.test(t))).toHaveLength(1);
  });
  it('velas de UM símbolo falharam: o outro segue sendo vigiado e o erro é contado por código', async () => {
    const m = montar({
      snap: snapshot({ ops: [op('a', 'BTCUSDT'), op('b', 'ETHUSDT')] }),
      velas: { BTCUSDT: { erro: 'http_503' }, ETHUSDT: [candle(0, 101, 94)] },
    });
    const r = await m.run(T0 + 15 * MIN);
    expect(r).toMatchObject({ ok: true, alerts: 1, candle_errors: { http_503: 1 } });
  });
  it('vela faltando no meio: não decide (poderia esconder o stop) e conta "velas_incompletas"', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')] }), velas: { BTCUSDT: [candle(0, 101, 99), candle(2, 101, 90)] } });
    const r = await m.run(T0 + 45 * MIN);
    expect(r).toMatchObject({ ok: true, alerts: 0, candle_errors: { velas_incompletas: 1 } });
  });
  it('operação inválida no retrato é contada e as outras seguem', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a', 'BTCUSDT', 'BUY', { tp1: null }), op('b', 'ETHUSDT')] }), velas: { BTCUSDT: calm(2), ETHUSDT: [candle(0, 101, 94)] } });
    const r = await m.run(T0 + 15 * MIN);
    expect(r).toMatchObject({ ok: true, alerts: 1, invalid: { operacao_invalida: 1 } });
  });
  it('símbolo estranho no retrato nunca vira pedido', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a', 'BTC/../x')] }) });
    const r = await m.run(T0 + 15 * MIN);
    expect(r.candle_errors).toMatchObject({ simbolo_invalido: 1 });
  });
  it('teto de mensagens por passada: o resto fica para a seguinte, nada se perde', async () => {
    const ops = Array.from({ length: 25 }, (_, i) => op(`id${i}`, 'BTCUSDT'));
    const m = montar({ snap: snapshot({ ops }), velas: { BTCUSDT: [candle(0, 101, 94), ...Array.from({ length: 10 }, (_, i) => candle(i + 1, 101, 99))] } });
    const r1 = await m.run(T0 + 15 * MIN, { maxMessages: 10 });
    expect(r1.alerts).toBeLessThanOrEqual(10);
    expect(r1.deferred).toBeGreaterThan(0);
    let total = r1.alerts;
    for (let i = 1; i < 6 && total < 25; i += 1) total += (await m.run(T0 + (15 + 15 * i) * MIN, { maxMessages: 10 })).alerts;
    expect(total).toBe(25);
    expect(m.enviados.filter((t) => /Stop atingido/.test(t))).toHaveLength(25);
  });
});

describe('runObservationWatch — retratos sem operação', () => {
  it('retrato SEM operações vivas (o RTDB devolve sem a chave `operations`) é "vigiando", não "sem retrato"', async () => {
    const m = montar({ snap: snapshot({ ops: [] }) });
    expect(m.rtdb.read('observation/snapshot').operations).toBeUndefined(); // a poda do RTDB de verdade
    const r = await m.run(T0 + 15 * MIN);
    expect(r).toMatchObject({ ok: true, status: 'watching', operations: 0 });
    expect(m.enviados).toHaveLength(0); // nada a vigiar: nenhum "ligado" inútil
    expect(m.getCandles).not.toHaveBeenCalled();
    const r2 = await m.run(T0 + 30 * MIN);
    expect(r2.status).toBe('watching');
  });
  it('sem operações vigiáveis mas com operações FORA do retrato: avisa uma vez', async () => {
    const m = montar({ snap: snapshot({ ops: [], dropped: 2 }) });
    await m.run(T0 + 15 * MIN);
    expect(m.enviados).toHaveLength(1);
    expect(m.enviados[0]).toMatch(/FORA do retrato/);
    await m.run(T0 + 30 * MIN);
    expect(m.enviados).toHaveLength(1);
  });
});

describe('runObservationWatch — o que vai para o log', () => {
  it('o resumo leva só números e códigos (nada de símbolo, preço, id ou texto de mensagem)', async () => {
    const m = montar({ snap: snapshot({ ops: [op('SEGREDO-ID', 'BTCUSDT')] }), velas: { BTCUSDT: [candle(0, 101, 94)] } });
    const r = await m.run(T0 + 15 * MIN);
    const texto = JSON.stringify(r) + describeWatchResult(r);
    expect(texto).not.toMatch(/SEGREDO-ID|BTC|95|Stop atingido|\$/);
    expect(describeWatchResult(r)).toMatch(/^\[scan\] vigia:/);
  });
  it('describeWatchResult cobre desligado, falha e sucesso', () => {
    expect(describeWatchResult({ ok: false, skipped: 'sem_url' })).toMatch(/desligado/);
    expect(describeWatchResult({ ok: false, erro: 'regras_abertas' })).toMatch(/regras_abertas/);
    expect(describeWatchResult({ ok: true, status: 'watching', operations: 2, alerts: 1, deferred: 0, send_errors: {}, candle_errors: { rede: 1 }, invalid: {}, mark_errors: 0 })).toMatch(/vigiando.*ops=2.*avisos=1/);
    expect(describeWatchResult({ ok: true, status: 'stale' })).toMatch(/retrato velho/);
    expect(describeWatchResult({ ok: true, status: 'no_snapshot' })).toMatch(/sem retrato/);
  });
  it('código estranho nunca vai para o log', () => {
    const linha = describeWatchResult({ ok: false, erro: 'https://x.firebaseio.com/?token=SEGREDO' });
    expect(linha).not.toMatch(/SEGREDO|firebaseio/);
  });
});

describe('closeObservationEpisode — o banco voltou', () => {
  const aberto = (extra = {}) => ({ started_at: iso(T0), snapshot_at: iso(T0 - 15 * MIN), status: 'watching', alerts_sent: 2, start_notice_sent: true, announced: true, ...extra });
  const fechar = (m, nowMs = T0 + 26 * 60 * MIN) => closeObservationEpisode({ env: ENV, store: m.store, send: m.send, nowMs });

  it('sem episódio: 1 leitura, nenhuma gravação, nenhuma mensagem', async () => {
    const m = montar({});
    expect(await fechar(m)).toEqual({ ok: true, closed: false });
    expect(m.rtdb.calls.filter((c) => c.op === 'get')).toHaveLength(1);
    expect(m.rtdb.writes()).toEqual([]);
    expect(m.send).not.toHaveBeenCalled();
  });
  it('sem a URL: não lê nada', async () => {
    const m = montar({ episode: aberto() });
    const r = await closeObservationEpisode({ env: { ...ENV, OBSERVATION_DATABASE_URL: '' }, store: m.store, send: m.send, nowMs: T0 });
    expect(r).toEqual({ ok: false, skipped: 'sem_url' });
    expect(m.rtdb.calls).toEqual([]);
  });
  it('episódio em que o vigia falou: manda o aviso de volta com a contagem e marca ended_at', async () => {
    const m = montar({ episode: aberto() });
    const r = await fechar(m);
    expect(r).toEqual({ ok: true, closed: true, notified: true });
    expect(m.enviados).toHaveLength(1);
    expect(m.enviados[0]).toMatch(/2 avisos/);
    expect(m.enviados[0]).toContain('Recuperação após pausa do banco');
    expect(m.rtdb.read(EPISODE_PATH).ended_at).toBe(iso(T0 + 26 * 60 * MIN));
  });
  it('episódio em que o vigia ficou calado (nada anunciado): fecha em silêncio', async () => {
    const m = montar({ episode: aberto({ announced: false, alerts_sent: 0 }) });
    expect(await fechar(m)).toEqual({ ok: true, closed: true, notified: false });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.rtdb.read(EPISODE_PATH).ended_at).toBeTruthy();
  });
  it('aviso de volta falhou no envio: NÃO marca o fim (tenta de novo no próximo scan)', async () => {
    let falhar = true;
    const m = montar({ episode: aberto(), sendImpl: async () => (falhar ? { ok: false, reason: 'rede' } : { ok: true }) });
    expect(await fechar(m)).toMatchObject({ ok: false, erro: 'envio_rede' });
    expect(m.rtdb.read(EPISODE_PATH).ended_at).toBeUndefined();
    falhar = false;
    expect(await fechar(m)).toMatchObject({ ok: true, closed: true, notified: true });
    expect(m.enviados).toHaveLength(1);
  });
  it('episódio já encerrado: nada a fazer, nenhuma mensagem repetida', async () => {
    const m = montar({ episode: aberto({ ended_at: iso(T0 + MIN) }) });
    expect(await fechar(m)).toEqual({ ok: true, closed: false });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.rtdb.writes()).toEqual([]);
  });
  it('dois fechamentos seguidos: só o primeiro fala', async () => {
    const m = montar({ episode: aberto() });
    await fechar(m);
    await fechar(m);
    expect(m.enviados).toHaveLength(1);
  });
  it.each([['texto', 'lixo'], ['número', 5], ['sem started_at', { status: 'watching' }]])('registro estranho (%s) é ignorado, sem mensagem', async (_n, lixo) => {
    const m = montar({});
    m.rtdb.seed('observation/episode', lixo);
    const r = await fechar(m);
    expect(r.ok).toBe(true);
    expect(r.closed).toBe(false);
    expect(m.send).not.toHaveBeenCalled();
  });
  it('não consegue ler o RTDB: devolve o código, sem mensagem', async () => {
    const m = montar({ rtdbFail: { get: () => Object.assign(new Error('x'), { code: 'NETWORK_ERROR' }) } });
    expect(await fechar(m)).toEqual({ ok: false, erro: 'NETWORK_ERROR' });
    expect(m.send).not.toHaveBeenCalled();
  });
  it('queda sem vigia (retrato velho) também recebe o aviso de volta, dizendo que ficou sem vigia', async () => {
    const m = montar({ episode: aberto({ status: 'stale', alerts_sent: 0 }) });
    await fechar(m);
    expect(m.enviados[0]).toMatch(/sem vigia/i);
  });
  it('depois de encerrado, uma NOVA queda abre outro episódio com livro limpo', async () => {
    const m = montar({ snap: snapshot({ ops: [op('a')], at: T0 + 26 * 60 * MIN }), episode: aberto({ sent: { [encodeKeyPart('a')]: { stop: { at: 'x' } } } }), velas: { BTCUSDT: [candle(104, 101, 99)] } });
    await fechar(m);
    const r = await m.run(T0 + 27 * 60 * MIN);
    expect(r.status).toBe('watching');
    expect(m.rtdb.read(EPISODE_PATH).sent).toBeUndefined(); // o livro antigo não vaza para o episódio novo
    expect(m.rtdb.read(EPISODE_PATH).ended_at).toBeUndefined();
  });
  it('describeCloseResult: só contagem e código', () => {
    expect(describeCloseResult({ ok: true, closed: false })).toBe(null);
    expect(describeCloseResult({ ok: true, closed: true, notified: true })).toMatch(/\[scan\] vigia: episódio encerrado/);
    expect(describeCloseResult({ ok: false, erro: 'envio_rede' })).toMatch(/envio_rede/);
    expect(describeCloseResult({ ok: false, skipped: 'sem_url' })).toBe(null);
    expect(describeCloseResult({ ok: false, erro: 'https://x?token=SEGREDO' })).not.toMatch(/SEGREDO/);
  });
});
