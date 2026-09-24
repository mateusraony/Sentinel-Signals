// @vitest-environment jsdom
//
// Achado A-14 do Raio-X de UI/UX (docs/claude/ui-audit-criticos.md):
// `RecentAlertsList` vivia como a ÚLTIMA seção da página, depois do grid
// inteiro de "Ativos" e de todos os gráficos de performance — sem link pra
// ver mais. Este teste prova a parte 1 do fix (reordenação de JSX):
// "Alertas Recentes" agora vem ANTES da seção "Ativos" no DOM, não depois.
import React from 'react';
import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';

vi.mock('@/api/entities', async () => {
  const { makeFakeBackendModule } = await import('./__fixtures__/renderPage.jsx');
  return { get backend() { return makeFakeBackendModule({ populated: false }).backend; } };
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

afterEach(() => cleanup());

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
