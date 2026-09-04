import { describe, it, expect } from 'vitest';
import {
  usablePrice,
  formatPrice,
  formatSignedPct,
  pctDelta,
  formatQuoteAge,
  nextMilestone,
  stopPosture,
  orderLevelsByRail,
  describeProximity,
  rrGeometry,
  LEVEL_DEFS,
} from './priceProximity';

const buyOp = { side: 'BUY', current_stop: 90, entry_price: 100, tp1: 110, tp2: 120 };
const sellOp = { side: 'SELL', current_stop: 110, entry_price: 100, tp1: 90, tp2: 80 };

describe('usablePrice', () => {
  it('aceita número finito positivo', () => {
    expect(usablePrice(100)).toBe(100);
    expect(usablePrice(0.00000123)).toBe(0.00000123);
  });

  it('aceita número serializado como string (RTDB)', () => {
    expect(usablePrice('42.5')).toBe(42.5);
  });

  it('rejeita zero, negativo, NaN, Infinity, null e texto', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity, null, undefined, '', '  ', 'abc', {}, []]) {
      expect(usablePrice(bad)).toBeNull();
    }
  });
});

describe('formatPrice', () => {
  it('usa uma única escala por faixa de magnitude', () => {
    expect(formatPrice(64231.5)).toBe('64,231.50');
    expect(formatPrice(1000)).toBe('1,000.00');
    expect(formatPrice(250.123)).toBe('250.12');
    expect(formatPrice(50)).toBe('50.0000');
    expect(formatPrice(0.5)).toBe('0.50000');
    expect(formatPrice(0.001234567)).toBe('0.001235');
    expect(formatPrice(0.00000123)).toBe('0.00000123');
  });

  it('formata zero e degrada para em-dash no resto', () => {
    expect(formatPrice(0)).toBe('0.00');
    for (const bad of [null, undefined, NaN, Infinity, 'abc']) {
      expect(formatPrice(bad)).toBe('—');
    }
  });

  it('não perde a parte inteira de preços negativos', () => {
    expect(formatPrice(-250.5)).toBe('-250.50');
  });
});

describe('formatSignedPct', () => {
  it('marca o positivo com sinal explícito', () => {
    expect(formatSignedPct(1.234)).toBe('+1.23%');
    expect(formatSignedPct(-1.234)).toBe('-1.23%');
    expect(formatSignedPct(0)).toBe('0.00%');
    expect(formatSignedPct(null)).toBe('—');
  });
});

describe('formatQuoteAge', () => {
  it('tem granularidade de segundo — a cotação atualiza a cada 30s', () => {
    expect(formatQuoteAge(0)).toBe('0s');
    expect(formatQuoteAge(45_000)).toBe('45s');
    expect(formatQuoteAge(59_999)).toBe('59s');
  });

  it('sobe a escala conforme a cotação envelhece', () => {
    expect(formatQuoteAge(60_000)).toBe('1min');
    expect(formatQuoteAge(90 * 60_000)).toBe('1h');
    expect(formatQuoteAge(50 * 60 * 60_000)).toBe('2d');
  });

  it('devolve null para entrada inválida ou negativa', () => {
    for (const bad of [null, undefined, NaN, -1, 'abc']) {
      expect(formatQuoteAge(bad)).toBeNull();
    }
  });
});

describe('pctDelta', () => {
  it('mede quanto o preço precisa andar até o nível', () => {
    expect(pctDelta(100, 110)).toBeCloseTo(10, 10);
    expect(pctDelta(100, 90)).toBeCloseTo(-10, 10);
  });

  it('devolve null em vez de Infinity/NaN quando falta um lado', () => {
    expect(pctDelta(0, 110)).toBeNull();
    expect(pctDelta(100, null)).toBeNull();
    expect(pctDelta(undefined, undefined)).toBeNull();
  });
});

