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
import { screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
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

// Achados M-4/M-13/M-15 do Raio-X de UI/UX (reorganização do Dashboard,
// docs/known-risks.md item 236/237): a seção "Desempenho" (WeeklySummary +
// os 4 cards de performance + Correlação) fica colapsada por padrão; o
// grupo "Atenção" (VerificationWidget + StatsCard Alta Prioridade/
// Aguardando) vem antes da grade de "Ativos"; TelegramStatusBanner sai da
// 4ª posição e vai para o fim da página.
describe('Dashboard — reorganização em grupos (achados M-4/M-13/M-15)', () => {
  it('REGRESSÃO: a seção "Desempenho" fica escondida por padrão (CSS `hidden`) e revela ao clicar', async () => {
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);

    await screen.findByText('Ativos');
    const toggle = screen.getByRole('button', { name: /desempenho/i });
    // Achado do Codex review no PR #435: o conteúdo fica sempre MONTADO
    // (só escondido via classe `hidden`), não desmontado por render
    // condicional — CorrelationWidget tem state próprio (símbolos
    // selecionados) que se perderia a cada desmonte/remonte.
    const contentWrapper = toggle.nextElementSibling;
    expect(contentWrapper.className).toMatch(/\bhidden\b/);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(contentWrapper.className).not.toMatch(/\bhidden\b/);
    await screen.findByText('Resumo da Semana');
  });

  it('REGRESSÃO: colapsar/expandir "Desempenho" NÃO desmonta o CorrelationWidget (achado do Codex review no PR #435)', async () => {
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);

    await screen.findByText('Ativos');
    const correlationHeadingBefore = await screen.findByText('Correlação de Preço');
    const toggle = screen.getByRole('button', { name: /desempenho/i });

    fireEvent.click(toggle); // expande
    fireEvent.click(toggle); // colapsa de novo

    const correlationHeadingAfter = screen.getByText('Correlação de Preço');
    // Mesmo nó de DOM antes/depois — nunca foi desmontado, então o state
    // interno do CorrelationWidget (símbolos selecionados) não se perde.
    expect(correlationHeadingAfter).toBe(correlationHeadingBefore);
  });

  it('REGRESSÃO: "Atenção" vem depois de "Agora" e antes de "Ativos" no DOM', async () => {
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);

    const agora = await screen.findByText('Agora');
    const atencao = await screen.findByText('Atenção');
    const ativos = await screen.findByText('Ativos');

    expect(agora.compareDocumentPosition(atencao) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(atencao.compareDocumentPosition(ativos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('REGRESSÃO: TelegramStatusBanner aparece depois da grade de "Ativos" no DOM (achado M-15)', async () => {
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);

    const ativos = await screen.findByText('Ativos');
    const telegram = await screen.findByText(/Telegram não configurado/);

    const position = ativos.compareDocumentPosition(telegram);
    if (!(position & Node.DOCUMENT_POSITION_FOLLOWING)) {
      throw new Error('TelegramStatusBanner deveria vir DEPOIS de "Ativos" no DOM');
    }
  });
});
