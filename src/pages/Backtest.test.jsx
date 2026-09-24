// @vitest-environment jsdom
//
// Achado A-6 do Raio-X de UI/UX (docs/claude/ui-audit-criticos.md): a
// tabela "Por cascata" e o botão "Aplicar ao Scanner" usavam o atributo
// HTML nativo `title=` — tooltip feio do navegador, não acionável por
// teclado nem por leitor de tela. Este teste prova o fix: os cabeçalhos
// "Expectância"/"Profit Factor" viraram gatilhos de `Tooltip` (Radix,
// focáveis via `tabIndex`), e o botão "Aplicar ao Scanner" (que fica
// `disabled` sem `reproducibility.pineConfig` no relatório — eventos de
// mouse não chegam a um `<button disabled>` nativo) ganhou um wrapper
// focável em volta pra carregar o tooltip.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';
import { renderPage, makeFakeBackendModule } from './__fixtures__/renderPage.jsx';
import Backtest from './Backtest.jsx';

vi.mock('@/api/entities', () => makeFakeBackendModule({ populated: false }));
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));
vi.mock('@/lib/AuthContext', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({ user: { uid: 'teste' }, role: 'admin', loading: false }),
}));
vi.mock('@/lib/marketDataProvider', () => ({
  fetchCandles: async () => [],
  fetchCurrentPrice: async () => null,
  fetch24hStats: async () => null,
  MARKET_SOURCE: 'spot',
  DATA_EXCHANGE: 'binance',
  EXECUTOR: 'browser',
}));

afterEach(() => cleanup());

// jsdom não implementa ResizeObserver, e o relatório carregado renderiza
// gráficos recharts (mesma lacuna e mesmo polyfill de pagesSmoke.test.jsx).
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const CASCADE_STATS = {
  total: 5, counted: 5, unknown: 0, wins: 3, losses: 2, be: 0,
  winRate: 60, totalPnlPct: 6, avgWinPct: 3, avgLossPct: -2,
  avgWinR: 1.5, avgLossR: -1, expectancyR: 0.3, rCounted: 5,
  profitFactor: 1.8, maxDrawdownPct: 3, totalCostPct: 0.5,
  avgCostR: 0.02, grossExpectancyR: 0.32, expectancyRStdErr: 0.1,
  expectancyRCI95: [0.1, 0.5], expectancyRSd: 0.3,
  expectancyRCI95HalfWidth: 0.2, conclusive: false,
  inconclusiveReason: 'sample_too_small', minTrades: 30, curve: [],
};

// Sem `reproducibility.pineConfig` de propósito — é o estado que deixa o
// botão "Aplicar ao Scanner" desabilitado (o caso do title condicional).
const REPORT_JSON = JSON.stringify({
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
  overall: { ...CASCADE_STATS, total: 10, counted: 10, wins: 6, losses: 4 },
  byCascade: { '4h_15m': CASCADE_STATS },
  costs: { model: {} },
});

async function loadReport() {
  renderPage(<Backtest />);
  fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));
  const textarea = await screen.findByPlaceholderText(/"range":/);
  fireEvent.change(textarea, { target: { value: REPORT_JSON } });
  fireEvent.click(screen.getByText(/Analisar relatório colado/i));
  await screen.findByText('Expectância');
}

describe('Backtest — tabela "Por cascata" usa Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: cabeçalhos Expectância/Profit Factor não têm title= nativo, viram gatilho focável', async () => {
    await loadReport();

    // "Profit Factor" também aparece num SummaryCard fora da tabela — escopar
    // a busca só nos <th> da tabela "Por cascata" evita ambiguidade.
    const headers = await screen.findAllByRole('columnheader');
    const expectanciaHeader = headers.find(h => h.textContent.trim() === 'Expectância');
    const profitFactorHeader = headers.find(h => h.textContent.trim() === 'Profit Factor');
    expect(expectanciaHeader).toBeTruthy();
    expect(profitFactorHeader).toBeTruthy();

    // O <th> em volta não pode mais carregar o title= nativo.
    expect(expectanciaHeader.getAttribute('title')).toBeNull();
    expect(profitFactorHeader.getAttribute('title')).toBeNull();

    // O gatilho do Tooltip dentro do <th> precisa ser focável (tabIndex=0)
    // — é o que torna o conteúdo acessível por teclado, ao contrário do
    // title= nativo.
    const expectanciaTrigger = expectanciaHeader.querySelector('[tabindex="0"]');
    const profitFactorTrigger = profitFactorHeader.querySelector('[tabindex="0"]');
    expect(expectanciaTrigger).toBeTruthy();
    expect(profitFactorTrigger).toBeTruthy();
  });
});

describe('Backtest — botão "Aplicar ao Scanner" desabilitado usa Tooltip em vez de title= (achado A-6)', () => {
  it('REGRESSÃO: sem reproducibility.pineConfig, o botão não tem title= nativo e ganha wrapper focável', async () => {
    await loadReport();

    const applyButton = screen.getByText('Aplicar ao Scanner').closest('button');
    expect(applyButton.getAttribute('title')).toBeNull();
    expect(applyButton.disabled).toBe(true);

    // O wrapper que carrega o Tooltip (span tabIndex=0) precisa envolver o
    // botão — sem ele, o tooltip nunca dispararia (eventos de mouse não
    // chegam a um <button disabled> nativo).
    const wrapper = applyButton.closest('span[tabindex="0"]');
    expect(wrapper).not.toBeNull();
  });
});