describe('describeProximity', () => {
  it('devolve os 4 níveis com distância assinada a partir do preço ao vivo', () => {
    const { levels } = describeProximity(buyOp, 105);
    expect(levels.map(l => l.key)).toEqual(['stop', 'entry', 'tp1', 'tp2']);
    const byKey = Object.fromEntries(levels.map(l => [l.key, l]));
    expect(byKey.tp1.pct).toBeCloseTo(4.7619, 3);
    expect(byKey.tp1.position).toBe('above');
    expect(byKey.entry.position).toBe('below');
    expect(byKey.stop.pct).toBeLessThan(0);
  });

  it('marca como mais próximo o nível de menor distância absoluta', () => {
    const { nearestKey, levels } = describeProximity(buyOp, 108);
    expect(nearestKey).toBe('tp1');
    expect(levels.filter(l => l.isNearest)).toHaveLength(1);
  });

  it('calcula resultado bruto direcional (SELL lucra caindo)', () => {
    expect(describeProximity(buyOp, 105).unrealizedPct).toBeCloseTo(5, 10);
    expect(describeProximity(sellOp, 95).unrealizedPct).toBeCloseTo(5, 10);
    expect(describeProximity(sellOp, 105).unrealizedPct).toBeCloseTo(-5, 10);
  });

  it('degrada por nível: campo ausente some sozinho, os outros permanecem', () => {
    const { levels } = describeProximity({ side: 'BUY', entry_price: 100, tp1: 110 }, 105);
    expect(levels.map(l => l.key)).toEqual(['entry', 'tp1']);
  });

  it('sem preço ao vivo ainda devolve os níveis, com pct nulo', () => {
    const { levels, nearestKey, unrealizedPct, currentPrice } = describeProximity(buyOp, null);
    expect(levels).toHaveLength(4);
    expect(levels.every(l => l.pct === null && l.position === null)).toBe(true);
    expect(nearestKey).toBeNull();
    expect(unrealizedPct).toBeNull();
    expect(currentPrice).toBeNull();
  });

  it('trata operação vazia sem lançar', () => {
    const result = describeProximity(undefined, undefined);
    expect(result.levels).toEqual([]);
    expect(result.side).toBe('BUY');
  });

  it('marca "at" quando o preço está exatamente no nível', () => {
    const byKey = Object.fromEntries(describeProximity(buyOp, 110).levels.map(l => [l.key, l]));
    expect(byKey.tp1.position).toBe('at');
    expect(byKey.tp1.pct).toBe(0);
  });
});

