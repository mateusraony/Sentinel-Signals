// Modo de observação sem banco, fase O2a (docs/known-risks.md item 299): o núcleo PURO do vigia de stop/alvo.
// Decide, a partir do retrato do estado (O1) e das velas de 15 min já fechadas, quais avisos de stop/alvo estão pendentes.
// Sem rede, sem banco, sem relógio global: tudo entra por parâmetro.
import { describe, it, expect } from 'vitest';
import {
  CANDLE_MS, MAX_SNAPSHOT_AGE_AT_OUTAGE_MS, encodeKeyPart, ledgerKey, evaluateOperation, checkCandleCoverage, isUsableSnapshot, decideEpisode,
  pendingEvents,
} from './observationWatch.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-12T10:00:00.000Z'); // abertura de uma vela de 15 min
const iso = (ms) => new Date(ms).toISOString();

// Vela de 15 min que abre em T0 + i*15min.
const candle = (i, { high, low, open = 100, close = 100 }) => ({ openTime: T0 + i * CANDLE_MS, open, high, low, close });
// "agora" = fim da vela i (a vela i já está fechada)
const fimDaVela = (i) => T0 + (i + 1) * CANDLE_MS;

const buy = (extra = {}) => ({
  id: 'op1', symbol: 'BTCUSDT', side: 'BUY', status: 'SIGNAL_CONFIRMED', tp1_hit: false,
  entry_price: 100, current_stop: 95, initial_stop: 95, tp1: 110, tp2: 120,
  entry_candle_time_15m: iso(T0 - 30 * MIN), candle_close_time: iso(T0 - 30 * MIN),
  ...extra,
});
const sell = (extra = {}) => ({
  id: 'op2', symbol: 'ETHUSDT', side: 'SELL', status: 'SIGNAL_CONFIRMED', tp1_hit: false,
  entry_price: 100, current_stop: 105, initial_stop: 105, tp1: 90, tp2: 80,
  entry_candle_time_15m: iso(T0 - 30 * MIN), candle_close_time: iso(T0 - 30 * MIN),
  ...extra,
});

const snapshotAtMs = T0; // o retrato foi tirado na abertura da 1ª vela avaliada (a vela i=0 é inteira posterior)

const avaliar = (op, candles, { agora, snap = snapshotAtMs } = {}) =>
  evaluateOperation({ op, candles, snapshotAtMs: snap, nowMs: agora ?? fimDaVela(candles.length - 1) });
const nomes = (r) => r.events.map((e) => e.event);

