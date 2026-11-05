// @vitest-environment jsdom
//
// Item 293: "Como terminaram" (aba Histórico). O que se prova na TELA: uma linha por tipo de saída com rótulo em texto + contagem + percentual (cor nunca
// sozinha), barra proporcional, dica focável (Tooltip), nada renderizado sem operação fechada, e percentual pequeno que não vira "0%".
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import OutcomeBreakdown from './OutcomeBreakdown.jsx';

afterEach(cleanup);

const T = '2026-11-01T12:00:00Z';
const base = { side: 'BUY', entry_price: 100, initial_stop: 95, tp1: 107.5, tp2: 115, partial_percent: 50, created_date: T, closed_at: T };
const TP2 = { ...base, status: 'TP2_HIT', tp1_hit: true, tp1_hit_price: 107.5, exit_price: 115 };
const STOP_LOSS = { ...base, status: 'STOP_HIT', exit_price: 95 };
const TIME_STOP = { ...base, status: 'CLOSED', closed_reason: 'TIME_STOP', exit_price: 101 };

const renderOps = (ops) => render(<TooltipProvider><OutcomeBreakdown ops={ops} /></TooltipProvider>);
const linhas = () => within(screen.getByRole('group', { name: 'Como terminaram' })).getAllByRole('listitem');

describe('OutcomeBreakdown', () => {
  it('uma linha por tipo de saída, na ordem fixa, com rótulo, contagem e percentual', () => {
    renderOps([STOP_LOSS, TP2, STOP_LOSS, TIME_STOP]);
    expect(linhas().map((li) => li.textContent)).toEqual([
      'Alvo final (TP2)1 (25%)',
      'Stop com perda2 (50%)',
      'Tempo esgotado1 (25%)',
    ]);
    expect(screen.getByText('(4 trades fechados)')).toBeTruthy();
  });

  it('a barra é proporcional ao percentual e usa a cor da categoria', () => {
    renderOps([STOP_LOSS, TP2, STOP_LOSS, STOP_LOSS]);
    const perda = screen.getByTestId('outcome-bar-stop_loss');
    expect(parseFloat(perda.style.width)).toBeCloseTo(75, 6);
    expect(perda.getAttribute('style')).toMatch(/#ff1478|rgb\(255, 20, 120\)/i);
    const alvo = screen.getByTestId('outcome-bar-tp2');
    expect(parseFloat(alvo.style.width)).toBeCloseTo(25, 6);
    expect(alvo.getAttribute('style')).toMatch(/#00ff80|rgb\(0, 255, 128\)/i);
  });

  it('o rótulo é um gatilho focável com a explicação (Tooltip), não só cor', () => {
    renderOps([STOP_LOSS]);
    const rotulo = screen.getByText('Stop com perda');
    expect(rotulo.getAttribute('tabindex')).toBe('0');
    expect(rotulo.closest('.cursor-help')).not.toBeNull();
  });

  it('parcela abaixo de 1% aparece como "<1%", nunca "0%"', () => {
    const muitas = Array.from({ length: 300 }, () => STOP_LOSS);
    renderOps([TP2, ...muitas]);
    const alvo = linhas().find((li) => li.textContent.startsWith('Alvo final'));
    expect(alvo.textContent).toBe('Alvo final (TP2)1 (<1%)');
    expect(alvo.textContent).not.toMatch(/\(0%\)/);
  });

  it('sem operação fechada (ou com lixo/abertas), não renderiza nada', () => {
    for (const ops of [[], null, undefined, [{ ...base, status: 'RUNNER_ACTIVE' }, null, 7]]) {
      const { container, unmount } = renderOps(ops);
      expect(container.innerHTML).toBe('');
      unmount();
    }
  });
});
