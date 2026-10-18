// @vitest-environment jsdom
//
// Rodada 3b (item 169). Achado ao migrar MonitoredAsset/AssetState para
// rtdbEntities: este componente NUNCA é montado por nenhum teste existente —
// vive dentro de AppLayout.jsx (a casca do app), e
// src/pages/__fixtures__/renderPage.jsx (o harness do smoke test) monta
// páginas isoladas, sem AppLayout em volta. Mesma classe de ponto cego já
// identificada e fechada para GlobalSearch.jsx na auditoria da rodada 3a
// (item 169) — a troca de queryFn aqui tinha zero verificação de render.
//
// Cutover Postgres/Neon (item 2 do runbook): o espelho RTDB foi abandonado
// (decisão explícita do usuário) e `rtdbEntities` reverteu para
// `backend.entities`.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import TickerBar from './TickerBar.jsx';

const assetStateListMock = vi.fn();
const monitoredAssetFilterMock = vi.fn();
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      AssetState: { list: (...args) => assetStateListMock(...args) },
      MonitoredAsset: { filter: (...args) => monitoredAssetFilterMock(...args) },
    },
  },
}));

// Item 279: a faixa só LÊ a variação de 24h do cache — nunca busca.
const { fetch24hStatsMock } = vi.hoisted(() => ({ fetch24hStatsMock: vi.fn(async () => null) }));
vi.mock('@/lib/marketDataProvider', () => ({ fetch24hStats: (...a) => fetch24hStatsMock(...a) }));

afterEach(cleanup);

function renderTicker() {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TickerBar />
    </QueryClientProvider>,
  );
}

describe('TickerBar — AssetState/MonitoredAsset lidos via backend.entities (rodada 3b, item 169; RTDB abandonado no cutover Postgres)', () => {
  it('chama backend.entities.AssetState.list() e backend.entities.MonitoredAsset.filter({is_active:true}) — prova que a wiring está de fato ligada', async () => {
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

  it('mostra o preço e o símbolo do ativo quando o backend devolve estado com last_close', async () => {
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

// Item 279 (PR-D): a faixa dizia "Live" (com ponto pulsando) ao lado do
// fechamento da vela de 1h, e a seta TrendingUp/Down seguia a direção do Range
// Filter — não o movimento do preço. Agora: rótulo do que é, e 📈/📉 só pela
// variação de 24h já carregada (cache dos cartões, sem chamada nova à Binance).
describe('TickerBar — rótulo honesto e 📈/📉 pela variação de 24h (item 279)', () => {
  it('sem "Live" fixo; usa a variação de 24h do cache e não chama a Binance', async () => {
    assetStateListMock.mockResolvedValue([{ asset_id: 'a1', timeframe: '1h', last_close: 100, rf_direction: -1 }]);
    monitoredAssetFilterMock.mockResolvedValue([{ id: 'a1', symbol: 'BTCUSDT' }]);
    const client = makeTestQueryClient();
    render(<QueryClientProvider client={client}><TickerBar /></QueryClientProvider>);
    // Semeia o cache DEPOIS de montar (gcTime 0 no cliente de teste descartaria
    // um dado sem observador) — no app, os cartões mantêm essa chave viva.
    await screen.findAllByText('BTCUSDT');
    act(() => { client.setQueryData(['24h-stats', 'BTCUSDT'], { priceChangePercent: 1.2, lastPrice: 101, closeTime: Date.now() }); });
    expect((await screen.findAllByText('📈 +1.20% 24h')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Live')).toBeNull();
    // Preço do mesmo instante da %, não o fechamento da vela.
    expect(screen.getAllByText('$101.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('fech. 1h')).toBeNull();
    expect(fetch24hStatsMock).not.toHaveBeenCalled();
  });

  it('sem variação no cache: só o preço, sem seta nenhuma', async () => {
    assetStateListMock.mockResolvedValue([{ asset_id: 'a1', timeframe: '1h', last_close: 100, rf_direction: 1 }]);
    monitoredAssetFilterMock.mockResolvedValue([{ id: 'a1', symbol: 'BTCUSDT' }]);
    const { container } = renderTicker();
    await screen.findAllByText('BTCUSDT');
    expect(container.textContent).not.toMatch(/📈|📉/);
    // Sem ticker: o fechamento da vela, identificado como tal.
    expect(screen.getAllByText('fech. 1h').length).toBeGreaterThan(0);
    expect(container.querySelector('svg')).toBeNull(); // sem TrendingUp/Down do Range Filter
  });
});
