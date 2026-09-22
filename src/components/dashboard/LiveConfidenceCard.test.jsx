// @vitest-environment jsdom
//
// docs/known-risks.md item 186/187 — o card "Confiança ao Vivo" já separava
// por BUY/SELL, mas `market_source` (item 178: 'spot' quando o cron criou a
// operação, 'futures' quando foi o navegador) nunca era consumido em nenhum
// relatório agregado. Este teste cobre a seção nova "Por fonte de dado" e
// prova que ela não regride Geral/BUY/SELL, que já existiam sem teste algum.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import LiveConfidenceCard from './LiveConfidenceCard.jsx';

const listMock = vi.fn();
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      TradeOperation: { list: (...args) => listMock(...args) },
    },
  },
}));

afterEach(() => { cleanup(); listMock.mockReset(); });

// Mesmo mínimo hand-computed de tradeMetrics.test.js's makeOp — só o que
// isClosedOp/summarizeOps precisam para contar a operação; o valor exato de
// R não importa para estes testes (só presença/ausência de linha e rótulo).
function makeOp(overrides = {}) {
  return {
    id: overrides.id ?? 'op',
    side: 'BUY',
    status: 'STOP_HIT',
    entry_price: 100,
    initial_stop: 95,
    current_stop: 95,
    tp1: 107.5,
    tp2: 115,
    tp1_hit: false,
    partial_percent: 50,
    closed_at: '2026-09-20T12:00:00.000Z',
    created_date: '2026-09-20T08:00:00.000Z',
    ...overrides,
  };
}

function renderCard(operations) {
  listMock.mockResolvedValue(operations);
  const client = makeTestQueryClient();
  // ConfidenceRow (pré-existente) já usa <Tooltip> nos badges — em produção
  // isso é fornecido por um TooltipProvider lá em cima (App.jsx/AppLayout.jsx);
  // como este é o 1º teste do componente, precisa do wrapper aqui também.
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <LiveConfidenceCard />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('LiveConfidenceCard — sem operações', () => {
  it('não renderiza nada (comportamento já existente, sem regressão)', () => {
    const { container } = renderCard([]);
    expect(container.firstChild).toBeNull();
  });
});

describe('LiveConfidenceCard — Geral/BUY/SELL continuam aparecendo (não regride)', () => {
  it('mostra as 3 linhas de sempre com operações mistas', async () => {
    renderCard([
      makeOp({ id: 'b1', side: 'BUY', market_source: 'spot' }),
      makeOp({ id: 's1', side: 'SELL', market_source: 'futures' }),
    ]);
    await screen.findByText('Geral');
    screen.getByText('BUY');
    screen.getByText('SELL');
  });
});

describe('LiveConfidenceCard — seção "Por fonte de dado" (item 186/187)', () => {
  it('só Spot: mostra a linha Spot, não mostra Futures nem Sem registro', async () => {
    renderCard([
      makeOp({ id: 'op1', market_source: 'spot' }),
      makeOp({ id: 'op2', market_source: 'spot' }),
    ]);
    await screen.findByText('Por fonte de dado');
    screen.getByText('Spot');
    expect(screen.queryByText('Futures')).toBeNull();
    expect(screen.queryByText('Sem registro')).toBeNull();
  });

  it('Spot e Futures misturados: mostra as duas linhas', async () => {
    renderCard([
      makeOp({ id: 'op1', market_source: 'spot' }),
      makeOp({ id: 'op2', market_source: 'futures' }),
    ]);
    await screen.findByText('Spot');
    screen.getByText('Futures');
    expect(screen.queryByText('Sem registro')).toBeNull();
  });

  it('operação legada (sem market_source) não quebra e cai em "Sem registro"', async () => {
    renderCard([
      makeOp({ id: 'op1', market_source: undefined }),
    ]);
    await screen.findByText('Sem registro');
    expect(screen.queryByText('Spot')).toBeNull();
    expect(screen.queryByText('Futures')).toBeNull();
  });
});
