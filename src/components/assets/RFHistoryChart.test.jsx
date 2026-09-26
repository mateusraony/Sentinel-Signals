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
//
// Cutover Postgres/Neon (item 2 do runbook): o espelho RTDB foi abandonado
// (decisão explícita do usuário) e `rtdbEntities` reverteu para
// `backend.entities`.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import RFHistoryChart from './RFHistoryChart.jsx';

const filterMock = vi.fn();
vi.mock('@/api/entities', () => ({
  backend: { entities: { SignalEvent: { filter: (...args) => filterMock(...args) } } },
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

// jsdom também não faz layout real: `getBoundingClientRect()` sempre devolve
// 0x0. `ResponsiveContainer` do recharts usa isso pra medir o container ANTES
// do ResizeObserver disparar — com 0x0, o SVG interno nunca ganha dimensão e
// os eixos (achado A-13) não chegam a desenhar ticks, mesmo sem `hide`.
// Necessário só pro teste de eixos abaixo; os outros 3 testes deste arquivo
// não dependem de dimensão real (só checam texto fora do SVG).
const realGetBoundingClientRect = Element.prototype.getBoundingClientRect;

function renderChart(asset) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <RFHistoryChart asset={asset} />
    </QueryClientProvider>,
  );
}

const baseAsset = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', rf_period: 20, rf_multiplier: 3.5 };

describe('RFHistoryChart — SignalEvent lido via backend.entities (item 169; RTDB abandonado no cutover Postgres)', () => {
  it('chama backend.entities.SignalEvent.filter com asset_id/sort/limit exatos — prova que a wiring está de fato ligada', async () => {
    filterMock.mockResolvedValue([]);
    renderChart(baseAsset);
    await screen.findByText(/Histórico Range Filter/i);
    expect(filterMock).toHaveBeenCalledWith({ asset_id: 'a1' }, '-created_date', 60);
  });

  it('renderiza sem explodir com sinais retornados pelo backend', async () => {
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

  it('renderiza sem explodir quando o backend devolve lista vazia (ativo sem sinal recente)', async () => {
    filterMock.mockResolvedValue([]);
    renderChart(baseAsset);
    await screen.findByText(/Histórico Range Filter/i);
    expect(screen.queryByText('BUY')).toBeNull();
  });
});

// Achado A-13 do Raio-X de UI/UX: os dois eixos do gráfico Preço+RF tinham
// `hide`, que faz o CartesianAxis do recharts retornar null — sem escala de
// preço nem intervalo de tempo visíveis, só a tooltip no hover. Este teste
// prova que os dois eixos voltaram a ser renderizados no SVG.
describe('RFHistoryChart — eixos do gráfico Preço+RF visíveis (achado A-13)', () => {
  it('REGRESSÃO: renderiza os grupos SVG de eixo X e Y (antes vinham com hide, sem eixo nenhum)', async () => {
    filterMock.mockResolvedValue([]);
    // eslint-disable-next-line func-names -- precisa de `this` (o elemento) pra decidir a dimensão
    Element.prototype.getBoundingClientRect = function () {
      return { width: 400, height: 180, top: 0, left: 0, bottom: 180, right: 400, x: 0, y: 0, toJSON() {} };
    };
    try {
      const { container } = renderChart(baseAsset);
      await screen.findByText(/Histórico Range Filter/i);

      // O ComposedChart só monta depois que a query de candles (isLoading)
      // resolve — um tick depois do texto do título, que é sempre visível.
      await waitFor(() => {
        expect(container.querySelector('.recharts-xAxis')).not.toBeNull();
        expect(container.querySelector('.recharts-yAxis')).not.toBeNull();
      });
    } finally {
      Element.prototype.getBoundingClientRect = realGetBoundingClientRect;
    }
  });
});

// Achado M-9 do Raio-X de UI/UX (docs/known-risks.md item 222/223/226): o
// gráfico Preço+RF não tinha role="img"/aria-label. Como o nº de candles
// (até DISPLAY_BARS=60) é grande demais pra enumerar num aria-label só
// (mesma lição do achado do Codex review em Backtest.jsx, item 226), o fix
// usa a técnica de resumo curto + tabela `sr-only` linkada via
// aria-describedby.
describe('RFHistoryChart — gráfico Preço+RF tem role="img"/aria-label com resumo e tabela sr-only (achado M-9)', () => {
  it('REGRESSÃO: role=img com resumo (bias/estabilidade) e tabela sr-only com candle a candle', async () => {
    filterMock.mockResolvedValue([]);
    const { container } = renderChart(baseAsset);
    await screen.findByText(/Histórico Range Filter/i);

    const img = await waitFor(() => {
      const el = container.querySelector('[role="img"]');
      expect(el).not.toBeNull();
      return el;
    });

    const label = img.getAttribute('aria-label');
    expect(label).toMatch(/bias/i);
    expect(label).toMatch(/estabilidade/i);
    expect(label).toMatch(/volatilidade/i);
    expect(label).toMatch(/flips de direção/i);

    const tableId = img.getAttribute('aria-describedby');
    expect(tableId).toBeTruthy();
    const table = document.getElementById(tableId);
    expect(table).toBeTruthy();
    expect(table.className).toMatch(/sr-only/);
    expect(table.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
  });
});
