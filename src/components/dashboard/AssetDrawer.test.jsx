// @vitest-environment jsdom
//
// Refinamentos (seção E do Raio-X de UI/UX): a lista "Sinais Recentes" tinha
// campos sem rótulo — timeframe, motivo (reason) e horário relativo
// apareciam nus, sem indicar o que representavam (BUY/SELL e "Confl." já
// eram autoexplicativos, por isso ficaram de fora). Componente não tinha
// teste dedicado antes.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import AssetDrawer from './AssetDrawer.jsx';

vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));

const ASSET = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', exchange: 'binance' };

const SIGNAL = {
  id: 'sig1', asset_id: 'a1', signal_type: 'BUY', timeframe: '4h',
  price_at_signal: 65000, reason: 'Confluência de RF + estrutura SMC',
  created_date: '2026-09-26T10:00:00.000Z',
};

afterEach(() => cleanup());

function renderDrawer(props) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AssetDrawer
        asset={ASSET}
        signals={[SIGNAL]}
        tradeOps={[]}
        onClose={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('AssetDrawer — "Sinais Recentes" tem rótulos inline (Refinamentos)', () => {
  it('REGRESSÃO: timeframe, motivo e horário aparecem rotulados, não nus', async () => {
    renderDrawer({});

    await screen.findByText('BTC/USDT');
    expect(screen.getByText('TF')).toBeTruthy();
    expect(screen.getByText(/Motivo:/)).toBeTruthy();
    expect(screen.getByText(/Quando:/)).toBeTruthy();
    // O conteúdo original continua presente, só ganhou o prefixo.
    expect(screen.getByText('4H')).toBeTruthy();
    expect(screen.getByText(/Confluência de RF \+ estrutura SMC/)).toBeTruthy();
  });
});
