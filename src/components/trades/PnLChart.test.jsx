// @vitest-environment jsdom
//
// Achado M-9 do Raio-X de UI/UX (docs/known-risks.md item 222/223/226): o
// gráfico de performance acumulada não tinha role="img"/aria-label. Como o
// nº de trades não tem teto, o fix usa a técnica validada em Backtest.jsx
// (item 226): aria-label como resumo curto + tabela `sr-only` linkada via
// aria-details (não aria-describedby — achado do Codex review no PR #429,
// item 228) carregando o dado ponto a ponto.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import PnLChart from './PnLChart.jsx';

afterEach(cleanup);

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const CLOSED_OPS = [
  {
    id: 'op1', symbol: 'BTCUSDT', side: 'BUY', timeframe: '4h', status: 'TP2_HIT',
    entry_price: 60000, initial_stop: 59000, current_stop: 59000, exit_price: 61000,
    created_date: '2026-01-01T00:00:00.000Z', closed_at: '2026-01-03T00:00:00.000Z',
  },
  {
    id: 'op2', symbol: 'ETHUSDT', side: 'SELL', timeframe: '1h', status: 'STOP_HIT',
    entry_price: 3000, initial_stop: 3100, current_stop: 3100, exit_price: 3100,
    created_date: '2026-01-04T00:00:00.000Z', closed_at: '2026-01-05T00:00:00.000Z',
  },
];

describe('PnLChart — gráfico tem role="img"/aria-label com resumo e tabela sr-only (achado M-9)', () => {
  it('REGRESSÃO: role=img com resumo (nº trades, W/L, acumulado) e tabela sr-only com cada trade', () => {
    const { container } = render(<PnLChart history={CLOSED_OPS} />);

    const img = container.querySelector('[role="img"]');
    expect(img).not.toBeNull();
    const label = img.getAttribute('aria-label');
    expect(label).toMatch(/2 trades/);
    expect(label).toMatch(/1W/);
    expect(label).toMatch(/1L/);

    const tableId = img.getAttribute('aria-details');
    expect(tableId).toBeTruthy();
    const table = document.getElementById(tableId);
    expect(table).toBeTruthy();
    expect(table.className).toMatch(/sr-only/);
    expect(table.textContent).toMatch(/BTC\/USDT/);
    expect(table.textContent).toMatch(/ETH\/USDT/);
    expect(table.querySelectorAll('tbody tr').length).toBe(2);
  });

  it('não renderiza role=img quando não há histórico suficiente (mensagem de "sem dados")', () => {
    const { container } = render(<PnLChart history={[]} />);
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(screen.getByText(/Sem histórico suficiente/i)).toBeTruthy();
  });
});
