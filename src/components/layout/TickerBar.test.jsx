// @vitest-environment jsdom
//
// Rodada 3b (item 169). Achado ao migrar MonitoredAsset/AssetState para
// rtdbEntities: este componente NUNCA é montado por nenhum teste existente —
// vive dentro de AppLayout.jsx (a casca do app), e
// src/pages/__fixtures__/renderPage.jsx (o harness do smoke test) monta
// páginas isoladas, sem AppLayout em volta. Mesma classe de ponto cego já
// identificada e fechada para GlobalSearch.jsx na auditoria da rodada 3a
// (item 169) — a troca de queryFn aqui tinha zero verificação de render.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import TickerBar from './TickerBar.jsx';

const assetStateListMock = vi.fn();
const monitoredAssetFilterMock = vi.fn();
vi.mock('@/api/rtdbEntities', () => ({
  rtdbEntities: {
    AssetState: { list: (...args) => assetStateListMock(...args) },
    MonitoredAsset: { filter: (...args) => monitoredAssetFilterMock(...args) },
  },
}));

afterEach(cleanup);

function renderTicker() {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TickerBar />
    </QueryClientProvider>,
  );
}

describe('TickerBar — AssetState/MonitoredAsset lidos via rtdbEntities (rodada 3b, item 169)', () => {
  it('chama rtdbEntities.AssetState.list() e rtdbEntities.MonitoredAsset.filter({is_active:true}) — prova que a wiring está de fato ligada', async () => {
    assetStateListMock.mockResolvedValue([]);
    monitoredAssetFilterMock.mockResolvedValue([]);
    renderTicker();
    await vi.waitFor(() => {
      expect(assetStateListMock).toHaveBeenCalledWith();
      expect(monitoredAssetFilterMock).toHaveBeenCalledWith({ is_active: true });
    });
  });

  it('renderiza nada (null) quando não há estado com last_close (sem quebrar)', async () => {
    assetStateListMock.mockResolvedValue([]);
    monitoredAssetFilterMock.mockResolvedValue([
      { id: 'a1', symbol: 'BTCUSDT' },
    ]);
    const { container } = renderTicker();
    await vi.waitFor(() => expect(monitoredAssetFilterMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('mostra o preço e o símbolo do ativo quando o RTDB devolve estado com last_close', async () => {
    assetStateListMock.mockResolvedValue([
      { id: 's1', asset_id: 'a1', timeframe: '1h', last_close: 60123.45, rf_direction: 1 },
    ]);
    monitoredAssetFilterMock.mockResolvedValue([
      { id: 'a1', symbol: 'BTCUSDT' },
    ]);
    renderTicker();
    // O item aparece 2x no DOM de propósito (`doubled`, loop visual sem costura).
    await vi.waitFor(async () => expect((await screen.findAllByText('BTCUSDT')).length).toBe(2));
    expect(screen.getAllByText((_, el) => el.textContent === '$60,123.45').length).toBeGreaterThan(0);
  });
});
