import { describe, it, expect } from 'vitest';
import { detectOrderBlock } from './orderBlock';
import { mkCandle } from './__fixtures__/candles';

// Cenário canônico de OB bullish: velas de alta, UMA vela de baixa (o OB),
// depois a vela de rompimento. `obRange` controla o tamanho da zona e
// `breakClose` onde o preço atual fecha (dentro ou fora da zona).
function bullSeries({ obRange = 2, breakClose = 101, extra = [] } = {}) {
  return [
    mkCandle(97, 98, 96, 97.5, 0), // alta
    mkCandle(100, 100 + obRange / 2, 100 - obRange / 2, 99, 1), // OB: close < open
    ...extra,
    mkCandle(100, 105, 99, breakClose, 2 + extra.length), // vela do rompimento
  ];
}

function bearSeries({ obRange = 2, breakClose = 99, extra = [] } = {}) {
  return [
    mkCandle(103, 104, 102, 102.5, 0),
    mkCandle(100, 100 + obRange / 2, 100 - obRange / 2, 101, 1), // OB: close > open
    ...extra,
    mkCandle(100, 101, 95, breakClose, 2 + extra.length),
  ];
}

describe('detectOrderBlock', () => {
  it('acha a última vela de BAIXA antes de um rompimento de alta (BUY)', () => {
    const result = detectOrderBlock(bullSeries({ obRange: 2, breakClose: 100 }), {
      direction: 'BUY', atrValue: 2,
    });
    expect(result.zoneHigh).toBe(101);
    expect(result.zoneLow).toBe(99);
    expect(result.zoneSize).toBe(2);
    expect(result.barsAgo).toBe(1);
    expect(result.active).toBe(true); // close 100 dentro de [99, 101]
  });

  it('acha a última vela de ALTA antes de um rompimento de baixa (SELL)', () => {
    const result = detectOrderBlock(bearSeries({ obRange: 2, breakClose: 100 }), {
      direction: 'SELL', atrValue: 2,
    });
    expect(result.zoneHigh).toBe(101);
    expect(result.zoneLow).toBe(99);
    expect(result.active).toBe(true);
  });

  it('pula velas da MESMA cor do rompimento até achar a contrária', () => {
    // Duas velas de alta entre o OB e o rompimento — devem ser ignoradas.
    const extra = [
      mkCandle(99, 102, 98.5, 101, 2),
      mkCandle(101, 103, 100, 102, 3),
    ];
    const result = detectOrderBlock(bullSeries({ obRange: 2, breakClose: 100, extra }), {
      direction: 'BUY', atrValue: 2,
    });
    expect(result.zoneHigh).toBe(101); // ainda o OB original
    expect(result.zoneLow).toBe(99);
    expect(result.barsAgo).toBe(3);
  });

  it('rejeita zona PEQUENA demais na fronteira exata do filtro', () => {
    // atrValue=10, minAtrMult=0.5 -> mínimo 5. Zona de 4 reprova, de 6 passa.
    const small = detectOrderBlock(bullSeries({ obRange: 4, breakClose: 100 }), {
      direction: 'BUY', atrValue: 10,
    });
    expect(small.active).toBe(false);
    expect(small.reason).toBe('size_out_of_range');
    expect(small.zoneSize).toBe(4); // reportado mesmo reprovando, para auditoria

    const ok = detectOrderBlock(bullSeries({ obRange: 6, breakClose: 100 }), {
      direction: 'BUY', atrValue: 10,
    });
    expect(ok.active).toBe(true);
  });

  it('rejeita zona GRANDE demais na fronteira exata do filtro', () => {
    // atrValue=10, maxAtrMult=2.5 -> máximo 25. Zona de 26 reprova, 24 passa.
    const big = detectOrderBlock(bullSeries({ obRange: 26, breakClose: 100 }), {
      direction: 'BUY', atrValue: 10,
    });
    expect(big.active).toBe(false);
    expect(big.reason).toBe('size_out_of_range');

    const ok = detectOrderBlock(bullSeries({ obRange: 24, breakClose: 100 }), {
      direction: 'BUY', atrValue: 10,
    });
    expect(ok.active).toBe(true);
  });

  it('preço fora da zona -> não está ativo, mas a zona ainda é reportada', () => {
    // close 104 acima de zoneHigh 101.
    const result = detectOrderBlock(bullSeries({ obRange: 2, breakClose: 104 }), {
      direction: 'BUY', atrValue: 2,
    });
    expect(result.active).toBe(false);
    expect(result.reason).toBe('price_outside_zone');
    expect(result.zoneHigh).toBe(101);
  });

  it('fechamento posterior além da zona no sentido contrário INVALIDA o bloco', () => {
    // Zona bullish [99, 101]. A vela invalidadora precisa fechar abaixo de 99
    // E ser de ALTA (close > open) — senão ela própria vira a "última vela
    // contrária" e substitui o OB em vez de invalidá-lo. Cenário real: gap de
    // baixa seguido de recuperação parcial, ainda fechando sob a zona.
    const extra = [mkCandle(96, 98.5, 95, 98, 2)];
    const result = detectOrderBlock(bullSeries({ obRange: 2, breakClose: 100, extra }), {
      direction: 'BUY', atrValue: 2,
    });
    expect(result.active).toBe(false);
    expect(result.reason).toBe('invalidated');
  });

  it('invalidação bearish é espelhada (fechamento acima da zona)', () => {
    // Zona bearish [99, 101]; invalidadora fecha acima de 101 e é de BAIXA.
    const extra = [mkCandle(105, 106, 102.5, 103, 2)];
    const result = detectOrderBlock(bearSeries({ obRange: 2, breakClose: 100, extra }), {
      direction: 'SELL', atrValue: 2,
    });
    expect(result.active).toBe(false);
    expect(result.reason).toBe('invalidated');
  });

  it('nenhuma vela contrária dentro do maxLookback -> no_opposing_candle, sem exceção', () => {
    const allBull = Array.from({ length: 10 }, (_, i) => mkCandle(100 + i, 102 + i, 99 + i, 101 + i, i));
    const result = detectOrderBlock(allBull, { direction: 'BUY', atrValue: 2 });
    expect(result.active).toBe(false);
    expect(result.reason).toBe('no_opposing_candle');
  });

  it('respeita maxLookback — vela contrária velha demais não conta', () => {
    const extra = Array.from({ length: 6 }, (_, i) => mkCandle(100 + i, 102 + i, 99 + i, 101 + i, 2 + i));
    const candles = bullSeries({ obRange: 2, breakClose: 100, extra });
    expect(detectOrderBlock(candles, { direction: 'BUY', atrValue: 2, maxLookback: 3 }).reason)
      .toBe('no_opposing_candle');
    expect(detectOrderBlock(candles, { direction: 'BUY', atrValue: 2, maxLookback: 20 }).reason)
      .not.toBe('no_opposing_candle');
  });

  it('entradas inválidas não lançam exceção', () => {
    const candles = bullSeries({});
    expect(detectOrderBlock(candles, { direction: 'UP', atrValue: 2 }).reason).toBe('invalid_params');
    expect(detectOrderBlock(candles, { direction: 'BUY', atrValue: 0 }).reason).toBe('invalid_params');
    expect(detectOrderBlock(candles, { direction: 'BUY', atrValue: null }).reason).toBe('invalid_params');
    expect(detectOrderBlock(candles, { direction: 'BUY', atrValue: 2, minAtrMult: 3, maxAtrMult: 1 }).reason)
      .toBe('invalid_params');
    expect(detectOrderBlock([], { direction: 'BUY', atrValue: 2 }).reason).toBe('no_candles');
  });
});
