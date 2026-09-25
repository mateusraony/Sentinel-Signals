// @vitest-environment jsdom
//
// Achado M-3 do Raio-X de UI/UX (Média Prioridade): os rótulos de dia da
// semana no mini-gráfico "P&L por dia" usavam só a 1ª letra (`l[0]`) —
// Segunda, Sexta e Sábado colidem em "S", tornando o gráfico ilegível sem
// contar as barras manualmente. Componente não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import WeeklySummary from './WeeklySummary.jsx';

vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      TradeOperation: { list: vi.fn(async () => []) },
      SignalEvent: { list: vi.fn(async () => []) },
    },
  },
}));

// Recharts' ResponsiveContainer (usado no mini-gráfico "P&L por dia") exige
// ResizeObserver em runtime — jsdom não implementa, mesmo polyfill já usado
// em Dashboard.test.jsx.
beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(cleanup);

function renderWidget() {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <WeeklySummary />
    </QueryClientProvider>,
  );
}

describe('WeeklySummary — rótulos de dia sem colisão (achado M-3)', () => {
  it('REGRESSÃO: os 7 rótulos de dia são todos distintos (não colapsam em "S")', () => {
    const { container } = renderWidget();
    const labelNodes = container.querySelectorAll('.grid.grid-cols-7 span');
    expect(labelNodes.length).toBe(7);
    const labels = Array.from(labelNodes).map(n => n.textContent);
    expect(new Set(labels).size).toBe(7);
    expect(labels).toEqual(['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']);
  });
});
