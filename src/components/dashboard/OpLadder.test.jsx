// @vitest-environment jsdom
//
// Régua da operação (21/11/2026): Stop → Entrada → TP1 → TP2 numa linha, com o preço atual e o stop atual marcados.
// Só visual — usa campos que a operação já tem. Estes testes provam a GEOMETRIA (compra e venda iguais: risco à
// esquerda, alvo à direita) e os casos em que a régua não deve aparecer.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import OpLadder from './OpLadder.jsx';
import { formatPrice } from '@/lib/priceProximity';

afterEach(cleanup);

const BUY_OP = { entry_price: 100, initial_stop: 90, current_stop: 90, tp1: 110, tp2: 120 };
const SELL_OP = { entry_price: 100, initial_stop: 105, current_stop: 105, tp1: 90, tp2: 80 };

const renderLadder = (op, price, tooltips = {}) =>
  render(<TooltipProvider><OpLadder op={op} price={price} tooltips={tooltips} /></TooltipProvider>);

// posição (left em %) do marcador que contém o rótulo
const leftOf = (label) => {
  const marker = screen.getByText(label, { exact: false }).closest('[style*="translateX(-50%)"]');
  return parseFloat(marker.style.left);
};

describe('OpLadder — geometria', () => {
  it('compra: Stop em 0%, Entrada a 1/3, TP1 a 2/3 e TP2 em 100% (risco à esquerda, alvo à direita)', () => {
    renderLadder(BUY_OP, 105);
    expect(leftOf('Stop')).toBe(0);
    expect(leftOf('Entrada')).toBeCloseTo(33.33, 1);
    expect(leftOf('TP1')).toBeCloseTo(66.67, 1);
    expect(leftOf('TP2')).toBe(100);
  });

  it('venda tem a MESMA geometria da compra (a posição é (valor − stop) / (tp2 − stop))', () => {
    renderLadder(SELL_OP, 95);
    expect(leftOf('Stop')).toBe(0);
    expect(leftOf('Entrada')).toBeCloseTo(20, 1);
    expect(leftOf('TP1')).toBeCloseTo(60, 1);
    expect(leftOf('TP2')).toBe(100);
  });

  it('mostra os preços formatados sob cada marcador', () => {
    renderLadder(BUY_OP, 105);
    for (const v of [90, 100, 110, 120]) expect(screen.getByText(formatPrice(v))).toBeTruthy();
  });
});

describe('OpLadder — stop atual, TP1 realizado e dicas', () => {
  it('"Stop atual" só aparece quando o stop já andou', () => {
    const { unmount } = renderLadder(BUY_OP, 105);
    expect(screen.queryByText(/Stop atual/)).toBeNull();
    unmount();
    renderLadder({ ...BUY_OP, current_stop: 100 }, 105);
    expect(screen.getByText(new RegExp(`Stop atual ${formatPrice(100).replace('.', '\\.')}`))).toBeTruthy();
  });

  it('TP1 já realizado ganha o ✓', () => {
    renderLadder({ ...BUY_OP, tp1_hit: true }, 112);
    expect(screen.getByText(/TP1 ✓/)).toBeTruthy();
  });

  it('TP1/TP2 com dica são focáveis por teclado; Entrada e Stop não viram gatilho de dica (achado M-17)', () => {
    renderLadder(BUY_OP, 105, { TP1: 'explica o TP1', TP2: 'explica o TP2' });
    expect(screen.getByText('TP1').closest('.cursor-help')?.getAttribute('tabindex')).toBe('0');
    expect(screen.getByText('TP2').closest('.cursor-help')?.getAttribute('tabindex')).toBe('0');
    expect(screen.getByText('Entrada').closest('.cursor-help')).toBeNull();
    expect(screen.getByText('Stop').closest('.cursor-help')).toBeNull();
  });
});

describe('OpLadder — preço atual e casos sem régua', () => {
  it('sem preço atual não desenha o marcador do preço (e não quebra)', () => {
    const { container } = renderLadder(BUY_OP, undefined);
    expect(container.querySelector('[style*="border-top: 10px solid"]')).toBeNull();
    expect(screen.getByText('Entrada')).toBeTruthy();
  });

  it('com preço atual desenha o marcador, verde no lucro e vermelho no prejuízo', () => {
    const lucro = renderLadder(BUY_OP, 105);
    expect(lucro.container.querySelector('[style*="border-top: 10px solid"]').style.borderTop).toMatch(/93, 181, 134|#5db586/i);
    lucro.unmount();
    const prejuizo = renderLadder(BUY_OP, 95);
    expect(prejuizo.container.querySelector('[style*="border-top: 10px solid"]').style.borderTop).toMatch(/224, 106, 91|#e06a5b/i);
  });

  it('não renderiza nada com dados que não permitem a régua (stop = alvo, ou campos ausentes)', () => {
    expect(renderLadder({ ...BUY_OP, initial_stop: 120 }, 105).container.firstChild).toBeNull();
    cleanup();
    expect(renderLadder({ entry_price: 100 }, 105).container.firstChild).toBeNull();
  });

  it('tem rótulo acessível descrevendo a régua', () => {
    renderLadder(BUY_OP, 105);
    expect(document.querySelector('[aria-label^="Régua da operação"]')).toBeTruthy();
  });
});
