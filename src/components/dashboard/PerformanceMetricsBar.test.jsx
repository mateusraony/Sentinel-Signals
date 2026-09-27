// @vitest-environment jsdom
//
// Round 4 da nova varredura pós-Raio-X (2026-09-27): Win Rate passou a usar
// a faixa de 2 níveis/50% compartilhada (src/lib/metricColorRanges.js),
// substituindo os 3 níveis (45/60%) que só existiam neste componente —
// decisão explícita do usuário, pra convergir com o resto do app. Arquivo
// não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import PerformanceMetricsBar from './PerformanceMetricsBar.jsx';

const listMock = vi.fn();
vi.mock('@/api/entities', () => ({
  backend: { entities: { TradeOperation: { list: (...args) => listMock(...args) } } },
}));

afterEach(() => { cleanup(); listMock.mockReset(); });

function makeOp(id, { win }) {
  return {
    id, side: 'BUY', status: win ? 'TP2_HIT' : 'STOP_HIT',
    entry_price: 100, initial_stop: 95, current_stop: 95,
    tp1: 107.5, tp2: 115, exit_price: win ? 110 : 90,
    closed_at: '2026-09-20T12:00:00.000Z', created_date: '2026-09-20T08:00:00.000Z',
  };
}

function renderBar(operations) {
  listMock.mockResolvedValue(operations);
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <PerformanceMetricsBar />
    </QueryClientProvider>,
  );
}

describe('PerformanceMetricsBar — Win Rate usa a faixa de 2 níveis/50% compartilhada (Round 4 pós-Raio-X)', () => {
  it('REGRESSÃO: winRate=50% fica verde (antes ficava âmbar na faixa 45-60% própria deste componente)', async () => {
    const ops = [
      ...[1, 2, 3, 4].map(i => makeOp(`w${i}`, { win: true })),
      ...[1, 2, 3, 4].map(i => makeOp(`l${i}`, { win: false })),
    ];
    renderBar(ops);
    const wrValue = await screen.findByText('50%');
    expect(wrValue.style.color).toBe('rgb(0, 255, 128)');
  });

  it('winRate=40% (abaixo de 50%) continua laranja', async () => {
    const ops = [
      ...[1, 2].map(i => makeOp(`w${i}`, { win: true })),
      ...[1, 2, 3].map(i => makeOp(`l${i}`, { win: false })),
    ];
    renderBar(ops);
    const wrValue = await screen.findByText('40%');
    expect(wrValue.style.color).toBe('rgb(255, 159, 67)');
  });
});
