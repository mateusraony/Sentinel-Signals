// @vitest-environment jsdom
//
// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 2ª sub-rodada): o `<select>` "Analisando:" usava `outline-none` sem
// substituto visível de foco — mesmo achado/fix já aplicado em
// TriggerBacktestPanel.jsx (1ª sub-rodada).
//
// Achado M-9 (Média Prioridade): o gráfico de barras "Taxa de acerto por
// faixa de score" não tinha role="img"/aria-label.
//
// Componente não tinha teste dedicado antes do achado A-7.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import PredictiveAnalysis from './PredictiveAnalysis.jsx';

const tradeOperationFilterMock = vi.fn(async () => []);
vi.mock('@/api/entities', () => ({
  backend: { entities: { TradeOperation: { filter: (...args) => tradeOperationFilterMock(...args) } } },
}));

// Recharts' ResponsiveContainer exige ResizeObserver em runtime — jsdom
// não implementa, mesmo polyfill já usado em Dashboard.test.jsx.
beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  tradeOperationFilterMock.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

const SIGNAL = {
  id: 'sig1', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h',
  signal_type: 'BUY', source: 'range_filter', priority: 'high',
  created_date: new Date().toISOString(), context: { score: 80 },
};

function renderPredictive(props) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <PredictiveAnalysis recentSignals={[SIGNAL]} {...props} />
    </QueryClientProvider>,
  );
}

describe('PredictiveAnalysis — select "Analisando:" tem foco visível (achado A-7)', () => {
  it('REGRESSÃO: select tem focus-visible:ring', async () => {
    renderPredictive();
    const select = await screen.findByDisplayValue(/BTC\/USDT/);
    expect(select.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });
});

const CLOSED_OP_SIMILAR_SHAPE = {
  id: 'op1', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY', signal_timeframe: '4h',
  status: 'STOP_HIT', entry_price: 100, initial_stop: 90, current_stop: 90,
  tp1: 110, tp2: 120, exit_price: 90, closed_at: new Date().toISOString(),
  partial_percent: 50, created_date: new Date().toISOString(), entry_score: 75,
};

describe('PredictiveAnalysis — gráfico "Taxa de acerto por faixa de score" tem role="img"/aria-label (achado M-9)', () => {
  it('REGRESSÃO: o wrapper do BarChart tem role="img" e aria-label descritivo', async () => {
    tradeOperationFilterMock.mockResolvedValue([CLOSED_OP_SIMILAR_SHAPE]);
    renderPredictive();
    const heading = await screen.findByText(/Taxa de acerto por faixa de score/);
    const chart = heading.nextElementSibling;
    expect(chart.getAttribute('role')).toBe('img');
    expect(chart.getAttribute('aria-label')).toMatch(/Gráfico de barras da taxa de acerto por faixa de score/);
  });

  // Achado do Codex review no PR #426: role="img" transforma o gráfico
  // inteiro num "black box" pra leitor de tela — o aria-label anterior só
  // citava a contagem de faixas, sem expor o dado real (label/winRate/n de
  // cada faixa), que ficava inacessível por trás do role="img".
  it('REGRESSÃO: o aria-label expõe o dado de cada faixa (rótulo, taxa de acerto, nº de operações)', async () => {
    tradeOperationFilterMock.mockResolvedValue([CLOSED_OP_SIMILAR_SHAPE]);
    renderPredictive();
    const heading = await screen.findByText(/Taxa de acerto por faixa de score/);
    const chart = heading.nextElementSibling;
    const label = chart.getAttribute('aria-label');
    expect(label).toMatch(/60-80/);
    expect(label).toMatch(/0% de acerto/);
    expect(label).toMatch(/1 operação/);
  });
});
