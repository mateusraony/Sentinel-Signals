// @vitest-environment jsdom
//
// Resumo de agora da aba Trades (item 304): os QUATRO números e os textos continuam exatamente os de sempre; em 21/11/2026
// só o desenho mudou (cartões planos, de larguras diferentes, sem ícone). Os testes provam o conteúdo e que nada sumiu.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import TradesNowSummary from './TradesNowSummary.jsx';

afterEach(cleanup);

const ACTIVE = { total: 2, protectedCount: 1, zeroCount: 0, riskCount: 1, unknownCount: 0, stopSumR: -0.2 };
const CLOSED = { total: 47, wins: 24, be: 1, losses: 22 };

const renderSummary = (props = {}) => render(
  <TooltipProvider>
    <TradesNowSummary active={ACTIVE} analysisCount={4} closed={CLOSED} {...props} />
  </TooltipProvider>,
);

describe('TradesNowSummary — conteúdo (nada sumiu)', () => {
  it('mostra os 4 rótulos e os números de sempre', () => {
    renderSummary();
    const grupo = screen.getByRole('group', { name: 'Resumo de agora' });
    for (const rotulo of ['Operações ativas', 'Se todas baterem no stop', 'Avisos em análise', 'Fechadas']) {
      expect(grupo.textContent).toContain(rotulo);
    }
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('47')).toBeTruthy();
    expect(screen.getByText('24 ganhos · 1 empates · 22 perdas')).toBeTruthy();
  });

  it('com filtros ligados os rótulos dizem "(com os filtros)"', () => {
    renderSummary({ filtered: true });
    expect(screen.getByText('Operações ativas (com os filtros)')).toBeTruthy();
    expect(screen.getByText('Fechadas (com os filtros)')).toBeTruthy();
  });

  it('sem operação aberta diz isso, e sem fechadas também', () => {
    renderSummary({ active: { ...ACTIVE, total: 0, protectedCount: 0, riskCount: 0, stopSumR: null }, closed: { total: 0, wins: 0, be: 0, losses: 0 }, analysisCount: 0 });
    expect(screen.getByText('sem operação aberta')).toBeTruthy();
    expect(screen.getByText('nenhuma no período')).toBeTruthy();
    expect(screen.getByText('nenhum agora')).toBeTruthy();
  });

  it('a soma no stop aparece em R com sinal, e vermelha quando negativa', () => {
    renderSummary();
    const valor = screen.getByText(/0[.,]20R/);
    expect(valor.style.color).toBe('rgb(224, 106, 91)');
  });
});

describe('TradesNowSummary — desenho novo (21/11/2026)', () => {
  it('cartões planos, sem ícone e de larguras diferentes numa grade de 12 colunas', () => {
    const { container } = renderSummary();
    const grade = screen.getByRole('group', { name: 'Resumo de agora' });
    expect(grade.className).toMatch(/lg:grid-cols-12/);
    expect(container.querySelector('svg')).toBeNull();
    const larguras = Array.from(grade.children).map((el) => el.className.match(/lg:col-span-(\d+)/)?.[1]);
    expect(larguras).toEqual(['4', '3', '2', '3']);
  });
});
