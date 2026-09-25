// @vitest-environment jsdom
//
// Achado A-14 do Raio-X de UI/UX (docs/claude/ui-audit-criticos.md):
// `RecentAlertsList` vivia como a ÚLTIMA seção da página, depois do grid
// inteiro de "Ativos" e de todos os gráficos de performance — sem link pra
// ver mais. Este teste prova a parte 1 do fix (reordenação de JSX):
// "Alertas Recentes" agora vem ANTES da seção "Ativos" no DOM, não depois.
//
// Achado M-16 (Média Prioridade): o StatsCard "Alta Prioridade" recebia
// `color="#ff9f43"` (laranja de atenção) fixo, independente de
// `highPriorityCount` — mesmo com 0 sinais/operações de alta prioridade, o
// card continuava na cor de alerta. `priorityOverride` abaixo permite cada
// teste controlar `SignalEvent`/`TradeOperation` sem afetar os demais.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, waitFor } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';

let priorityOverride = null;

vi.mock('@/api/entities', async () => {
  const { makeFakeBackendModule } = await import('./__fixtures__/renderPage.jsx');
  return {
    get backend() {
      const fake = makeFakeBackendModule({ populated: false }).backend;
      if (priorityOverride) {
        fake.entities.SignalEvent.list = async () => priorityOverride.signalEvents ?? [];
        fake.entities.TradeOperation.list = async () => priorityOverride.tradeOps ?? [];
      }
      return fake;
    },
  };
});
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));
vi.mock('@/lib/AuthContext', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({ user: { uid: 'teste' }, role: 'admin', loading: false }),
}));
vi.mock('@/lib/marketDataProvider', () => ({
  fetchCandles: async () => [],
  fetchCurrentPrice: async () => null,
  fetch24hStats: async () => null,
  fetchMarkPrice: async () => ({ markPrice: null, lastFundingRate: null, nextFundingTime: null }),
  MARKET_SOURCE: 'spot',
  DATA_EXCHANGE: 'binance',
  EXECUTOR: 'browser',
}));

beforeEach(() => {
  window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(() => {
  cleanup();
  priorityOverride = null;
});

describe('Dashboard — "Alertas Recentes" aparece antes do grid de Ativos (achado A-14)', () => {
  it('REGRESSÃO: a seção de alertas recentes precede a seção de Ativos no DOM', async () => {
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);

    const alertsHeading = await screen.findByText('Alertas Recentes');
    const assetsHeading = await screen.findByText('Ativos');

    const position = alertsHeading.compareDocumentPosition(assetsHeading);
    if (!(position & Node.DOCUMENT_POSITION_FOLLOWING)) {
      throw new Error('"Alertas Recentes" deveria vir ANTES de "Ativos" no DOM');
    }
  });
});

describe('Dashboard — cor do StatsCard "Alta Prioridade" reflete a contagem (achado M-16)', () => {
  it('REGRESSÃO: com highPriorityCount = 0, o card NÃO usa a cor de atenção fixa', async () => {
    priorityOverride = { signalEvents: [], tradeOps: [] };
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);

    const label = await screen.findByText('Alta Prioridade');
    const numberEl = label.nextElementSibling;
    await waitFor(() => expect(numberEl.style.color).toBe('rgb(0, 229, 255)'));
  });

  it('com highPriorityCount > 0, o card usa a cor de atenção', async () => {
    priorityOverride = {
      signalEvents: [{
        id: 'sig-alta', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h',
        signal_type: 'BUY', source: 'range_filter', priority: 'high',
        created_date: new Date().toISOString(),
      }],
      tradeOps: [],
    };
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);

    const label = await screen.findByText('Alta Prioridade');
    const numberEl = label.nextElementSibling;
    await waitFor(() => expect(numberEl.style.color).toBe('rgb(255, 159, 67)'));
  });
});
