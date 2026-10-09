// docs/known-risks.md item 261 — diagnóstico do stop furado por gap. Só mede;
// nenhum preenchimento muda. Valores calculados à mão em cada caso.
import { describe, it, expect } from 'vitest';
import { diagnoseStopGaps, findCandleByCloseTime } from './stopGapDiagnostic.js';

const H4 = 4 * 60 * 60 * 1000;
const T0 = new Date('2026-03-01T00:00:00.000Z').getTime();

// Série 4h com closeTime = openTime + 4h − 1 (convenção da Binance).
function candle(i, { open, close = open, high = Math.max(open, close), low = Math.min(open, close) }) {
  const openTime = T0 + i * H4;
  return { openTime, closeTime: openTime + H4 - 1, open, high, low, close, volume: 1 };
}
const closeIso = (c) => new Date(c.closeTime).toISOString();

function stopOp(overrides = {}) {
  return {
    id: 'op1', symbol: 'BTCUSDT', side: 'BUY', status: 'STOP_HIT', signal_timeframe: '4h',
    entry_price: 100, initial_stop: 95, current_stop: 95, exit_price: 95, tp1_hit: false,
    ...overrides,
  };
}

describe('findCandleByCloseTime', () => {
  const series = [candle(0, { open: 1 }), candle(1, { open: 2 }), candle(2, { open: 3 })];

  it('acha o candle pelo fechamento exato e devolve o anterior', () => {
    const found = findCandleByCloseTime(series, series[2].closeTime);
    expect(found.candle.open).toBe(3);
    expect(found.prev.open).toBe(2);
  });

  it('primeiro candle não tem anterior; fechamento inexistente devolve null', () => {
    expect(findCandleByCloseTime(series, series[0].closeTime).prev).toBeNull();
    expect(findCandleByCloseTime(series, series[1].closeTime + 1)).toBeNull();
    expect(findCandleByCloseTime(undefined, 0)).toBeNull();
  });
});

describe('diagnoseStopGaps', () => {
  it('BUY pré-TP1: abertura 92 abaixo do stop 95 → gap de 0,6R (3 / risco 5), posição inteira', () => {
    const series = [candle(0, { open: 99, close: 96 }), candle(1, { open: 92, close: 91 })];
    const r = diagnoseStopGaps([stopOp({ stop_hit_real_time: closeIso(series[1]) })], {
      seriesFor: () => series, countedOps: 10,
    });
    expect(r.stopExits).toBe(1);
    expect(r.withGap).toBe(1);
    expect(r.totalGapR).toBe(0.6);
    expect(r.byPhase.pre_tp1).toEqual({ stopExits: 1, withGap: 1, totalGapR: 0.6 });
    // Expectância cairia 0,6R / 10 operações contadas.
    expect(r.expectancyRDeltaIfFilledAtOpen).toBe(-0.06);
    expect(r.samples[0]).toMatchObject({ exitPriceRecorded: 95, exitCandleOpen: 92, gapR: 0.6, stopWasBeyondPrevClose: false });
  });

  it('runner: só a fração que saiu no stop conta (partial 50% → metade do gap)', () => {
    const series = [candle(0, { open: 101, close: 101 }), candle(1, { open: 97, close: 96 })];
    const op = stopOp({ tp1_hit: true, partial_percent: 50, current_stop: 100, exit_price: 100, stop_hit_real_time: closeIso(series[1]) });
    const r = diagnoseStopGaps([op], { seriesFor: () => series });
    // gap 3 / risco 5 = 0,6R × runner 0,5 = 0,3R
    expect(r.byPhase.runner).toEqual({ stopExits: 1, withGap: 1, totalGapR: 0.3 });
    expect(r.totalGapR).toBe(0.3);
  });

  it('SELL espelhado: abertura 108 acima do stop 105 → 0,6R', () => {
    const series = [candle(0, { open: 101, close: 104 }), candle(1, { open: 108, close: 109 })];
    const op = stopOp({ side: 'SELL', initial_stop: 105, current_stop: 105, exit_price: 105, stop_hit_real_time: closeIso(series[1]) });
    expect(diagnoseStopGaps([op], { seriesFor: () => series }).totalGapR).toBe(0.6);
  });

  it('candle que abre ANTES do stop (o preço negociou no stop) não é gap', () => {
    const series = [candle(0, { open: 99, close: 97 }), candle(1, { open: 96, low: 93, close: 94 })];
    const r = diagnoseStopGaps([stopOp({ stop_hit_real_time: closeIso(series[1]) })], { seriesFor: () => series });
    expect(r.withGap).toBe(0);
    expect(r.resolved).toBe(1);
    expect(r.gapRate).toBe(0);
    expect(r.totalGapR).toBe(0);
  });

  it('marca quando o stop já estava além do fechamento anterior (stop posto onde o preço não estava)', () => {
    const series = [candle(0, { open: 96, close: 94 }), candle(1, { open: 93, close: 92 })];
    const r = diagnoseStopGaps([stopOp({ stop_hit_real_time: closeIso(series[1]) })], { seriesFor: () => series });
    expect(r.prevCloseBeyondStop).toBe(1);
    expect(r.samples[0].stopWasBeyondPrevClose).toBe(true);
  });

  it('ignora o que não é STOP_HIT e conta à parte o que não dá para resolver — nunca adivinha', () => {
    const series = [candle(0, { open: 92 })];
    const r = diagnoseStopGaps([
      stopOp({ status: 'TP2_HIT', stop_hit_real_time: closeIso(series[0]) }),
      stopOp({ id: 'semTempo', stop_hit_real_time: null }),
      stopOp({ id: 'semCandle', stop_hit_real_time: new Date(T0 + 99 * H4).toISOString() }),
      stopOp({ id: 'semRisco', initial_stop: 100, stop_hit_real_time: closeIso(series[0]) }),
    ], { seriesFor: () => series });
    expect(r.stopExits).toBe(3);
    expect(r.resolved).toBe(0);
    expect(r.unresolved).toEqual({ count: 3, byReason: { no_exit_candle_time: 1, candle_not_found: 1, no_initial_risk: 1 } });
    expect(r.gapRate).toBeNull();
    expect(r.expectancyRDeltaIfFilledAtOpen).toBeNull();
  });

  it('usa a série do timeframe de gestão da operação (signal_timeframe), 4h por padrão', () => {
    const asked = [];
    diagnoseStopGaps([stopOp({ signal_timeframe: '1h', stop_hit_real_time: closeIso(candle(0, { open: 1 })) }), stopOp({ signal_timeframe: undefined, stop_hit_real_time: closeIso(candle(0, { open: 1 })) })], {
      seriesFor: (symbol, tf) => { asked.push(`${symbol}:${tf}`); return []; },
    });
    expect(asked).toEqual(['BTCUSDT:1h', 'BTCUSDT:4h']);
  });

  it('amostras ordenadas pelo maior gap', () => {
    const series = [candle(0, { open: 90 }), candle(1, { open: 94 })];
    const r = diagnoseStopGaps([
      stopOp({ id: 'pequeno', stop_hit_real_time: closeIso(series[1]) }),
      stopOp({ id: 'grande', stop_hit_real_time: closeIso(series[0]) }),
    ], { seriesFor: () => series });
    expect(r.samples.map((s) => s.id)).toEqual(['grande', 'pequeno']);
    expect(r.maxGapR).toBe(1);
  });
});
