// @vitest-environment jsdom
//
// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 2ª sub-rodada): o `<select>` de mês usava `outline-none` sem
// substituto visível de foco — mesmo achado/fix já aplicado em
// TriggerBacktestPanel.jsx (1ª sub-rodada). Página não tinha teste
// dedicado antes.
import React from 'react';
import moment from 'moment';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';
import MonthlyReport from './MonthlyReport.jsx';

// Mock controlável (padrão já usado em PredictiveAnalysis.test.jsx) — o
// default (`[]`) cobre o teste de A-7 abaixo (nenhuma operação no mês), e o
// describe de M-9 troca o retorno pra exercitar os 3 gráficos com dado real.
const tradeOperationFilterMock = vi.fn(async () => []);
vi.mock('@/api/entities', () => ({
  backend: { entities: { TradeOperation: { filter: (...args) => tradeOperationFilterMock(...args) } } },
}));

afterEach(() => {
  cleanup();
  tradeOperationFilterMock.mockReset();
  tradeOperationFilterMock.mockImplementation(async () => []);
});

describe('MonthlyReport — select de mês tem foco visível (achado A-7)', () => {
  it('REGRESSÃO: select tem focus-visible:ring', async () => {
    const { container } = renderPage(<MonthlyReport />);
    await screen.findByText('Resumo Mensal');
    const select = container.querySelector('select');
    expect(select).toBeTruthy();
    expect(select.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });
});

// Achado M-9 do Raio-X de UI/UX (docs/known-risks.md item 222/223, sub-rodada
// B): os 3 gráficos Recharts desta página (evolução de P&L, taxa de acerto,
// distribuição de status) não tinham `role="img"`/`aria-label` —
// ResponsiveContainer não repassa esses atributos pro <div> interno
// (confirmado lendo node_modules/recharts), daí o wrapper <div> em volta é
// quem carrega o role/aria-label. O aria-label cita os dados subjacentes
// (não só uma contagem genérica) — lição do achado do Codex review no PR
// #426 (M-9 sub-rodada A).
// jsdom não implementa ResizeObserver, e os gráficos recharts precisam dele
// pra medir o container (mesma lacuna/polyfill de Backtest.test.jsx).
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const CLOSED_OPS_M9 = [
  {
    id: 'op1', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY',
    status: 'TP2_HIT', entry_price: 60000, initial_stop: 59000, current_stop: 59000,
    tp1: 60500, tp2: 61000, exit_price: 61000,
    tp2_hit_at: moment().subtract(1, 'day').toISOString(),
    closed_at: moment().subtract(1, 'day').toISOString(),
    created_date: moment().subtract(1, 'day').toISOString(),
  },
  {
    id: 'op2', asset_id: 'a2', symbol: 'ETHUSDT', side: 'SELL',
    status: 'STOP_HIT', entry_price: 3000, initial_stop: 3100, current_stop: 3100,
    tp1: 2900, tp2: 2800, exit_price: 3100,
    stop_hit_at: moment().toISOString(),
    closed_at: moment().toISOString(),
    created_date: moment().toISOString(),
  },
];

describe('MonthlyReport — gráficos Recharts têm role="img"/aria-label descrevendo os dados (achado M-9)', () => {
  it('REGRESSÃO: os 3 gráficos (evolução de P&L, taxa de acerto, distribuição de status) expõem role=img com aria-label com dados', async () => {
    tradeOperationFilterMock.mockImplementation(async () => CLOSED_OPS_M9);
    renderPage(<MonthlyReport />);
    await screen.findByText('Evolução de P&L (acumulado + diário)');

    const images = await screen.findAllByRole('img');
    const labels = images.map(el => el.getAttribute('aria-label')).filter(Boolean);

    expect(labels.some(l => l.includes('evolução de P&L diário e acumulado no mês') && l.includes('2 dias'))).toBe(true);
    expect(labels.some(l => l.includes('taxa de acerto do mês') && l.includes('Vitórias 1') && l.includes('Derrotas 1'))).toBe(true);
    expect(labels.some(l => l.includes('distribuição de status') && l.includes('🏆 TP2 1') && l.includes('🛑 Stop 1'))).toBe(true);
  });
});
