// @vitest-environment jsdom
//
// Achado A-2 do Raio-X de UI/UX (docs/claude/ui-audit-criticos.md):
// `candleOpen` subtraía 1h fixo de `last_candle_time` (que é o FECHAMENTO
// do candle) pra estimar a ABERTURA — correto só pro timeframe 1h. Pra 4h/
// 1d, mostrava uma janela de candle errada (ex.: um candle 4h aparecia
// como se tivesse durado só 1h). Este teste prova o fix: a duração
// subtraída agora depende do timeframe do estado exibido.
import React from 'react';
import { describe, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import AssetCard from './AssetCard.jsx';

vi.mock('@/lib/marketDataProvider', () => ({
  fetch24hStats: async () => null,
  fetchMarkPrice: async () => ({ markPrice: null, lastFundingRate: null, nextFundingTime: null }),
}));
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));

afterEach(() => cleanup());

function renderCard(props) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AssetCard asset={{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }} {...props} />
    </QueryClientProvider>,
  );
}

// Fechamento em horário redondo (UTC) pra tornar a subtração fácil de
// conferir de cabeça depois de aplicar utcOffset(-3) (BRT).
const CLOSE_4H_UTC = '2026-09-24T16:00:00.000Z'; // 13:00 BRT

describe('AssetCard — horário de abertura do candle (achado A-2)', () => {
  it('candle 4h: abertura é fechamento - 4h, não - 1h', () => {
    renderCard({
      states: [{ timeframe: '4h', last_candle_time: CLOSE_4H_UTC, last_close: 60000 }],
    });
    // Fechamento 13:00 BRT, candle 4h -> abertura 09:00 BRT.
    screen.getByText(/09:00 → 13:00 BRT/);
  });

  it('candle 1h: continua correto (abertura = fechamento - 1h)', () => {
    renderCard({
      states: [{ timeframe: '1h', last_candle_time: CLOSE_4H_UTC, last_close: 60000 }],
    });
    screen.getByText(/12:00 → 13:00 BRT/);
  });

  it('candle 1d: abertura é fechamento - 24h', () => {
    renderCard({
      states: [{ timeframe: '1d', last_candle_time: CLOSE_4H_UTC, last_close: 60000 }],
    });
    // Fechamento 24/09 13:00 BRT, candle 1d -> abertura 23/09 13:00 BRT.
    screen.getByText(/23\/09 13:00 → 13:00 BRT/);
  });
});