describe('encodeKeyPart — chave do RTDB, injetiva, sem os caracteres proibidos', () => {
  it('mantém letras, números, _ e -', () => {
    expect(encodeKeyPart('op_ABC-123')).toBe('op_ABC-123');
  });
  it('escapa . $ # [ ] / e ~ (caracteres que o RTDB não aceita em chave, mais o próprio escape)', () => {
    for (const ch of ['.', '$', '#', '[', ']', '/', '~', ':', ' ']) {
      const k = encodeKeyPart(`a${ch}b`);
      expect(k).not.toMatch(/[.$#[\]/]/);
      expect(k.startsWith('a~')).toBe(true);
    }
  });
  it('é injetiva: ids diferentes nunca viram a mesma chave (inclusive o que já parece uma chave escapada)', () => {
    const ids = ['a.b', 'a~002eb', 'a_b', 'a/b', 'a#b', 'a~b', 'a~', 'A.B', 'a.b.', '', 'x'];
    const chaves = ids.map((i) => encodeKeyPart(i));
    const validas = chaves.filter((k) => k !== null);
    expect(new Set(validas).size).toBe(validas.length);
  });
  it('largura fixa: um caractere de código curto seguido de dígitos não colide com um caractere de código longo', () => {
    // '\u0014' + '0' e '\u0140' viram o mesmo texto se o escape variar de tamanho (achado pela mutação padStart(2))
    expect(encodeKeyPart('\u00140')).not.toBe(encodeKeyPart('\u0140'));
    expect(encodeKeyPart('é')).not.toBe(encodeKeyPart('\u00e9'.normalize('NFD')));
  });
  it('id vazio, não-texto ou enorme não vira chave', () => {
    expect(encodeKeyPart('')).toBeNull();
    expect(encodeKeyPart(null)).toBeNull();
    expect(encodeKeyPart(undefined)).toBeNull();
    expect(encodeKeyPart(123)).toBeNull();
    expect(encodeKeyPart('x'.repeat(500))).toBeNull();
  });
  it('ledgerKey junta operação e evento com um separador que não pode sair da codificação', () => {
    expect(ledgerKey('op.1', 'stop')).toBe(`${encodeKeyPart('op.1')}/stop`);
    expect(ledgerKey('', 'stop')).toBeNull();
    expect(ledgerKey('op1', 'qualquer')).toBeNull(); // só os 4 eventos conhecidos
  });
});

describe('evaluateOperation — compra (BUY), antes do TP1', () => {
  it('nenhum toque: nenhum evento e a operação segue viva', () => {
    const r = avaliar(buy(), [candle(0, { high: 108, low: 97 })]);
    expect(r).toMatchObject({ ok: true, events: [] });
    expect(r.final).toMatchObject({ terminal: false, tp1Hit: false, stop: 95 });
  });
  it('mínima igual ao stop JÁ conta como toque (<=), como no motor', () => {
    const r = avaliar(buy(), [candle(0, { high: 101, low: 95 })]);
    expect(nomes(r)).toEqual(['stop']);
  });
  it('mínima acima do stop por um centavo NÃO conta', () => {
    const r = avaliar(buy(), [candle(0, { high: 101, low: 95.01 })]);
    expect(nomes(r)).toEqual([]);
  });
  it('máxima igual ao TP1 conta (>=) e avisa o TP1 com o stop indo para a entrada', () => {
    const r = avaliar(buy(), [candle(0, { high: 110, low: 99 })]);
    expect(nomes(r)).toEqual(['tp1']);
    expect(r.final).toMatchObject({ tp1Hit: true, stop: 100, terminal: false });
    expect(r.events[0]).toMatchObject({ level: 110, ambiguous: false });
  });
  it('stop e TP1 na MESMA vela: o stop vence e a ambiguidade é marcada (resolveCandleExit)', () => {
    const r = avaliar(buy(), [candle(0, { high: 111, low: 94 })]);
    expect(nomes(r)).toEqual(['stop']);
    expect(r.events[0]).toMatchObject({ ambiguous: true, level: 95 });
    expect(r.final.terminal).toBe(true);
  });
  it('depois do stop não avalia mais nada (estado terminal nunca recebe transição)', () => {
    const r = avaliar(buy(), [candle(0, { high: 101, low: 90 }), candle(1, { high: 130, low: 99 })]);
    expect(nomes(r)).toEqual(['stop']);
  });
});

describe('evaluateOperation — venda (SELL) espelha a compra', () => {
  it('máxima >= stop é toque; máxima abaixo não é', () => {
    expect(nomes(avaliar(sell(), [candle(0, { high: 105, low: 99 })]))).toEqual(['stop']);
    expect(nomes(avaliar(sell(), [candle(0, { high: 104.99, low: 99 })]))).toEqual([]);
  });
  it('mínima <= TP1 é alvo, e o stop vai para a entrada', () => {
    const r = avaliar(sell(), [candle(0, { high: 101, low: 90 })]);
    expect(nomes(r)).toEqual(['tp1']);
    expect(r.final).toMatchObject({ tp1Hit: true, stop: 100 });
  });
  it('stop e TP1 na mesma vela: stop vence', () => {
    const r = avaliar(sell(), [candle(0, { high: 106, low: 89 })]);
    expect(nomes(r)).toEqual(['stop']);
    expect(r.events[0].ambiguous).toBe(true);
  });
});

describe('evaluateOperation — depois do TP1 (runner)', () => {
  it('no mesmo candle do TP1 o novo stop NÃO vale (só protege a partir da vela seguinte, P0-d)', () => {
    const r = avaliar(buy(), [candle(0, { high: 112, low: 99 })]); // tocou TP1; a mínima 99 < entrada 100, mas não conta
    expect(nomes(r)).toEqual(['tp1']);
    expect(r.final.terminal).toBe(false);
  });
  it('vela seguinte: mínima <= entrada fecha pelo stop no breakeven', () => {
    const r = avaliar(buy(), [candle(0, { high: 112, low: 101 }), candle(1, { high: 105, low: 100 })]);
    expect(nomes(r)).toEqual(['tp1', 'stop']);
    expect(r.events[1]).toMatchObject({ level: 100 });
    expect(r.final.terminal).toBe(true);
  });
  it('vela seguinte: máxima >= TP2 fecha pelo alvo final', () => {
    const r = avaliar(buy(), [candle(0, { high: 112, low: 101 }), candle(1, { high: 121, low: 105 })]);
    expect(nomes(r)).toEqual(['tp1', 'tp2']);
    expect(r.events[1]).toMatchObject({ level: 120, ambiguous: false });
  });
  it('stop e TP2 na mesma vela do runner: stop vence, com ambiguidade', () => {
    const r = avaliar(buy(), [candle(0, { high: 112, low: 101 }), candle(1, { high: 125, low: 99 })]);
    expect(nomes(r)).toEqual(['tp1', 'stop']);
    expect(r.events[1].ambiguous).toBe(true);
  });
  it('tp2_cap_disabled: o TP2 não encerra a operação', () => {
    const r = avaliar(buy({ tp2_cap_disabled: true }), [candle(0, { high: 112, low: 101 }), candle(1, { high: 200, low: 105 })]);
    expect(nomes(r)).toEqual(['tp1']);
    expect(r.final.terminal).toBe(false);
  });
  it('operação que JÁ estava no runner no retrato começa com o stop gravado (que pode ser melhor que a entrada)', () => {
    const op = buy({ status: 'RUNNER_ACTIVE', tp1_hit: true, current_stop: 104 });
    expect(nomes(avaliar(op, [candle(0, { high: 108, low: 104.5 })]))).toEqual([]);
    expect(nomes(avaliar(op, [candle(0, { high: 108, low: 104 })]))).toEqual(['stop']);
  });
  it('status RUNNER_ACTIVE vale como "já passou do TP1" mesmo se o campo tp1_hit vier ausente', () => {
    const op = buy({ status: 'RUNNER_ACTIVE', tp1_hit: undefined, current_stop: 100 });
    expect(nomes(avaliar(op, [candle(0, { high: 111, low: 105 })]))).toEqual([]); // 111 >= TP1, mas já passou: não avisa TP1 de novo
    expect(nomes(avaliar(op, [candle(0, { high: 125, low: 105 })]))).toEqual(['tp2']);
  });
  it('um stop já melhor que a entrada NÃO regride ao subir para o breakeven (monotônico, como o clampMonotonicStop)', () => {
    const op = buy({ current_stop: 103 }); // trailing pré-TP1 já levou o stop acima da entrada
    const r = avaliar(op, [candle(0, { high: 112, low: 104 })]);
    expect(nomes(r)).toEqual(['tp1']);
    expect(r.final.stop).toBe(103);
  });
  it('venda no runner: stop gravado acima do breakeven nunca desce', () => {
    const op = sell({ status: 'RUNNER_ACTIVE', tp1_hit: true, current_stop: 97 });
    expect(nomes(avaliar(op, [candle(0, { high: 96.9, low: 92 })]))).toEqual([]);
    expect(nomes(avaliar(op, [candle(0, { high: 97, low: 92 })]))).toEqual(['stop']);
  });
});

describe('evaluateOperation — TP1 que fecha tudo (partial_percent 100)', () => {
  it('vira o evento tp1_full e termina (sem runner)', () => {
    const r = avaliar(buy({ partial_percent: 100 }), [candle(0, { high: 112, low: 101 }), candle(1, { high: 130, low: 90 })]);
    expect(nomes(r)).toEqual(['tp1_full']);
    expect(r.final.terminal).toBe(true);
  });
  it('partial_percent 50 (o padrão) segue com runner', () => {
    expect(nomes(avaliar(buy({ partial_percent: 50 }), [candle(0, { high: 112, low: 101 })]))).toEqual(['tp1']);
  });
  it('stop e TP1 na mesma vela, mesmo com partial_percent 100: stop vence', () => {
    expect(nomes(avaliar(buy({ partial_percent: 100 }), [candle(0, { high: 112, low: 94 })]))).toEqual(['stop']);
  });
});

describe('evaluateOperation — quais velas valem (guarda temporal e janela)', () => {
  it('vela que ABRE antes da entrada não vale (P0-g): o toque pré-entrada é ignorado', () => {
    const op = buy({ entry_candle_time_15m: iso(T0 + 15 * MIN) }); // a entrada existe a partir da abertura da vela 1
    const r = avaliar(op, [candle(0, { high: 101, low: 90 })], { agora: fimDaVela(1) });
    expect(nomes(r)).toEqual([]);
  });
  it('vela que abre EXATAMENTE na entrada vale', () => {
    const op = buy({ entry_candle_time_15m: iso(T0) });
    expect(nomes(avaliar(op, [candle(0, { high: 101, low: 90 })]))).toEqual(['stop']);
  });
  it('a referência da entrada vem do motor: 15m, senão 5m, senão 4h, senão candle_close_time', () => {
    const base = { entry_candle_time_15m: undefined, entry_candle_time_5m: undefined, entry_candle_time_4h: undefined, candle_close_time: undefined };
    const ref = (campos) => nomes(avaliar(buy({ ...base, ...campos }), [candle(0, { high: 101, low: 90 })]));
    expect(ref({ entry_candle_time_5m: iso(T0 + 15 * MIN) })).toEqual([]);
    expect(ref({ entry_candle_time_4h: iso(T0 + 15 * MIN) })).toEqual([]);
    expect(ref({ candle_close_time: iso(T0 + 15 * MIN) })).toEqual([]);
    expect(ref({})).toEqual(['stop']); // operação antiga sem nenhuma referência: avalia (fallback explícito do motor)
  });
  it('referência de entrada ilegível não silencia o vigia (fail-open): avalia como operação antiga', () => {
    const r = avaliar(buy({ entry_candle_time_15m: 'lixo', candle_close_time: 'lixo' }), [candle(0, { high: 101, low: 90 })]);
    expect(nomes(r)).toEqual(['stop']);
  });
  it('vela que terminou ANTES do retrato não vale (o motor já a viu); a que atravessa o retrato vale', () => {
    const snap = T0 + 20 * MIN; // retrato tirado 5 min depois da abertura da vela 1
    const antes = candle(0, { high: 101, low: 90 }); // fecha às T0+15 < snap: já vista
    const atravessa = candle(1, { high: 101, low: 90 }); // abre T0+15, fecha T0+30 > snap: vale
    expect(nomes(avaliar(buy(), [antes], { snap, agora: fimDaVela(1) }))).toEqual([]);
    expect(nomes(avaliar(buy(), [atravessa], { snap, agora: fimDaVela(1) }))).toEqual(['stop']);
  });
  it('vela que fecha EXATAMENTE no instante do retrato não vale (já tinha terminado)', () => {
    const snap = T0 + 15 * MIN;
    expect(nomes(avaliar(buy(), [candle(0, { high: 101, low: 90 })], { snap, agora: fimDaVela(1) }))).toEqual([]);
  });
  it('vela ainda ABERTA agora não vale (só velas fechadas decidem)', () => {
    const r = avaliar(buy(), [candle(0, { high: 101, low: 90 })], { agora: T0 + 14 * MIN });
    expect(nomes(r)).toEqual([]);
  });
  it('vela que fecha exatamente agora vale', () => {
    expect(nomes(avaliar(buy(), [candle(0, { high: 101, low: 90 })], { agora: T0 + CANDLE_MS }))).toEqual(['stop']);
  });
  it('velas fora de ordem são ordenadas, não ignoradas', () => {
    const r = avaliar(buy(), [candle(1, { high: 121, low: 105 }), candle(0, { high: 112, low: 101 })]);
    expect(nomes(r)).toEqual(['tp1', 'tp2']);
  });
});

describe('evaluateOperation — entrada inválida falha para o lado visível, nunca em silêncio', () => {
  const vela = [candle(0, { high: 101, low: 90 })];
  it.each([
    ['sem operação', undefined, 'operacao_invalida'],
    ['sem id', buy({ id: '' }), 'operacao_invalida'],
    ['lado desconhecido', buy({ side: 'LONG' }), 'operacao_invalida'],
    ['entrada não numérica', buy({ entry_price: 'abc' }), 'operacao_invalida'],
    ['stop NaN', buy({ current_stop: NaN }), 'operacao_invalida'],
    ['TP1 ausente', buy({ tp1: null }), 'operacao_invalida'],
    ['stop zero', buy({ current_stop: 0 }), 'operacao_invalida'],
    ['TP2 ausente sem cap desligado', buy({ tp2: null }), 'operacao_invalida'],
  ])('%s', (_nome, op, motivo) => {
    expect(evaluateOperation({ op, candles: vela, snapshotAtMs, nowMs: fimDaVela(0) })).toEqual({ ok: false, reason: motivo });
  });
  it('TP2 ausente é aceito quando o TP2 está desligado', () => {
    expect(evaluateOperation({ op: buy({ tp2: null, tp2_cap_disabled: true }), candles: vela, snapshotAtMs, nowMs: fimDaVela(0) }).ok).toBe(true);
  });
  it('vela com número inválido derruba a avaliação (pular a vela poderia esconder um stop)', () => {
    const r = avaliar(buy(), [{ openTime: T0, high: NaN, low: 90 }]);
    expect(r).toEqual({ ok: false, reason: 'vela_invalida' });
  });
  it('relógio ou retrato inválido', () => {
    expect(evaluateOperation({ op: buy(), candles: vela, snapshotAtMs: NaN, nowMs: fimDaVela(0) })).toEqual({ ok: false, reason: 'relogio_invalido' });
    expect(evaluateOperation({ op: buy(), candles: vela, snapshotAtMs, nowMs: 'x' })).toEqual({ ok: false, reason: 'relogio_invalido' });
  });
  it('candles que não é lista', () => {
    expect(evaluateOperation({ op: buy(), candles: null, snapshotAtMs, nowMs: fimDaVela(0) })).toEqual({ ok: false, reason: 'velas_invalidas' });
  });
  it('não altera a operação nem as velas recebidas', () => {
    const op = buy();
    const velas = [candle(0, { high: 112, low: 101 })];
    const antesOp = JSON.stringify(op);
    const antesVelas = JSON.stringify(velas);
    avaliar(op, velas);
    expect(JSON.stringify(op)).toBe(antesOp);
    expect(JSON.stringify(velas)).toBe(antesVelas);
  });
});

describe('checkCandleCoverage — vela faltando poderia esconder um toque', () => {
  const lista = (...is) => is.map((i) => candle(i, { high: 101, low: 99 }));
  it('sequência completa até agora: ok', () => {
    expect(checkCandleCoverage({ candles: lista(0, 1, 2), firstOpenMs: T0, nowMs: fimDaVela(2) })).toEqual({ ok: true, missing: 0 });
  });
  it('um buraco no meio é contado', () => {
    expect(checkCandleCoverage({ candles: lista(0, 2), firstOpenMs: T0, nowMs: fimDaVela(2) })).toEqual({ ok: false, missing: 1 });
  });
  it('falta a última vela fechada', () => {
    expect(checkCandleCoverage({ candles: lista(0, 1), firstOpenMs: T0, nowMs: fimDaVela(2) })).toEqual({ ok: false, missing: 1 });
  });
  it('falta a primeira', () => {
    expect(checkCandleCoverage({ candles: lista(1, 2), firstOpenMs: T0, nowMs: fimDaVela(2) })).toEqual({ ok: false, missing: 1 });
  });
  it('lista vazia com velas esperadas: tudo faltando', () => {
    expect(checkCandleCoverage({ candles: [], firstOpenMs: T0, nowMs: fimDaVela(1) })).toEqual({ ok: false, missing: 2 });
  });
  it('nenhuma vela esperada ainda (a primeira não fechou): ok com lista vazia', () => {
    expect(checkCandleCoverage({ candles: [], firstOpenMs: T0, nowMs: T0 + 5 * MIN })).toEqual({ ok: true, missing: 0 });
  });
  it('vela ainda aberta não é esperada nem atrapalha', () => {
    expect(checkCandleCoverage({ candles: lista(0, 1), firstOpenMs: T0, nowMs: fimDaVela(0) + 5 * MIN })).toEqual({ ok: true, missing: 0 });
  });
  it('entrada inválida falha para o lado seguro', () => {
    expect(checkCandleCoverage({ candles: null, firstOpenMs: T0, nowMs: fimDaVela(0) }).ok).toBe(false);
    expect(checkCandleCoverage({ candles: [], firstOpenMs: NaN, nowMs: fimDaVela(0) }).ok).toBe(false);
  });
});

describe('pendingEvents — o livro de avisos evita repetir', () => {
  const eventos = [{ event: 'tp1', level: 110 }, { event: 'stop', level: 100 }];
  it('sem livro: tudo pendente, na ordem', () => {
    expect(pendingEvents({ opId: 'op1', events: eventos, sent: {} }).map((e) => e.event)).toEqual(['tp1', 'stop']);
  });
  it('o que já foi enviado sai da lista; o resto fica', () => {
    const sent = { [encodeKeyPart('op1')]: { tp1: { at: 'x' } } };
    expect(pendingEvents({ opId: 'op1', events: eventos, sent }).map((e) => e.event)).toEqual(['stop']);
  });
  it('o livro de OUTRA operação não interfere', () => {
    const sent = { [encodeKeyPart('op2')]: { tp1: { at: 'x' }, stop: { at: 'x' } } };
    expect(pendingEvents({ opId: 'op1', events: eventos, sent })).toHaveLength(2);
  });
  it('o aviso de uma operação com pontuação no id é reconhecido pela chave CODIFICADA (a mesma que o livro grava)', () => {
    const sent = { [encodeKeyPart('op.1/x')]: { stop: { at: 'x' } } };
    expect(pendingEvents({ opId: 'op.1/x', events: [{ event: 'stop' }, { event: 'tp1' }], sent }).map((e) => e.event)).toEqual(['tp1']);
  });
  it('ids que só diferem por pontuação não se confundem', () => {
    const sent = { [encodeKeyPart('a.b')]: { stop: { at: 'x' } } };
    expect(pendingEvents({ opId: 'a/b', events: [{ event: 'stop' }], sent })).toHaveLength(1);
  });
  it('livro ausente ou com formato estranho é tratado como vazio, nunca lança', () => {
    expect(pendingEvents({ opId: 'op1', events: eventos, sent: null })).toHaveLength(2);
    expect(pendingEvents({ opId: 'op1', events: eventos, sent: 'x' })).toHaveLength(2);
    expect(pendingEvents({ opId: 'op1', events: eventos, sent: { [encodeKeyPart('op1')]: 'x' } })).toHaveLength(2);
  });
  it('id inválido: nada pendente (não dá para marcar o aviso depois, então não envia)', () => {
    expect(pendingEvents({ opId: '', events: eventos, sent: {} })).toEqual([]);
  });
});

describe('isUsableSnapshot', () => {
  const ok = { version: 1, snapshot_at: iso(T0), operations: [], assets: [], counts: { operations: 0, assets: 0 }, dropped_operations: 0 };
  it('aceita o retrato da versão 1', () => {
    expect(isUsableSnapshot(ok)).toBe(true);
  });
  it.each([
    ['null', null], ['texto', 'x'], ['versão desconhecida', { ...ok, version: 2 }], ['sem versão', { ...ok, version: undefined }],
    ['sem snapshot_at', { ...ok, snapshot_at: undefined }], ['snapshot_at ilegível', { ...ok, snapshot_at: 'ontem' }],
    ['operations não é lista', { ...ok, operations: {} }],
  ])('recusa: %s', (_n, s) => {
    expect(isUsableSnapshot(s)).toBe(false);
  });
});

describe('decideEpisode — a regra das 2 h vale para a idade do retrato NO INÍCIO da queda', () => {
  const snap = (extra = {}) => ({ version: 1, snapshot_at: iso(T0), operations: [buy()], assets: [], dropped_operations: 0, ...extra });
  const agora = T0 + 30 * MIN;

  it('1º passo da queda, retrato de 30 min: abre o episódio vigiando', () => {
    const d = decideEpisode({ episode: null, snapshot: snap(), nowMs: agora });
    expect(d.kind).toBe('start');
    expect(d.episode).toMatchObject({ status: 'watching', snapshot_at: iso(T0), started_at: iso(agora), alerts_sent: 0 });
  });
  it('retrato de exatamente 2 h no início: ainda vigia (o limite é "mais de 2 h")', () => {
    const d = decideEpisode({ episode: null, snapshot: snap(), nowMs: T0 + MAX_SNAPSHOT_AGE_AT_OUTAGE_MS });
    expect(d.episode.status).toBe('watching');
  });
  it('retrato com 2 h e 1 ms no início: velho demais, não vigia', () => {
    const d = decideEpisode({ episode: null, snapshot: snap(), nowMs: T0 + MAX_SNAPSHOT_AGE_AT_OUTAGE_MS + 1 });
    expect(d.episode.status).toBe('stale');
  });
  it('passos seguintes da MESMA queda: a idade do retrato cresce (dias) e o vigia continua', () => {
    const inicio = decideEpisode({ episode: null, snapshot: snap(), nowMs: agora });
    const doisDiasDepois = decideEpisode({ episode: inicio.episode, snapshot: snap(), nowMs: agora + 48 * 60 * MIN });
    expect(doisDiasDepois.kind).toBe('continue');
    expect(doisDiasDepois.episode.status).toBe('watching');
    expect(doisDiasDepois.episode.started_at).toBe(iso(agora)); // o início não anda
  });
  it('episódio velho demais continua velho demais (não "se cura" sozinho)', () => {
    const inicio = decideEpisode({ episode: null, snapshot: snap(), nowMs: T0 + 5 * 60 * MIN });
    const depois = decideEpisode({ episode: inicio.episode, snapshot: snap(), nowMs: T0 + 6 * 60 * MIN });
    expect(depois.kind).toBe('continue');
    expect(depois.episode.status).toBe('stale');
  });
  it('episódio encerrado (ended_at) não é reaproveitado: nova queda abre outro', () => {
    const encerrado = { started_at: iso(T0), snapshot_at: iso(T0), status: 'watching', alerts_sent: 2, ended_at: iso(T0 + 60 * MIN) };
    const d = decideEpisode({ episode: encerrado, snapshot: snap(), nowMs: T0 + 90 * MIN });
    expect(d.kind).toBe('start');
    expect(d.episode.alerts_sent).toBe(0);
    expect(d.episode.ended_at).toBeUndefined();
  });
  it('retrato novo (outro snapshot_at) abre episódio novo', () => {
    const antigo = decideEpisode({ episode: null, snapshot: snap(), nowMs: agora }).episode;
    const d = decideEpisode({ episode: antigo, snapshot: snap({ snapshot_at: iso(T0 + 45 * MIN) }), nowMs: T0 + 60 * MIN });
    expect(d.kind).toBe('start');
  });
  it('sem retrato utilizável: episódio "no_snapshot", uma vez só', () => {
    const d = decideEpisode({ episode: null, snapshot: null, nowMs: agora });
    expect(d).toMatchObject({ kind: 'start', episode: { status: 'no_snapshot', snapshot_at: null } });
    const de2 = decideEpisode({ episode: d.episode, snapshot: null, nowMs: agora + 15 * MIN });
    expect(de2.kind).toBe('continue');
    expect(de2.episode.status).toBe('no_snapshot');
  });
  it('retrato de versão desconhecida conta como sem retrato', () => {
    expect(decideEpisode({ episode: null, snapshot: snap({ version: 9 }), nowMs: agora }).episode.status).toBe('no_snapshot');
  });
  it('episódio gravado com lixo é descartado e reaberto, nunca lança', () => {
    const completo = { started_at: iso(T0), snapshot_at: iso(T0), status: 'watching', alerts_sent: 1 };
    for (const lixo of ['x', 5, [], { ...completo, status: 'inventado' }, { ...completo, started_at: 'ontem' }, { ...completo, snapshot_at: 'ontem' }]) {
      const d = decideEpisode({ episode: lixo, snapshot: snap(), nowMs: agora });
      expect(d.kind).toBe('start');
      expect(d.episode.status).toBe('watching');
    }
  });
  it('relógio inválido: não decide', () => {
    expect(decideEpisode({ episode: null, snapshot: snap(), nowMs: NaN })).toEqual({ kind: 'invalid', reason: 'relogio_invalido' });
  });
  it('não altera o episódio recebido', () => {
    const ep = decideEpisode({ episode: null, snapshot: snap(), nowMs: agora }).episode;
    const antes = JSON.stringify(ep);
    decideEpisode({ episode: ep, snapshot: snap(), nowMs: agora + MIN });
    expect(JSON.stringify(ep)).toBe(antes);
  });
});
