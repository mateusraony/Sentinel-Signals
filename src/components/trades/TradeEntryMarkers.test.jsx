// @vitest-environment jsdom
//
// Achado M-9 do Raio-X de UI/UX (docs/known-risks.md item 222/223/226): o
// gráfico de curva de capital com marcadores de entrada/saída não tinha
// role="img"/aria-label. Como o nº de operações não tem teto (diferente
// dos widgets pequenos do Dashboard), o fix usa a mesma técnica validada
// em Backtest.jsx (item 226): aria-label como resumo curto + tabela
// `sr-only` linkada via aria-details (não aria-describedby — achado do
// Codex review no PR #429, item 228) carregando o dado ponto a ponto.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import TradeEntryMarkers from './TradeEntryMarkers.jsx';

afterEach(cleanup);

// jsdom não implementa ResizeObserver, e o Recharts conta com ele.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const CLOSED_OPS = [
  {
    id: 'op1', symbol: 'BTCUSDT', side: 'BUY', status: 'TP2_HIT',
    entry_price: 60000, initial_stop: 59000, current_stop: 59000, exit_price: 61000,
    created_date: '2026-01-01T00:00:00.000Z', closed_at: '2026-01-03T00:00:00.000Z',
  },
  {
    id: 'op2', symbol: 'ETHUSDT', side: 'SELL', status: 'STOP_HIT',
    entry_price: 3000, initial_stop: 3100, current_stop: 3100, exit_price: 3100,
    created_date: '2026-01-04T00:00:00.000Z', closed_at: '2026-01-05T00:00:00.000Z',
  },
];

describe('TradeEntryMarkers — gráfico tem role="img"/aria-label com resumo e tabela sr-only (achado M-9)', () => {
  it('REGRESSÃO: role=img com resumo (W/L, acumulado) e tabela sr-only com cada entrada/saída', () => {
    const { container } = render(<TradeEntryMarkers history={CLOSED_OPS} />);

    const img = container.querySelector('[role="img"]');
    expect(img).not.toBeNull();
    const label = img.getAttribute('aria-label');
    expect(label).toMatch(/1W/);
    expect(label).toMatch(/1L/);
    expect(label).toMatch(/acumulado/);

    const tableId = img.getAttribute('aria-details');
    expect(tableId).toBeTruthy();
    const table = document.getElementById(tableId);
    expect(table).toBeTruthy();
    expect(table.className).toMatch(/sr-only/);
    expect(table.textContent).toMatch(/BTC\/USDT/);
    expect(table.textContent).toMatch(/ETH\/USDT/);
    // 2 operações → 2 pontos de entrada + 2 de saída = 4 linhas.
    expect(table.querySelectorAll('tbody tr').length).toBe(4);
  });

  it('não renderiza nada (nem o role=img) quando não há histórico válido', () => {
    const { container } = render(<TradeEntryMarkers history={[]} />);
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
