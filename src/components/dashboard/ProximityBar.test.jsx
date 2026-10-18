// @vitest-environment jsdom
//
// Item 256 (passo 6): ProximityBar não tinha teste. `calcProximity` é usado também por
// AssetCard e pela página Assets — os limiares aqui documentam o comportamento REAL do
// código (corte em 3,5%; o comentário antigo dizia 3%).
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ProximityBar, { calcProximity } from './ProximityBar.jsx';

afterEach(cleanup);

// distância % = |close - filtro| / filtro * 100; com filtro 100, close = 100 + distância
const state = (distance, extra = {}) => ({ rf_filter_value: 100, last_close: 100 + distance, rf_direction: 1, ...extra });

describe('calcProximity', () => {
  it('sem estado, sem filtro, sem fechamento ou sem direção: null (nunca inventa proximidade)', () => {
    expect(calcProximity(null)).toBeNull();
    expect(calcProximity(undefined)).toBeNull();
    expect(calcProximity({ last_close: 100, rf_direction: 1 })).toBeNull();
    expect(calcProximity({ rf_filter_value: 100, rf_direction: 1 })).toBeNull();
    expect(calcProximity(state(0.5, { rf_direction: 0 }))).toBeNull();
    expect(calcProximity(state(0.5, { rf_direction: undefined }))).toBeNull();
    expect(calcProximity(state(0.5, { rf_direction: null }))).toBeNull();
  });

  it('faixas: <1% muito próximo, <2% próximo, até 3,5% "perto do gatilho", ≥3,5% nada', () => {
    expect(calcProximity(state(0.99)).level).toBe('very_close');
    expect(calcProximity(state(1)).level).toBe('close');
    expect(calcProximity(state(1.99)).level).toBe('close');
    expect(calcProximity(state(2)).level).toBe('watching');
    expect(calcProximity(state(3.49)).level).toBe('watching');
    expect(calcProximity(state(3.5))).toBeNull();
    expect(calcProximity(state(10))).toBeNull();
  });

  it('lado pela direção do RF e distância em valor absoluto (preço abaixo do filtro também conta)', () => {
    expect(calcProximity(state(0.5)).side).toBe('BUY');
    const sell = calcProximity({ rf_filter_value: 100, last_close: 99.5, rf_direction: -1 });
    expect(sell.side).toBe('SELL');
    expect(sell.distance).toBeCloseTo(0.5, 5);
  });
});

// Item 277 (PR-B): a barra dizia "🔥 MUITO PRÓXIMO ↑ BUY" pulsando — soava como
// sinal de compra iminente. Ela só mede a distância do preço até a linha do
// Range Filter; o lado e o "quase lá" eram leitura nossa, não do motor.
describe('ProximityBar', () => {
  it('não renderiza nada quando não há proximidade', () => {
    const { container } = render(<ProximityBar state={state(5)} />);
    expect(container.firstChild).toBeNull();
  });

  it('mostra só a distância até a linha do filtro, com 📏', () => {
    render(<ProximityBar state={state(0.5)} />);
    expect(screen.getByText(/📏 Distância até a linha do filtro/)).toBeTruthy();
    expect(screen.getByText('0.50%')).toBeTruthy();
    expect(screen.getByText(/não indica sinal próximo/i)).toBeTruthy();
  });

  it('não mostra lado, urgência nem emojis de "quase lá" em nenhuma faixa', () => {
    for (const d of [0.5, 1.5, 2.5]) {
      for (const dir of [1, -1]) {
        const { container, unmount } = render(<ProximityBar state={state(d, { rf_direction: dir })} />);
        const text = container.textContent;
        expect(text).not.toMatch(/BUY|SELL|COMPRA|VENDA|↑|↓/);
        expect(text).not.toMatch(/🔥|⚡|🎯/);
        expect(text).not.toMatch(/PRÓXIMO/); // rótulos antigos em caixa alta
        expect(text).not.toMatch(/gatilho/i);
        unmount();
      }
    }
  });

  it('nenhuma faixa pulsa', () => {
    for (const d of [0.5, 1.5, 2.5]) {
      const { container, unmount } = render(<ProximityBar state={state(d)} />);
      expect(container.querySelector('.prox-pulse')).toBeNull();
      expect(container.innerHTML).not.toMatch(/animation/);
      unmount();
    }
  });
});
