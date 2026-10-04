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
import { screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';

let priorityOverride = null;
// Cenário do painel lateral (Codex #461): sobrescreve ativos/estados/sinais/ops e
// registra as chamadas de `TradeOperation.filter` com status ativo.
let drawerScenario = null;
const activeOpsCalls = [];

vi.mock('@/api/entities', async () => {
  const { makeFakeBackendModule } = await import('./__fixtures__/renderPage.jsx');
  return {
    get backend() {
      const fake = makeFakeBackendModule({ populated: false }).backend;
      if (priorityOverride) {
        fake.entities.SignalEvent.list = async () => priorityOverride.signalEvents ?? [];
        fake.entities.TradeOperation.list = async () => priorityOverride.tradeOps ?? [];
      }
      if (drawerScenario) {
        const sc = drawerScenario;
        fake.entities.MonitoredAsset.filter = async () => sc.assets();
        fake.entities.AssetState.list = async () => sc.states ?? [];
        fake.entities.SignalEvent.list = async () => sc.signals ?? [];
        fake.entities.TradeOperation.list = async () => sc.recentOps ?? [];
        fake.entities.TradeOperation.filter = async (q) => {
          if (Array.isArray(q?.status) && q.status.includes('RUNNER_ACTIVE')) {
            activeOpsCalls.push(q);
            if (sc.activeOpsError) throw new Error('falha simulada');
            return sc.activeOps ?? [];
          }
          return [];
        };
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
  drawerScenario = null;
  activeOpsCalls.length = 0;
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

// Achado da varredura pós-Raio-X, Round 3 (2026-09-27): com zero ativos
// monitorados, o empty state só tinha texto ("Vá em 'Ativos'...") sem
// nenhum link — arquivo inteiro não importava Link. Componente não tinha
// teste dedicado a esse empty state antes.
describe('Dashboard — empty state de "Nenhum ativo monitorado" tem link pra /assets (Round 3 pós-Raio-X)', () => {
  it('REGRESSÃO: "Ativos" dentro do texto do empty state é um link pra /assets', async () => {
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);

    await screen.findByText('Nenhum ativo monitorado.');
    const link = screen.getByRole('link', { name: /Ir para Ativos/ });
    expect(link.getAttribute('href')).toBe('/assets');
  });
});

// Codex no PR #461 (docs/known-risks.md item 256): o painel lateral recebia só as
// 100 operações mais recentes, um retrato do ativo e um relógio parado.
describe('Dashboard — painel lateral do ativo (Codex #461)', () => {
  const MIN = 60 * 1000;
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const ASSET = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', exchange: 'binance', is_active: true };
  const OLD_ACTIVE_OP = {
    id: 'op-antiga', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY', timeframe: '15m', signal_timeframe: '4h',
    status: 'RUNNER_ACTIVE', entry_price: 100, initial_stop: 95, current_stop: 98.5,
    tp1: 105, tp2: 112.5, rr_at_entry: 1.5, score: 80, created_date: '2026-01-01T00:00:00.000Z',
  };
  const FRESH_SIGNAL = {
    id: 'sig1', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
    source: 'range_filter', created_date: iso(30 * MIN),
  };

  async function openDrawer() {
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: /BTC\/USDT — abrir detalhes/ }, { timeout: 5000 }));
    return screen.findByRole('region', { name: 'Resumo da decisão' }, { timeout: 5000 });
  }

  it('REGRESSÃO (P1): operação ativa fora das 100 mais recentes aparece com stop e alvos', async () => {
    drawerScenario = {
      assets: () => [{ ...ASSET, last_scan_at: iso(5 * MIN) }],
      signals: [FRESH_SIGNAL],
      recentOps: [], // a lista de 100 NÃO contém a op ativa
      activeOps: [OLD_ACTIVE_OP],
    };
    const region = await openDrawer();
    await waitFor(() => expect(within(region).getByText('Runner ativo (TP1 atingido)')).toBeTruthy(), { timeout: 5000 });
    expect(within(region).queryByText(/Aguardando/)).toBeNull();
    expect(within(region).getByText(/98[.,]5/)).toBeTruthy(); // stop atual
    expect(within(region).getByText(/112[.,]5/)).toBeTruthy(); // TP2
  });

  it('REGRESSÃO (P2): monitored-assets renovado com o painel aberto muda o badge', async () => {
    let lastScan = iso(45 * MIN); // começa parado → STALE
    drawerScenario = {
      assets: () => [{ ...ASSET, last_scan_at: lastScan }],
      signals: [FRESH_SIGNAL],
      activeOps: [],
    };
    const { default: Dashboard } = await import('./Dashboard.jsx');
    const { queryClient } = renderPage(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: /BTC\/USDT — abrir detalhes/ }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', undefined, { timeout: 5000 });
    await waitFor(() => expect(within(dialog).getByText('STALE')).toBeTruthy(), { timeout: 5000 });

    lastScan = iso(1 * MIN); // o scan voltou: o próximo poll traz last_scan_at novo
    await queryClient.invalidateQueries({ queryKey: ['monitored-assets'] });
    await waitFor(() => expect(within(dialog).getByText('LIVE')).toBeTruthy(), { timeout: 5000 });
    expect(within(dialog).queryByText('STALE')).toBeNull();
  });

  it('REGRESSÃO: falha na query de ativas → mensagem fail-closed, nunca "aguardando"', async () => {
    drawerScenario = {
      assets: () => [{ ...ASSET, last_scan_at: iso(5 * MIN) }],
      signals: [FRESH_SIGNAL],
      activeOpsError: true,
    };
    const region = await openDrawer();
    await waitFor(() => expect(within(region).getByText(/Não foi possível carregar as operações agora/)).toBeTruthy(), { timeout: 5000 });
    expect(within(region).queryByText(/Aguardando/)).toBeNull();
  });

  it('a query de ativas roda sempre (com o painel fechado também) — as contagens dependem dela', async () => {
    drawerScenario = {
      assets: () => [{ ...ASSET, last_scan_at: iso(5 * MIN) }],
      signals: [FRESH_SIGNAL],
      activeOps: [],
    };
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);
    await screen.findByRole('button', { name: /BTC\/USDT — abrir detalhes/ }, { timeout: 5000 });
    await waitFor(() => expect(activeOpsCalls.length).toBeGreaterThan(0), { timeout: 5000 });
  });
});

// Achado do item 256 (2026-10-04): as contagens do Dashboard decidiam "tem operação
// ativa?" só pelas 100 operações mais recentes. Uma ativa mais antiga sumia.
describe('Dashboard — contagens com operação ativa fora das 100 mais recentes (item 256)', () => {
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const ASSET = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', exchange: 'binance', is_active: true, last_scan_at: iso(5 * 60 * 1000) };
  const RF_SIGNAL = {
    id: 'sig1', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
    source: 'range_filter', created_date: iso(30 * 60 * 1000),
  };
  const OLD_ACTIVE_OP = {
    id: 'op-antiga', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY', timeframe: '15m', signal_timeframe: '4h',
    status: 'RUNNER_ACTIVE', entry_price: 100, initial_stop: 95, current_stop: 98.5,
    tp1: 105, tp2: 112.5, rr_at_entry: 1.5, score: 90, created_date: '2026-01-01T00:00:00.000Z',
  };
  const valueOf = async (label) => (await screen.findByText(label)).nextElementSibling;

  it('REGRESSÃO: "Operações Ativas" conta a operação antiga e "Aguardando" não conta o ativo', async () => {
    drawerScenario = { assets: () => [ASSET], signals: [RF_SIGNAL], recentOps: [], activeOps: [OLD_ACTIVE_OP] };
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);
    await waitFor(() => expect(screen.getByText('Operações Ativas').nextElementSibling.textContent).toBe('1'), { timeout: 5000 });
    expect((await valueOf('Aguardando')).textContent).toBe('0');
    // score 90 ≥ 85 → também entra em "Alta Prioridade"
    expect((await valueOf('Alta Prioridade')).textContent).toBe('1');
  });

  it('falha na consulta de ativas: os números não afirmam nada (fail-closed)', async () => {
    drawerScenario = { assets: () => [ASSET], signals: [RF_SIGNAL], recentOps: [], activeOpsError: true };
    const { default: Dashboard } = await import('./Dashboard.jsx');
    renderPage(<Dashboard />);
    await waitFor(() => expect(screen.getByText('Operações Ativas').nextElementSibling.textContent).toBe('—'), { timeout: 5000 });
    expect((await valueOf('Aguardando')).textContent).toBe('—');
  });
});
