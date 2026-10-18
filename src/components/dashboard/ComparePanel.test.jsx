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

const { fetch24hStatsMock } = vi.hoisted(() => ({ fetch24hStatsMock: vi.fn(async () => null) }));
vi.mock('@/lib/marketDataProvider', () => ({ fetch24hStats: (...a) => fetch24hStatsMock(...a) }));

afterEach(() => { cleanup(); fetch24hStatsMock.mockReset(); fetch24hStatsMock.mockResolvedValue(null); });

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
  it('REGRESSÃO: labels "RSI (1h)"/"MACD Hist"/"EMA Trend" são focáveis (têm tooltip); "RF Valor (4h)" e "Regras" continuam sem', () => {
    renderPanel();
    for (const label of ['RSI (1h)', 'MACD Hist', 'EMA Trend']) {
      // 2 colunas (A/B) — cada uma tem sua própria instância do label.
      const instancias = screen.getAllByText(label).map(el => el.closest('.cursor-help'));
      expect(instancias.every(el => el?.getAttribute('tabindex') === '0')).toBe(true);
      expect(instancias.length).toBe(2);
    }
    for (const label of ['RF Valor (4h)', 'Regras']) {
      const instancias = screen.getAllByText(label).map(el => el.closest('.cursor-help'));
      expect(instancias.every(el => el === null)).toBe(true);
    }
  });
});

// Passo 5 (item 256): "Score" e "Oportunidade" são pontuações das regras, não probabilidade.
describe('ComparePanel — ressalva "score não é probabilidade" (passo 5)', () => {
  it('REGRESSÃO: cada coluna avisa que Score/Oportunidade não são probabilidade de acerto', () => {
    renderPanel({});
    const notes = screen.getAllByText(/Regras alinhadas e Oportunidade são pontuações das regras atuais — não são probabilidade de acerto/);
    expect(notes).toHaveLength(2); // uma por ativo comparado
  });
});


// Item 279 (PR-D): a variação de 24h tem rótulo e fonte, e dado ausente não
// vira "NaN%" nem quebra a coluna.
describe('ComparePanel — variação de 24h com rótulo (item 279)', () => {
  it('mostra "📈 +x% em 24h · Futures" quando há dado', async () => {
    fetch24hStatsMock.mockResolvedValue({ priceChangePercent: 1.5, lastPrice: 101, closeTime: Date.now() });
    renderPanel();
    expect((await screen.findAllByText('📈 +1.50% em 24h · Futures')).length).toBe(2);
  });

  it('dado sem variação válida: "% 24h indisponível", nunca NaN', async () => {
    fetch24hStatsMock.mockResolvedValue({ priceChangePercent: null });
    renderPanel();
    expect((await screen.findAllByText('% 24h indisponível')).length).toBe(2);
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});
