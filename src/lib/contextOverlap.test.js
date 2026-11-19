import { describe, it, expect } from 'vitest';
import { toMs, opWindow, eventsDuring, overlapStats, HIGH_IMPORTANCE_KINDS } from './contextOverlap';

const D = (s) => Date.parse(s);
const NOW = D('2026-11-19T12:00:00Z');

const closedOp = (over = {}) => ({
  status: 'TP2_HIT',
  entry_candle_time_15m: '2026-11-09T20:00:00Z',
  closed_at: '2026-11-11T08:00:00Z',
  ...over,
});
const ev = (kind, iso) => ({ kind, startsAtMs: D(iso) });

describe('toMs', () => {
  it('aceita ISO, número e Date; o resto vira null', () => {
    expect(toMs('2026-11-10T13:30:00Z')).toBe(D('2026-11-10T13:30:00Z'));
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toMs(new Date('2026-11-10T13:30:00Z'))).toBe(D('2026-11-10T13:30:00Z'));
    for (const bad of [null, undefined, '', 'lixo', NaN, 0, {}]) expect(toMs(bad)).toBeNull();
  });
});

describe('opWindow', () => {
  it('operação fechada: do início da posição até o fecho', () => {
    expect(opWindow(closedOp(), NOW)).toEqual({ startMs: D('2026-11-09T20:00:00Z'), endMs: D('2026-11-11T08:00:00Z') });
  });

  it('prefere o horário real do fecho (closed_at_real_time) ao da detecção', () => {
    const w = opWindow(closedOp({ closed_at_real_time: '2026-11-10T16:00:00Z' }), NOW);
    expect(w.endMs).toBe(D('2026-11-10T16:00:00Z'));
  });

  it('início: usa a referência de entrada e cai em created_date só sem ela', () => {
    expect(opWindow({ status: 'STOP_HIT', created_date: '2026-11-01T00:00:00Z', closed_at: '2026-11-02T00:00:00Z' }, NOW).startMs).toBe(D('2026-11-01T00:00:00Z'));
    expect(opWindow(closedOp({ entry_candle_time_15m: null, entry_candle_time_5m: '2026-11-09T21:00:00Z' }), NOW).startMs).toBe(D('2026-11-09T21:00:00Z'));
  });

  it('operação ativa termina no "agora" recebido por parâmetro', () => {
    const w = opWindow({ status: 'RUNNER_ACTIVE', entry_candle_time_15m: '2026-11-18T00:00:00Z' }, NOW);
    expect(w).toEqual({ startMs: D('2026-11-18T00:00:00Z'), endMs: NOW });
  });

  it('sem início legível → null (não inventa janela)', () => {
    expect(opWindow({ status: 'TP2_HIT', closed_at: '2026-11-11T08:00:00Z' }, NOW)).toBeNull();
    expect(opWindow(null, NOW)).toBeNull();
  });

  it('terminal sem horário de fecho legível → null (não presume "aberta até agora")', () => {
    expect(opWindow({ status: 'CLOSED', entry_candle_time_15m: '2026-11-09T20:00:00Z', closed_at: 'lixo', updated_date: 'lixo', created_date: 'lixo' }, NOW)).toBeNull();
  });

  it('fim antes do início → null', () => {
    expect(opWindow(closedOp({ closed_at: '2026-11-01T00:00:00Z' }), NOW)).toBeNull();
  });
});

describe('eventsDuring', () => {
  const w = { startMs: D('2026-11-09T20:00:00Z'), endMs: D('2026-11-11T08:00:00Z') };

  it('pega o evento dentro da janela e ignora fora, na ordem das datas', () => {
    const events = [ev('NFP', '2026-11-06T13:30:00Z'), ev('CPI', '2026-11-10T13:30:00Z'), ev('FOMC', '2026-11-10T19:00:00Z'), ev('CPI', '2026-11-12T13:30:00Z')];
    expect(eventsDuring(w, events).map((e) => e.kind)).toEqual(['CPI', 'FOMC']);
  });

  it('as bordas contam (fechado dos dois lados)', () => {
    expect(eventsDuring(w, [ev('CPI', '2026-11-09T20:00:00Z')])).toHaveLength(1);
    expect(eventsDuring(w, [ev('CPI', '2026-11-11T08:00:00Z')])).toHaveLength(1);
    expect(eventsDuring(w, [ev('CPI', '2026-11-09T19:59:59Z')])).toHaveLength(0);
    expect(eventsDuring(w, [ev('CPI', '2026-11-11T08:00:01Z')])).toHaveLength(0);
  });

  it('por padrão só os de alta importância; PPI/PCE entram se pedidos', () => {
    const events = [ev('PPI', '2026-11-10T13:30:00Z'), ev('PCE', '2026-11-10T13:30:00Z')];
    expect(eventsDuring(w, events)).toEqual([]);
    expect(eventsDuring(w, events, { kinds: ['PPI', 'PCE'] })).toHaveLength(2);
  });

  it('entradas inválidas não quebram', () => {
    expect(eventsDuring(null, [ev('CPI', '2026-11-10T13:30:00Z')])).toEqual([]);
    expect(eventsDuring(w, null)).toEqual([]);
    expect(eventsDuring(w, [null, { kind: 'CPI' }, { kind: 'CPI', startsAtMs: NaN }])).toEqual([]);
  });
});

