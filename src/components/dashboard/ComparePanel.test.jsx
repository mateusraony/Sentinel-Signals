// @vitest-environment jsdom
//
// Achado M-17 do Raio-X de UI/UX (glossário de termos técnicos): RSI/MACD/
// EMA são termos técnicos "nus" no grid de indicadores de cada coluna —
// `MetricRow` ganhou prop opcional `tooltip` (mesmo padrão de `ParamCard`/
// `SummaryCard`). Arquivo não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import ComparePanel from './ComparePanel.jsx';

vi.mock('@/lib/marketDataProvider', () => ({ fetch24hStats: async () => null }));

afterEach(() => cleanup());

const ASSET_A = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' };
const ASSET_B = { id: 'a2', symbol: 'ETHUSDT', display_name: 'ETH/USDT' };
const STATES = [{ timeframe: '1h', rf_direction: 1, rsi_value: 55, rsi_zone: 'neutral', macd_histogram: 0.5, trend_ema: 'bullish', last_close: 100 }];

function renderPanel(props) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ComparePanel assetA={ASSET_A} assetB={ASSET_B} statesA={STATES} statesB={STATES} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('ComparePanel — RSI/MACD/EMA têm tooltip explicando o termo (achado M-17)', () => {
  it('REGRESSÃO: labels "RSI (1h)"/"MACD Hist"/"EMA Trend" são focáveis (têm tooltip); "RF Valor (4h)" e "Score" continuam sem', () => {
    renderPanel();
    for (const label of ['RSI (1h)', 'MACD Hist', 'EMA Trend']) {
      // 2 colunas (A/B) — cada uma tem sua própria instância do label.
      const instancias = screen.getAllByText(label).map(el => el.closest('.cursor-help'));
      expect(instancias.every(el => el?.getAttribute('tabindex') === '0')).toBe(true);
      expect(instancias.length).toBe(2);
    }
    for (const label of ['RF Valor (4h)', 'Score']) {
      const instancias = screen.getAllByText(label).map(el => el.closest('.cursor-help'));
      expect(instancias.every(el => el === null)).toBe(true);
    }
  });
});
