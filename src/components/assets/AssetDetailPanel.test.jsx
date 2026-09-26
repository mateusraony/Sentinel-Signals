// @vitest-environment jsdom
//
// Achado M-17 do Raio-X de UI/UX (glossário de termos técnicos, item 229):
// RSI/MACD/EMA apareciam "nus" (sem tooltip) em 2 lugares deste componente —
// o mini-grid de 3 colunas do `TFStateCard` (estado por timeframe) e os
// `ParamCard` de "RSI Period"/"RSI OB/OS"/"MACD"/"EMA" (parâmetros do RF).
// Componente não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import AssetDetailPanel from './AssetDetailPanel.jsx';

vi.mock('@/api/entities', () => ({
  backend: { entities: { SignalEvent: { filter: async () => [] } } },
}));
vi.mock('@/lib/marketDataProvider', () => ({
  fetchCandles: vi.fn().mockResolvedValue([]),
}));

afterEach(cleanup);

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const ASSET = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', rf_period: 20, rf_multiplier: 3.5 };
const STATE_1H = {
  timeframe: '1h', rf_direction: 1, rsi_zone: 'neutral', rsi_value: 55,
  macd_histogram: 0.5, trend_ema: 'bullish', rf_filter_value: 60000, rf_low_band: 59500, rf_high_band: 60500, last_close: 60000,
};

function renderPanel(props) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AssetDetailPanel asset={ASSET} states={[STATE_1H]} expanded onToggle={() => {}} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('AssetDetailPanel — RSI/MACD/EMA têm tooltip explicando o termo (achado M-17)', () => {
  it('REGRESSÃO: mini-grid "Estado por Timeframe" — RSI/MACD/EMA são focáveis (têm tooltip)', () => {
    renderPanel();
    const rsi = screen.getAllByText('RSI')[0].closest('[tabindex="0"]');
    const macd = screen.getAllByText('MACD')[0].closest('[tabindex="0"]');
    const ema = screen.getAllByText('EMA')[0].closest('[tabindex="0"]');
    expect(rsi).not.toBeNull();
    expect(macd).not.toBeNull();
    expect(ema).not.toBeNull();
  });

  it('REGRESSÃO: ParamCard "RSI Period"/"RSI OB/OS"/"MACD"/"EMA" são focáveis (têm tooltip); "RF Period" continua sem tooltip', () => {
    renderPanel();
    expect(screen.getByText('RSI Period').getAttribute('tabindex')).toBe('0');
    expect(screen.getByText('RSI OB/OS').getAttribute('tabindex')).toBe('0');
    // "MACD"/"EMA" aparecem 2x (ParamCard + mini-grid) — pega o ParamCard (label em uppercase tracking-wider).
    const macdParam = screen.getAllByText('MACD').find(el => el.className.includes('uppercase'));
    const emaParam = screen.getAllByText('EMA').find(el => el.className.includes('uppercase'));
    expect(macdParam?.getAttribute('tabindex')).toBe('0');
    expect(emaParam?.getAttribute('tabindex')).toBe('0');
    // "RF Period"/"RF Mult" não fazem parte do achado M-17 (já contextualizados pelo header da seção) — continuam sem tooltip.
    expect(screen.getByText('RF Period').getAttribute('tabindex')).toBeNull();
  });
});