describe('overlapStats', () => {
  const events = [ev('CPI', '2026-11-10T13:30:00Z'), ev('NFP', '2026-11-06T13:30:00Z'), ev('PPI', '2026-11-13T13:30:00Z')];
  const opCpi = closedOp(); // 09/11 20:00 → 11/11 08:00: pega o CPI
  const opNone = closedOp({ entry_candle_time_15m: '2026-11-14T00:00:00Z', closed_at: '2026-11-15T00:00:00Z' });
  const opPpi = closedOp({ entry_candle_time_15m: '2026-11-12T00:00:00Z', closed_at: '2026-11-14T00:00:00Z' }); // só PPI

  it('conta marcadas de alta importância e a fração', () => {
    const s = overlapStats([opCpi, opNone, opPpi], events, { nowMs: NOW });
    expect(s).toMatchObject({ total: 3, marked: 1, outsideCoverage: 0, unreadable: 0 });
    expect(s.fraction).toBeCloseTo(1 / 3, 10);
    expect(s.byKind).toEqual({ CPI: 1, NFP: 0, FOMC: 0 });
  });

  it('com os 5 tipos o PPI também marca', () => {
    const s = overlapStats([opCpi, opNone, opPpi], events, { nowMs: NOW, kinds: ['CPI', 'NFP', 'PPI', 'PCE', 'FOMC'] });
    expect(s.marked).toBe(2);
    expect(s.byKind.PPI).toBe(1);
  });

  it('uma operação com 2 CPIs na janela conta 1 vez (por tipo e no total)', () => {
    const long = closedOp({ entry_candle_time_15m: '2026-10-01T00:00:00Z', closed_at: '2026-11-30T00:00:00Z' });
    const two = [ev('CPI', '2026-10-14T12:30:00Z'), ev('CPI', '2026-11-10T13:30:00Z')];
    const s = overlapStats([long], two, { nowMs: NOW });
    expect(s).toMatchObject({ total: 1, marked: 1 });
    expect(s.byKind.CPI).toBe(1);
  });

  it('fora da cobertura do histórico não entra no denominador', () => {
    const old = closedOp({ entry_candle_time_15m: '2025-01-01T00:00:00Z', closed_at: '2025-01-02T00:00:00Z' });
    const s = overlapStats([old, opCpi], events, { nowMs: NOW, coverageStartMs: D('2026-04-01T00:00:00Z') });
    expect(s).toMatchObject({ total: 1, marked: 1, outsideCoverage: 1 });
  });

  it('operação cuja janela toca um buraco do histórico fica fora do denominador (inGap)', () => {
    const gaps = [{ startMs: D('2026-11-12T00:00:00Z'), endMs: D('2026-11-13T00:00:00Z') }];
    const dentro = closedOp({ entry_candle_time_15m: '2026-11-12T10:00:00Z', closed_at: '2026-11-12T12:00:00Z' });
    const atravessa = closedOp({ entry_candle_time_15m: '2026-11-11T10:00:00Z', closed_at: '2026-11-14T00:00:00Z' });
    const fora = closedOp({ entry_candle_time_15m: '2026-11-14T00:00:00Z', closed_at: '2026-11-15T00:00:00Z' });
    const s = overlapStats([dentro, atravessa, fora, opCpi], events, { nowMs: NOW, gaps });
    expect(s).toMatchObject({ total: 2, inGap: 2, marked: 1 });
    // a borda do buraco também conta (fechado dos dois lados)
    const borda = closedOp({ entry_candle_time_15m: '2026-11-13T00:00:00Z', closed_at: '2026-11-13T06:00:00Z' });
    expect(overlapStats([borda], events, { nowMs: NOW, gaps }).inGap).toBe(1);
  });

  it('operação ilegível é contada à parte e nunca vira "sem evento"', () => {
    const s = overlapStats([{ status: 'TP2_HIT' }, opCpi], events, { nowMs: NOW });
    expect(s).toMatchObject({ total: 1, marked: 1, unreadable: 1 });
  });

  it('lista vazia: fração null, não 0 nem NaN', () => {
    expect(overlapStats([], events, { nowMs: NOW }).fraction).toBeNull();
    expect(overlapStats(undefined, events, { nowMs: NOW }).total).toBe(0);
  });

  it('a lista de alta importância é CPI, NFP e FOMC', () => {
    expect([...HIGH_IMPORTANCE_KINDS]).toEqual(['CPI', 'NFP', 'FOMC']);
  });
});
