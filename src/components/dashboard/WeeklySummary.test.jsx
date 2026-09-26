// @vitest-environment jsdom
//
// Achado M-3 do Raio-X de UI/UX (Média Prioridade): os rótulos de dia da
// semana no mini-gráfico "P&L por dia" usavam só a 1ª letra (`l[0]`) —
// Segunda, Sexta e Sábado colidem em "S", tornando o gráfico ilegível sem
// contar as barras manualmente.
//
// Achado M-1: os 3 cards de stat não liam `isLoading` de nenhuma das 2
// queries — os defaults `[]` faziam "+0.00%"/0 aparecerem como se fossem
// resultado real por 1-2s antes do fetch responder.
//
// Achado M-2: "Sinais Processados" contava sinal de qualquer `source`, não
// só `range_filter` — inconsistente com buySignals/sellSignals do
// Dashboard, que só contam Range Filter.
//
// Componente não tinha teste dedicado antes do achado M-3.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import WeeklySummary from './WeeklySummary.jsx';

const listOpsMock = vi.fn(async () => []);
const listSignalsMock = vi.fn(async () => []);
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      TradeOperation: { list: (...args) => listOpsMock(...args) },
      SignalEvent: { list: (...args) => listSignalsMock(...args) },
    },
  },
}));

// Recharts' ResponsiveContainer (usado no mini-gráfico "P&L por dia") exige
// ResizeObserver em runtime — jsdom não implementa, mesmo polyfill já usado
// em Dashboard.test.jsx.
beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  listOpsMock.mockReset().mockResolvedValue([]);
  listSignalsMock.mockReset().mockResolvedValue([]);
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

function statValueFor(label) {
  return screen.getByText(label).closest('.flex').nextElementSibling;
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

describe('WeeklySummary — estado de carregamento explícito (achado M-1)', () => {
  it('REGRESSÃO: enquanto carrega, os 3 cards mostram "···", não "+0.00%"/0', () => {
    listOpsMock.mockReturnValue(new Promise(() => {})); // nunca resolve
    listSignalsMock.mockReturnValue(new Promise(() => {}));
    renderWidget();

    expect(statValueFor('P&L Semana').textContent).toBe('···');
    expect(statValueFor('Taxa de Acerto').textContent).toBe('···');
    expect(statValueFor('Sinais Processados').textContent).toBe('···');
  });
});

describe('WeeklySummary — "Sinais Processados" só conta Range Filter (achado M-2)', () => {
  it('REGRESSÃO: sinais de outras fontes (ex. SMC) não entram na contagem', async () => {
    const agora = new Date().toISOString();
    listSignalsMock.mockResolvedValue([
      { id: 's1', source: 'range_filter', created_date: agora },
      { id: 's2', source: 'range_filter', created_date: agora },
      { id: 's3', source: 'smc', created_date: agora },
    ]);
    renderWidget();

    const valueEl = statValueFor('Sinais Processados');
    await waitFor(() => expect(valueEl.textContent).toBe('2'));
  });
});

describe('WeeklySummary — gráfico "P&L por dia" tem role="img"/aria-label (achado M-9)', () => {
  it('REGRESSÃO: o wrapper do BarChart tem role="img" e aria-label descritivo', async () => {
    listOpsMock.mockResolvedValue([]);
    listSignalsMock.mockResolvedValue([]);
    const { container } = renderWidget();
    await waitFor(() => {
      const chart = container.querySelector('[role="img"]');
      expect(chart.getAttribute('aria-label')).toMatch(/no total/);
    });
  });

  // Achado do Codex review no PR #426: o aria-label lia `data.totalPnl`
  // direto (default 0 enquanto as 2 queries carregam), sem o guard de
  // `isLoading` que o card visível já usa (achado M-1) — leitor de tela
  // anunciava "+0.00% no total" como se fosse resultado real.
  it('REGRESSÃO: enquanto carrega, o aria-label não anuncia "+0.00%" (achado do Codex review)', () => {
    listOpsMock.mockReturnValue(new Promise(() => {})); // nunca resolve
    listSignalsMock.mockReturnValue(new Promise(() => {}));
    const { container } = renderWidget();
    const chart = container.querySelector('[role="img"]');
    expect(chart.getAttribute('aria-label')).not.toMatch(/0\.00%/);
    expect(chart.getAttribute('aria-label')).toMatch(/carregando/);
  });
});
