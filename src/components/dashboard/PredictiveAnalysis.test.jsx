// @vitest-environment jsdom
//
// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 2ª sub-rodada): o `<select>` "Analisando:" usava `outline-none` sem
// substituto visível de foco — mesmo achado/fix já aplicado em
// TriggerBacktestPanel.jsx (1ª sub-rodada). Componente não tinha teste
// dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import PredictiveAnalysis from './PredictiveAnalysis.jsx';

vi.mock('@/api/entities', () => ({
  backend: { entities: { TradeOperation: { filter: vi.fn(async () => []) } } },
}));

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
