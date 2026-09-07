// @vitest-environment jsdom
//
// Item 169, auditoria pós-merge da rodada 3a (pedido do usuário: confirmar
// que a 3a está "blindada" antes de seguir pra 3b). Achado ao auditar: este
// componente NUNCA é montado por src/pages/pagesSmoke.test.jsx — vive dentro
// de AssetDetailPanel.jsx, que faz `if (!expanded) return null`, e o smoke
// test nunca expande nenhuma linha. É a MESMA classe de ponto cego que o
// próprio smoke test existe para pegar (item 157, componente que só
// renderiza com dado nunca é exercitado) — só que ela não cobre este caso
// porque a lacuna está um nível ACIMA da página (dentro de um painel
// colapsável), não na própria página. A troca de PR #320
// (`backend.entities.SignalEvent` → `rtdbEntities.SignalEvent`) tinha,
// portanto, zero verificação de render — só a lógica pura de
// `rtdbEntities.js` estava coberta.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import RFHistoryChart from './RFHistoryChart.jsx';

const filterMock = vi.fn();
vi.mock('@/api/rtdbEntities', () => ({
  rtdbEntities: { SignalEvent: { filter: (...args) => filterMock(...args) } },
}));

vi.mock('@/lib/marketDataProvider', () => ({
  fetchCandles: vi.fn().mockResolvedValue(
    Array.from({ length: 80 }, (_, i) => ({
      closeTime: Date.now() - (80 - i) * 3600_000,
      close: 60000 + i * 10,
      high: 60000 + i * 10 + 5,
      low: 60000 + i * 10 - 5,
      open: 60000 + i * 10 - 2,
      isClosed: true,
    })),
  ),
}));

afterEach(cleanup);

// jsdom não implementa ResizeObserver, e recharts (usado no gráfico do RF)
// conta com ele — mesma lacuna e mesmo polyfill de pagesSmoke.test.jsx.
// Precisa ser repetido aqui porque cada arquivo de teste do Vitest tem seu
// próprio registro de módulos/globais.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

function renderChart(asset) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <RFHistoryChart asset={asset} />
    </QueryClientProvider>,
  );
}

const baseAsset = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', rf_period: 20, rf_multiplier: 3.5 };

describe('RFHistoryChart — SignalEvent lido via rtdbEntities (item 169)', () => {
  it('chama rtdbEntities.SignalEvent.filter com asset_id/sort/limit exatos — prova que a troca do PR #320 está de fato ligada', async () => {
    filterMock.mockResolvedValue([]);
    renderChart(baseAsset);
    await screen.findByText(/Histórico Range Filter/i);
    expect(filterMock).toHaveBeenCalledWith({ asset_id: 'a1' }, '-created_date', 60);
  });

  it('renderiza sem explodir com sinais retornados pelo RTDB', async () => {
    filterMock.mockResolvedValue([
      {
        id: 's1', asset_id: 'a1', created_date: new Date().toISOString(),
        context: { rf_value: 60050, rf_direction: 1 }, price_at_signal: 60040,
        signal_type: 'BUY', timeframe: '4h',
      },
    ]);
    renderChart(baseAsset);
    await screen.findByText('BUY');
  });

  it('renderiza sem explodir quando o RTDB devolve lista vazia (ativo sem sinal recente)', async () => {
    filterMock.mockResolvedValue([]);
    renderChart(baseAsset);
    await screen.findByText(/Histórico Range Filter/i);
    expect(screen.queryByText('BUY')).toBeNull();
  });
});