describe('rrGeometry', () => {
  it('posiciona os níveis de um BUY em ordem crescente', () => {
    const geo = rrGeometry(buyOp, 105);
    expect(geo.positions.stop).toBe(0);
    expect(geo.positions.entry).toBeCloseTo(100 / 3, 10);
    expect(geo.positions.tp1).toBeCloseTo(200 / 3, 10);
    expect(geo.positions.tp2).toBe(100);
    expect(geo.currentPct).toBeCloseTo(50, 10);
    expect(geo.currentOutOfRange).toBe(false);
    expect(geo.isBuy).toBe(true);
  });

  it('espelha para SELL — stop no topo, tp2 na base', () => {
    const geo = rrGeometry(sellOp, 95);
    expect(geo.positions.stop).toBe(100);
    expect(geo.positions.tp2).toBe(0);
    expect(geo.isBuy).toBe(false);
  });

  it('mantém todo marcador dentro de 0–100 com stop de trailing além da entrada', () => {
    // Trailing pré-TP1 ligado em produção: o stop pode passar da entrada.
    const geo = rrGeometry({ side: 'BUY', current_stop: 105, entry_price: 100, tp1: 110, tp2: 120 }, 107);
    for (const value of Object.values(geo.positions)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(geo.positions.entry).toBe(0);
    expect(geo.positions.stop).toBe(25);
  });

  it('clampa o marcador de preço e sinaliza quando ele saiu do intervalo', () => {
    const abaixo = rrGeometry(buyOp, 50);
    expect(abaixo.currentPct).toBe(0);
    expect(abaixo.currentOutOfRange).toBe(true);

    const acima = rrGeometry(buyOp, 500);
    expect(acima.currentPct).toBe(100);
    expect(acima.currentOutOfRange).toBe(true);
  });

  it('gera segmentos não negativos em qualquer lado', () => {
    for (const op of [buyOp, sellOp]) {
      const geo = rrGeometry(op, 100);
      expect(geo.segments.map(s => s.key)).toEqual(['risk', 'tp1', 'tp2']);
      for (const seg of geo.segments) {
        expect(seg.to - seg.from).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('devolve null quando falta qualquer nível ou o intervalo é degenerado', () => {
    expect(rrGeometry({ side: 'BUY', entry_price: 100, tp1: 110, tp2: 120 }, 105)).toBeNull();
    expect(rrGeometry({ side: 'BUY', current_stop: 100, entry_price: 100, tp1: 100, tp2: 100 }, 100)).toBeNull();
    expect(rrGeometry(null, 105)).toBeNull();
  });

  it('sem preço ao vivo ainda desenha a barra, só sem o marcador', () => {
    const geo = rrGeometry(buyOp, null);
    expect(geo.currentPct).toBeNull();
    expect(geo.currentOutOfRange).toBe(false);
    expect(geo.positions.tp2).toBe(100);
  });
});

describe('LEVEL_DEFS', () => {
  it('está congelado e cobre exatamente os campos da operação', () => {
    expect(Object.isFrozen(LEVEL_DEFS)).toBe(true);
    expect(LEVEL_DEFS.map(d => d.field)).toEqual(['current_stop', 'entry_price', 'tp1', 'tp2']);
  });
});

describe('nextMilestone', () => {
  it('aponta o TP mais próximo quando o preço está entre entrada e TP1', () => {
    const m = nextMilestone(buyOp, 105);
    expect(m.key).toBe('tp1');
    expect(m.kind).toBe('target');
    expect(m.absPct).toBeCloseTo(4.7619, 3);
  });

  it('pula o TP1 já ultrapassado e passa a mirar o TP2', () => {
    expect(nextMilestone(buyOp, 115).key).toBe('tp2');
  });

  it('avisa do stop quando ele é o marco mais próximo', () => {
    const m = nextMilestone(buyOp, 91);
    expect(m.key).toBe('stop');
    expect(m.kind).toBe('risk');
  });

  it('espelha a direção para SELL', () => {
    expect(nextMilestone(sellOp, 95).key).toBe('tp1');
    expect(nextMilestone(sellOp, 85).key).toBe('tp2');
    expect(nextMilestone(sellOp, 109).key).toBe('stop');
  });

  it('funciona com stop de trailing acima da entrada (BUY)', () => {
    const trailing = { side: 'BUY', current_stop: 105, entry_price: 100, tp1: 110, tp2: 120 };
    expect(nextMilestone(trailing, 107).key).toBe('stop');
    expect(nextMilestone(trailing, 109.5).key).toBe('tp1');
  });

  it('devolve null sem preço, sem níveis, ou quando nada está pendente', () => {
    expect(nextMilestone(buyOp, null)).toBeNull();
    expect(nextMilestone({ side: 'BUY' }, 105)).toBeNull();
    // preço acima de tudo: nenhum alvo à frente e o stop já ficou para trás
    expect(nextMilestone({ side: 'BUY', tp1: 100, tp2: 110 }, 200)).toBeNull();
  });
});

describe('nextMilestone — alvo já executado', () => {
  it('não anuncia o TP1 de novo quando ele já foi atingido (runner que recuou)', () => {
    // BUY com TP1 executado em 110; preço recuou para 108.
    const runner = { ...buyOp, tp1_hit: true };
    const m = nextMilestone(runner, 108);
    expect(m.key).not.toBe('tp1');
    expect(m.key).toBe('tp2');
  });

  it('sem tp1_hit, o mesmo cenário continua mirando o TP1', () => {
    expect(nextMilestone(buyOp, 108).key).toBe('tp1');
  });

  it('ignora também um TP2 já atingido', () => {
    expect(nextMilestone({ ...buyOp, tp1_hit: true, tp2_hit: true }, 108).key).toBe('stop');
  });
});

describe('stopPosture', () => {
  it('classifica risco, breakeven e lucro travado num BUY', () => {
    expect(stopPosture({ side: 'BUY', entry_price: 100, current_stop: 90 })).toBe('risk');
    expect(stopPosture({ side: 'BUY', entry_price: 100, current_stop: 100 })).toBe('breakeven');
    expect(stopPosture({ side: 'BUY', entry_price: 100, current_stop: 108 })).toBe('locked');
  });

  it('espelha para SELL', () => {
    expect(stopPosture({ side: 'SELL', entry_price: 100, current_stop: 110 })).toBe('risk');
    expect(stopPosture({ side: 'SELL', entry_price: 100, current_stop: 100 })).toBe('breakeven');
    expect(stopPosture({ side: 'SELL', entry_price: 100, current_stop: 92 })).toBe('locked');
  });

  it('não transforma ruído de ponto flutuante em lucro travado', () => {
    expect(stopPosture({ side: 'BUY', entry_price: 100, current_stop: 100.00000001 })).toBe('breakeven');
  });

  it('não deduz nada de tp1_hit — só dos preços', () => {
    // tp1_hit não muda a resposta: o stop é que decide.
    expect(stopPosture({ side: 'BUY', entry_price: 100, current_stop: 90, tp1_hit: true })).toBe('risk');
  });

  it('devolve null sem stop ou sem entrada', () => {
    expect(stopPosture({ side: 'BUY', entry_price: 100 })).toBeNull();
    expect(stopPosture(null)).toBeNull();
  });
});

describe('orderLevelsByRail', () => {
  it('num BUY mantém stop → entrada → TP1 → TP2', () => {
    const { levels } = describeProximity(buyOp, 105);
    expect(orderLevelsByRail(levels).map(l => l.key)).toEqual(['stop', 'entry', 'tp1', 'tp2']);
  });

  it('num SELL inverte, para casar com as pontas da trilha', () => {
    const { levels } = describeProximity(sellOp, 95);
    expect(orderLevelsByRail(levels).map(l => l.key)).toEqual(['tp2', 'tp1', 'entry', 'stop']);
  });

  it('a ordem sempre bate com as posições calculadas por rrGeometry', () => {
    for (const op of [buyOp, sellOp, { side: 'BUY', current_stop: 105, entry_price: 100, tp1: 110, tp2: 120 }]) {
      const { levels } = describeProximity(op, 100);
      const geo = rrGeometry(op, 100);
      const positions = orderLevelsByRail(levels).map(l => geo.positions[l.key]);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it('não muta o array recebido', () => {
    const { levels } = describeProximity(sellOp, 95);
    const before = levels.map(l => l.key);
    orderLevelsByRail(levels);
    expect(levels.map(l => l.key)).toEqual(before);
  });
});
