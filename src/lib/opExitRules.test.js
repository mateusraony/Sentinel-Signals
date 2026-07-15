import { describe, it, expect } from 'vitest';
import { isCandleUsableForExits, advanceTrailingStop, nextRfReverseCount } from './opExitRules.js';

const T0 = '2026-07-15T04:00:00.000Z'; // signal/entry candle close
const T1 = '2026-07-15T08:00:00.000Z'; // next 4h candle close
const Tpast = '2026-07-15T00:00:00.000Z'; // candle BEFORE the signal (replay)

describe('isCandleUsableForExits (P0-c — guard temporal)', () => {
  it('rejeita o próprio candle de entrada (high/low contém movimento pré-entrada)', () => {
    expect(isCandleUsableForExits(T0, T0)).toBe(false);
  });

  it('rejeita candle anterior à entrada (replay/backfill)', () => {
    expect(isCandleUsableForExits(Tpast, T0)).toBe(false);
  });

  it('aceita o candle estritamente posterior', () => {
    expect(isCandleUsableForExits(T1, T0)).toBe(true);
  });

  it('fallback legado: sem candle_close_time na op, mantém o comportamento antigo', () => {
    expect(isCandleUsableForExits(T1, null)).toBe(true);
    expect(isCandleUsableForExits(T1, undefined)).toBe(true);
  });

  it('fallback legado: feed sem lastCandleTime, mantém o comportamento antigo', () => {
    expect(isCandleUsableForExits(null, T0)).toBe(true);
  });
});

describe('advanceTrailingStop (P0-d — trailing monotônico)', () => {
  it('BUY: avança quando o close sobe, nunca recua', () => {
    const up = advanceTrailingStop({ isBuy: true, currentStop: 100, closePrice: 120, atrValue: 5, trailMult: 2 });
    expect(up).toBe(110); // 120 - 10
    const down = advanceTrailingStop({ isBuy: true, currentStop: 110, closePrice: 105, atrValue: 5, trailMult: 2 });
    expect(down).toBe(110); // 105-10=95 < 110 → mantém
  });

  it('SELL: desce quando o close cai, nunca recua', () => {
    const dn = advanceTrailingStop({ isBuy: false, currentStop: 100, closePrice: 80, atrValue: 5, trailMult: 2 });
    expect(dn).toBe(90); // 80 + 10
    const upMove = advanceTrailingStop({ isBuy: false, currentStop: 90, closePrice: 95, atrValue: 5, trailMult: 2 });
    expect(upMove).toBe(90); // 95+10=105 > 90 → mantém
  });
});

// Reproduz o look-ahead do P0-d no nível de regra: o stop derivado do
// fechamento deste candle NÃO pode ser testado contra o low/high do mesmo
// candle. A ordem correta (espelhada no scanner) é: (1) testar o stop
// ARMAZENADO contra o candle; (2) só então avançar o trailing para a próxima
// passada.
describe('ordem stored-stop → advance (P0-d — sem look-ahead)', () => {
  it('cenário que o código antigo fechava indevidamente: trail do close acima do low do próprio candle', () => {
    // Runner BUY: stop armazenado 90; candle: low 96, close 110, ATR 5, mult 2.
    // Trail derivado do close = 100 > low 96 → o código antigo fecharia
    // (comparava o low contra o stop AVANÇADO). Ordem correta:
    const storedStop = 90;
    const candleLow = 96;
    const stopHitAgainstStored = candleLow <= storedStop;
    expect(stopHitAgainstStored).toBe(false); // não fecha neste candle
    const nextStop = advanceTrailingStop({ isBuy: true, currentStop: storedStop, closePrice: 110, atrValue: 5, trailMult: 2 });
    expect(nextStop).toBe(100); // passa a proteger a partir do PRÓXIMO candle
  });

  it('candle seguinte abaixo do stop avançado fecha normalmente', () => {
    const advancedStop = 100;
    const nextCandleLow = 99;
    expect(nextCandleLow <= advancedStop).toBe(true);
  });
});

describe('nextRfReverseCount (P0-e — contagem por candle, não por scan)', () => {
  it('N passadas sobre o MESMO candle contam 1x', () => {
    let state = { count: 0, lastCandle: null };
    for (let pass = 0; pass < 5; pass++) {
      state = nextRfReverseCount({
        rfReversedAgainst: true,
        prevCount: state.count,
        prevCandleTime: state.lastCandle,
        candleTime: T0,
      });
    }
    expect(state.count).toBe(1);
    expect(state.lastCandle).toBe(T0);
  });

  it('candle novo incrementa', () => {
    const s1 = nextRfReverseCount({ rfReversedAgainst: true, prevCount: 1, prevCandleTime: T0, candleTime: T1 });
    expect(s1.count).toBe(2);
    expect(s1.lastCandle).toBe(T1);
  });

  it('RF de volta a favor reseta', () => {
    const s = nextRfReverseCount({ rfReversedAgainst: false, prevCount: 3, prevCandleTime: T1, candleTime: T1 });
    expect(s.count).toBe(0);
    expect(s.lastCandle).toBe(null);
  });

  it('fallback legado: sem candleTime, mantém o incremento por passada antigo', () => {
    const s = nextRfReverseCount({ rfReversedAgainst: true, prevCount: 2, prevCandleTime: null, candleTime: null });
    expect(s.count).toBe(3);
  });
});
