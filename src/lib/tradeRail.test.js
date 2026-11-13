import { describe, it, expect } from 'vitest';
import { buildTradeRail, layoutRailLabels } from './tradeRail.js';

const sell = (overrides = {}) => ({
  side: 'SELL', entry_price: 180, initial_stop: 200, current_stop: 170, tp1: 150, tp2: 120, ...overrides,
});
const buy = (overrides = {}) => ({
  side: 'BUY', entry_price: 100, initial_stop: 90, current_stop: 90, tp1: 115, tp2: 130, ...overrides,
});
const marker = (rail, key) => rail.markers.find((m) => m.key === key);
const zone = (rail, key) => rail.zones.find((z) => z.key === key);

describe('buildTradeRail — posições', () => {
  it('compra: prejuízo à esquerda, lucro à direita (eixo de preço normal)', () => {
    const rail = buildTradeRail(buy(), 105);
    expect(rail.isBuy).toBe(true);
    expect(rail.flipped).toBe(false);
    expect(marker(rail, 'stop').pos).toBe(0);
    expect(marker(rail, 'entry').pos).toBeCloseTo(25, 10);
    expect(marker(rail, 'tp1').pos).toBeCloseTo(62.5, 10);
    expect(marker(rail, 'tp2').pos).toBe(100);
    expect(rail.pricePos).toBeCloseTo(37.5, 10);
    expect(rail.priceOutOfRange).toBe(false);
  });

  it('venda com profitToRight (padrão): eixo espelhado, o TP2 fica à direita e o stop inicial à esquerda', () => {
    const rail = buildTradeRail(sell(), 160);
    expect(rail.flipped).toBe(true);
    expect(marker(rail, 'initialStop').pos).toBe(0);
    expect(marker(rail, 'entry').pos).toBeCloseTo(25, 10);
    expect(marker(rail, 'stop').pos).toBeCloseTo(37.5, 10);
    expect(marker(rail, 'tp1').pos).toBeCloseTo(62.5, 10);
    expect(marker(rail, 'tp2').pos).toBe(100);
    expect(rail.pricePos).toBeCloseTo(50, 10);
  });

  it('venda com profitToRight desligado: eixo de preço fixo (menor preço à esquerda), como a trilha antiga', () => {
    const rail = buildTradeRail(sell(), 160, { profitToRight: false });
    expect(rail.flipped).toBe(false);
    expect(marker(rail, 'tp2').pos).toBe(0);
    expect(marker(rail, 'initialStop').pos).toBe(100);
    expect(marker(rail, 'entry').pos).toBeCloseTo(75, 10);
    expect(rail.pricePos).toBeCloseTo(50, 10);
  });

  it('em qualquer orientação, a ordem na direção do lucro é sempre stop inicial → entrada → TP1 → TP2', () => {
    for (const op of [buy({ current_stop: 95 }), sell()]) {
      const rail = buildTradeRail(op, null);
      const order = ['initialStop', 'entry', 'tp1', 'tp2'].map((k) => marker(rail, k).pos);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it('preço fora da trilha é encostado na borda e marcado como fora', () => {
    const rail = buildTradeRail(buy(), 200);
    expect(rail.pricePos).toBe(100);
    expect(rail.priceOutOfRange).toBe(true);
    const below = buildTradeRail(buy(), 50);
    expect(below.pricePos).toBe(0);
    expect(below.priceOutOfRange).toBe(true);
  });

  it('sem preço ao vivo a trilha continua (só sem agulha)', () => {
    for (const price of [null, undefined, NaN, 0, -3, '105']) {
      const rail = buildTradeRail(buy(), price);
      expect(rail.pricePos).toBeNull();
      expect(rail.priceOutOfRange).toBe(false);
      expect(rail.markers.length).toBe(4);
    }
  });

  it('sem algum nível obrigatório, ou com todos iguais, não há trilha', () => {
    for (const field of ['current_stop', 'entry_price', 'tp1', 'tp2']) {
      expect(buildTradeRail(buy({ [field]: null }), 105)).toBeNull();
      expect(buildTradeRail(buy({ [field]: NaN }), 105)).toBeNull();
    }
    expect(buildTradeRail({ side: 'BUY', entry_price: 5, current_stop: 5, tp1: 5, tp2: 5 }, 5)).toBeNull();
    expect(buildTradeRail(null, 5)).toBeNull();
  });
});

describe('buildTradeRail — stop inicial como marcador', () => {
  it('não aparece quando é igual ao stop atual (seria o mesmo marcador duas vezes)', () => {
    expect(marker(buildTradeRail(buy(), 105), 'initialStop')).toBeUndefined();
  });

  it('aparece quando o stop já andou', () => {
    const rail = buildTradeRail(buy({ current_stop: 96 }), 105);
    expect(marker(rail, 'initialStop').price).toBe(90);
    expect(marker(rail, 'initialStop').pos).toBe(0);
  });

  it('é ignorado se não estiver do lado do risco (dado estranho não vira desenho)', () => {
    expect(marker(buildTradeRail(buy({ initial_stop: 104, current_stop: 96 }), 105), 'initialStop')).toBeUndefined();
    expect(marker(buildTradeRail(sell({ initial_stop: 175 }), 160), 'initialStop')).toBeUndefined();
    expect(marker(buildTradeRail(buy({ initial_stop: null, current_stop: 96 }), 105), 'initialStop')).toBeUndefined();
  });
});

describe('buildTradeRail — cada faixa tem um sentido só', () => {
  it('stop ainda no inicial: só risco (stop↔entrada) e alvo (entrada↔TP2)', () => {
    const rail = buildTradeRail(buy(), 105);
    expect(rail.posture).toBe('risk');
    expect(rail.zones.map((z) => z.key)).toEqual(['risk', 'reward']);
    expect(zone(rail, 'risk')).toMatchObject({ from: 0, to: 25 });
    expect(zone(rail, 'reward')).toMatchObject({ from: 25, to: 100 });
  });

  it('stop aproximado mas ainda no risco: parte do risco saiu, parte continua', () => {
    const rail = buildTradeRail(buy({ current_stop: 96 }), 105);
    expect(rail.zones.map((z) => z.key)).toEqual(['riskRemoved', 'risk', 'reward']);
    expect(zone(rail, 'riskRemoved').from).toBe(0);
    expect(zone(rail, 'riskRemoved').to).toBeCloseTo(15, 10);
    expect(zone(rail, 'risk').from).toBeCloseTo(15, 10);
    expect(zone(rail, 'risk').to).toBeCloseTo(25, 10);
  });

  it('stop na entrada (breakeven): não sobra risco nem lucro protegido', () => {
    const rail = buildTradeRail(buy({ current_stop: 100 }), 105);
    expect(rail.posture).toBe('breakeven');
    expect(rail.zones.map((z) => z.key)).toEqual(['riskRemoved', 'reward']);
    expect(zone(rail, 'riskRemoved')).toMatchObject({ from: 0, to: 25 });
  });

  it('REGRESSÃO do item 302: stop além da entrada vira faixa de lucro protegido, sem nenhuma faixa de risco por cima', () => {
    const rail = buildTradeRail(sell(), 160);
    expect(rail.posture).toBe('locked');
    expect(rail.zones.map((z) => z.key)).toEqual(['riskRemoved', 'locked', 'reward']);
    expect(zone(rail, 'risk')).toBeUndefined();
    expect(zone(rail, 'riskRemoved')).toMatchObject({ from: 0, to: 25 });
    expect(zone(rail, 'locked').from).toBeCloseTo(25, 10);
    expect(zone(rail, 'locked').to).toBeCloseTo(37.5, 10);
    expect(zone(rail, 'reward').from).toBeCloseTo(37.5, 10);
    expect(zone(rail, 'reward').to).toBe(100);
  });

  it('as faixas nunca se sobrepõem e cobrem a trilha de ponta a ponta', () => {
    const cases = [
      buildTradeRail(buy(), 105), buildTradeRail(buy({ current_stop: 96 }), 105), buildTradeRail(buy({ current_stop: 100 }), 105),
      buildTradeRail(buy({ current_stop: 112 }), 120), buildTradeRail(sell(), 160), buildTradeRail(sell(), 160, { profitToRight: false }),
      buildTradeRail(sell({ current_stop: 200 }), 190), buildTradeRail(sell({ current_stop: 190 }), 185),
    ];
    for (const rail of cases) {
      const sorted = [...rail.zones].sort((a, b) => a.from - b.from);
      expect(sorted[0].from).toBeCloseTo(0, 10);
      expect(sorted[sorted.length - 1].to).toBeCloseTo(100, 10);
      for (let i = 1; i < sorted.length; i += 1) expect(sorted[i].from).toBeCloseTo(sorted[i - 1].to, 10);
    }
  });

  it('runner com o stop além do TP2 (caso extremo): o lucro protegido para no TP2 e não sobra alvo', () => {
    const rail = buildTradeRail(buy({ current_stop: 140 }), 150);
    expect(zone(rail, 'locked').to).toBeCloseTo(marker(rail, 'tp2').pos, 10);
    expect(zone(rail, 'reward')).toBeUndefined();
  });

  it('stop PIOR que o inicial (edição manual): nada de "risco eliminado"', () => {
    const rail = buildTradeRail(buy({ current_stop: 85 }), 105);
    expect(zone(rail, 'riskRemoved')).toBeUndefined();
    expect(zone(rail, 'risk')).toBeDefined();
  });
});

describe('layoutRailLabels — nomes sem sobreposição', () => {
  const overlaps = (labels) => {
    for (const a of labels) {
      for (const b of labels) {
        if (a === b || a.row !== b.row) continue;
        if (a.left < b.left + b.width && b.left < a.left + a.width) return true;
      }
    }
    return false;
  };

  it('nomes afastados ficam todos na primeira linha', () => {
    const { rows, labels } = layoutRailLabels([
      { key: 'stop', pos: 0, text: 'Stop' }, { key: 'entry', pos: 25, text: 'Entrada' },
      { key: 'tp1', pos: 62.5, text: 'TP1' }, { key: 'tp2', pos: 100, text: 'TP2' },
    ]);
    expect(rows).toBe(1);
    expect(labels.every((l) => l.row === 0)).toBe(true);
    expect(overlaps(labels)).toBe(false);
  });

  it('nomes colados sobem de linha em vez de se sobrepor', () => {
    const { rows, labels } = layoutRailLabels([
      { key: 'initialStop', pos: 0, text: 'Stop inicial' }, { key: 'entry', pos: 25, text: 'Entrada' },
      { key: 'stop', pos: 27, text: 'Stop 🔒' }, { key: 'tp1', pos: 62.5, text: 'TP1' }, { key: 'tp2', pos: 100, text: 'TP2' },
    ]);
    expect(rows).toBeGreaterThan(1);
    expect(overlaps(labels)).toBe(false);
  });

  it('nome nunca passa das bordas da trilha', () => {
    const { labels } = layoutRailLabels([
      { key: 'a', pos: 0, text: 'Stop inicial' }, { key: 'b', pos: 100, text: 'Stop inicial' }, { key: 'c', pos: 50, text: 'X'.repeat(200) },
    ]);
    for (const l of labels) {
      expect(l.left).toBeGreaterThanOrEqual(0);
      expect(l.left + l.width).toBeLessThanOrEqual(100 + 1e-9);
    }
    expect(labels.find((l) => l.key === 'a').left).toBe(0);
    const right = labels.find((l) => l.key === 'b');
    expect(right.left + right.width).toBeCloseTo(100, 10);
  });

  it('âncora: centrado no marcador, ou encostado na borda quando centrar passaria dela', () => {
    const { labels } = layoutRailLabels([
      { key: 'left', pos: 2, text: 'Stop inicial' }, { key: 'mid', pos: 50, text: 'TP1' }, { key: 'right', pos: 99, text: 'TP2' },
    ]);
    expect(labels.map((l) => l.anchor)).toEqual(['start', 'center', 'end']);
    const mid = labels.find((l) => l.key === 'mid');
    expect(mid.left + mid.width / 2).toBeCloseTo(50, 10);
  });

  it('todos na mesma posição: uma linha para cada, nenhuma sobreposição', () => {
    const { rows, labels } = layoutRailLabels([
      { key: 'a', pos: 50, text: 'Entrada' }, { key: 'b', pos: 50, text: 'Stop (BE)' }, { key: 'c', pos: 50, text: 'TP1' },
    ]);
    expect(rows).toBe(3);
    expect(overlaps(labels)).toBe(false);
  });

  it('independe da ordem de entrada e ignora item sem texto ou sem posição', () => {
    const items = [
      { key: 'tp2', pos: 100, text: 'TP2' }, { key: 'stop', pos: 0, text: 'Stop' }, { key: 'x', pos: NaN, text: 'x' },
      { key: 'y', pos: 10, text: '' }, null,
    ];
    const { labels } = layoutRailLabels(items);
    expect(labels.map((l) => l.key)).toEqual(['stop', 'tp2']);
  });

  it('lista vazia: zero linhas', () => {
    expect(layoutRailLabels([])).toEqual({ rows: 0, labels: [] });
  });
});
