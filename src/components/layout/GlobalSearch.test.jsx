// @vitest-environment jsdom
//
// Item 169, auditoria pós-merge da rodada 3a. Achado ao auditar: este
// componente NUNCA é montado por nenhum teste existente — vive dentro de
// TopBar.jsx (a casca do app), e src/pages/__fixtures__/renderPage.jsx
// (o harness do smoke test) monta páginas isoladas, sem AppLayout/TopBar em
// volta. A troca de PR #320 (`backend.entities.SignalEvent` →
// `rtdbEntities.SignalEvent`) tinha, portanto, zero verificação de render.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import GlobalSearch from './GlobalSearch.jsx';

const signalListMock = vi.fn();
vi.mock('@/api/rtdbEntities', () => ({
  rtdbEntities: { SignalEvent: { list: (...args) => signalListMock(...args) } },
}));

const monitoredAssetListMock = vi.fn().mockResolvedValue([]);
const tradeOpListMock = vi.fn().mockResolvedValue([]);
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      MonitoredAsset: { list: (...args) => monitoredAssetListMock(...args) },
      TradeOperation: { list: (...args) => tradeOpListMock(...args) },
    },
  },
}));

afterEach(cleanup);

function renderSearch() {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobalSearch />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GlobalSearch — SignalEvent lido via rtdbEntities (item 169)', () => {
  it('chama rtdbEntities.SignalEvent.list("-created_date", 50) — prova que a troca do PR #320 está de fato ligada', async () => {
    signalListMock.mockResolvedValue([]);
    renderSearch();
    // A query dispara em segundo plano mesmo com a busca colapsada
    // (useQuery não depende de showSearch) — não precisa interagir com nada.
    await waitFor(() => expect(signalListMock).toHaveBeenCalledWith('-created_date', 50));
  });

  it('mostra um resultado de sinal vindo do RTDB ao digitar uma busca que casa', async () => {
    signalListMock.mockResolvedValue([
      { id: 's1', symbol: 'BTCUSDT', signal_type: 'BUY', timeframe: '4h', reason: 'teste' },
    ]);
    renderSearch();
    fireEvent.click(screen.getByRole('button', { name: /Buscar ativo ou alerta/i }));
    const input = screen.getByPlaceholderText(/Buscar ativo ou alerta/i);
    fireEvent.change(input, { target: { value: 'BTC' } });
    await screen.findByText('BTC/USDT');
  });
});
