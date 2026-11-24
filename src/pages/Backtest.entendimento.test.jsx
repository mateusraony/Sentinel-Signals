// @vitest-environment jsdom
//
// 22/11/2026 — Backtest refeito (estrutura + entendimento): a leitura em português do resultado ("O que este resultado diz"), a nota de cada aba, o
// resumo do período, o "padrão X" nos controles do what-if, o glossário do funil e o "o que muda" no diálogo de aplicar ao scanner.
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderPage, makeFakeBackendModule } from './__fixtures__/renderPage.jsx';

const opsListMock = vi.fn();
const getPineConfigMock = vi.fn();
let pineStatus = { source: 'postgres', degraded: false };

vi.mock('@/api/entities', async () => {
  const mod = makeFakeBackendModule({ populated: false });
  const base = mod.backend;
  return { backend: { ...base, entities: { ...base.entities, TradeOperation: { ...base.entities.TradeOperation, list: (...a) => opsListMock(...a) } } } };
});
vi.mock('@/lib/pineParser', async (importOriginal) => ({
  ...(await importOriginal()),
  getPineConfig: (...a) => getPineConfigMock(...a),
  getPineConfigStatus: () => pineStatus,
}));
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));
vi.mock('@/lib/AuthContext', () => ({ AuthProvider: ({ children }) => children, useAuth: () => ({ user: { uid: 't' }, role: 'admin', loading: false }) }));
vi.mock('@/lib/marketDataProvider', () => ({ fetchCandles: async () => [], fetchCurrentPrice: async () => null, fetch24hStats: async () => null, MARKET_SOURCE: 'spot', DATA_EXCHANGE: 'binance', EXECUTOR: 'browser' }));
vi.mock('@/lib/apiBackend', () => ({ callBackend: vi.fn(async () => ({ status: 'in_progress' })) }));

import Backtest from './Backtest.jsx';
import { DEFAULTS } from '@/lib/pineParser';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => {
  opsListMock.mockReset(); opsListMock.mockResolvedValue([]);
  getPineConfigMock.mockReset(); getPineConfigMock.mockResolvedValue({ ...DEFAULTS });
  pineStatus = { source: 'postgres', degraded: false };
});
afterEach(() => cleanup());

const STATS = {
  total: 10, counted: 10, unknown: 0, wins: 6, losses: 4, be: 0, winRate: 60, totalPnlPct: 6, avgWinPct: 3, avgLossPct: -2, avgWinR: 1.5, avgLossR: -1,
  expectancyR: 0.3, rCounted: 10, profitFactor: 1.8, maxDrawdownPct: 3, totalCostPct: 0.5, avgCostR: 0.02, grossExpectancyR: 0.32, expectancyRCI95: [0.1, 0.5],
  expectancyRCI95HalfWidth: 0.2, conclusive: false, inconclusiveReason: 'sample_too_small', minTrades: 30, curve: [],
};
const report = (extra = {}) => JSON.stringify({
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
  overall: STATS, byCascade: { '4h_15m': STATS }, costs: { model: {}, countedTrades: 10, minTrades: 30, conclusive: false, inconclusiveReason: 'sample_too_small', avgCostR: 0.02 },
  ...extra,
});
async function loadJson(json) {
  renderPage(<Backtest />);
  fireEvent.click(await screen.findByRole('tab', { name: /Simulação \(GitHub\)/i }));
  fireEvent.change(await screen.findByPlaceholderText(/"range":/), { target: { value: json } });
  fireEvent.click(screen.getByText(/Analisar relatório colado/i));
  await screen.findByText('Expectância');
}

describe('Backtest — cada aba diz o que é', () => {
  it('a nota abaixo das abas muda com a aba (real × simulação no navegador × GitHub)', async () => {
    renderPage(<Backtest />);
    expect(await screen.findByText(/Nada é simulado aqui/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Ajuste Fino \(What-If\)/ }));
    expect(screen.getByText(/Não grava nada e não afeta o scanner/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Simulação \(GitHub\)/ }));
    expect(screen.getByText(/Replay completo do motor/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Simulação \(GitHub\)/ }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('Backtest — leitura do resultado em português', () => {
  it('relatório inconclusivo: não conclui vantagem, diz o mínimo da amostra e a nota da fonte (JSON)', async () => {
    await loadJson(report());
    const v = screen.getByRole('status', { name: 'O que este resultado diz' });
    expect(within(v).getByText('Ainda não dá para dizer se a estratégia tem vantagem.')).toBeTruthy();
    expect(within(v).getByText(/Amostra pequena: 10 operações \(o mínimo para tirar conclusão é 30\)/)).toBeTruthy();
    expect(within(v).getByText(/passado não garante/)).toBeTruthy();
  });

  it('relatório conclusivo positivo: diz positivo (e continua mostrando custos bruto → líquido)', async () => {
    await loadJson(report({ costs: { model: {}, countedTrades: 400, minTrades: 30, conclusive: true, avgCostR: 0.02 } }));
    const v = screen.getByRole('status', { name: 'O que este resultado diz' });
    expect(within(v).getByText(/Amostra suficiente e resultado positivo/)).toBeTruthy();
    expect(within(v).getByText(/de \+0\.32R bruto para \+0\.30R líquido/)).toBeTruthy();
  });

  it('funil de entrada: glossário recolhido traduz os motivos conhecidos e admite os desconhecidos', async () => {
    const funnel = { '4h_15m': { total: 5, passed: 1, rejected: 4, byReason: { regime_rejected: 3, motivo_novo: 1 } } };
    await loadJson(report({ entryFunnel: funnel }));
    const resumo = screen.getByText('O que significa cada motivo');
    expect(resumo.closest('details').open).toBe(false);
    const d = within(resumo.closest('details'));
    expect(d.getByText(/mercado fraco ou lateral \(filtros ADX\/Choppiness\)/)).toBeTruthy();
    expect(d.getByText(/sem descrição \(código gravado pelo motor\)/)).toBeTruthy();
  });
});

describe('Backtest — Desempenho Real: resumo do período e estados', () => {
  it('sem operações: estado vazio compacto, contagem 0 e atalho "Ver todo o período"', async () => {
    renderPage(<Backtest />);
    expect(await screen.findByText('Nenhuma operação fechada nesse período.')).toBeTruthy();
    expect(screen.getByText(/no período/).textContent).toMatch(/0 operações no período/);
    fireEvent.click(screen.getByRole('button', { name: 'Ver todo o período' }));
    expect(screen.getByRole('button', { name: 'Tudo' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Ver todo o período' })).toBeNull();
  });

  it('carregando: a contagem mostra "—", não "0"', async () => {
    opsListMock.mockImplementation(() => new Promise(() => {}));
    renderPage(<Backtest />);
    expect(await screen.findByRole('status', { name: 'Carregando operações' })).toBeTruthy();
    expect(screen.getByText(/no período/).textContent).toMatch(/^.*— operações no período/);
    expect(screen.queryByText('Nenhuma operação fechada nesse período.')).toBeNull();
  });

  it('erro ao carregar: mensagem de erro, contagem "—" (nunca "0")', async () => {
    opsListMock.mockRejectedValue(new Error('falhou'));
    renderPage(<Backtest />);
    expect(await screen.findByText('Não foi possível carregar as operações reais agora.', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText(/no período/).textContent).toMatch(/— operações no período/);
  });

  it('com operações fechadas: resumo "N fechadas" e a nota "nenhuma ordem foi enviada à corretora"', async () => {
    const hoje = new Date().toISOString();
    opsListMock.mockResolvedValue([{
      id: 'o1', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY', status: 'STOP_HIT', entry_price: 60000, initial_stop: 59000, current_stop: 59000, exit_price: 59000,
      stop_hit_at: hoje, closed_at: hoje, created_date: hoje, cascade: '4h_15m',
    }]);
    renderPage(<Backtest />);
    const v = await screen.findByRole('status', { name: 'O que este resultado diz' });
    expect(within(v).getByText(/Amostra pequena: 1 operação /)).toBeTruthy();
    expect(within(v).getByText(/nenhuma ordem foi enviada à corretora/)).toBeTruthy();
    expect(screen.getByText(/no período/).textContent).toMatch(/1 operação no período \(1 fechada\)/);
  });
});

describe('Backtest — Ajuste Fino (What-If): "padrão X" em cada controle', () => {
  it('mostra o padrão de cada slider, "tudo no padrão" e a dica de escolher um ativo', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByRole('tab', { name: /Ajuste Fino \(What-If\)/ }));
    expect(await screen.findByText('tudo no padrão')).toBeTruthy();
    expect(screen.getAllByText(/^padrão /)).toHaveLength(17); // 10 controles (6 + 3 de distância do trailing + velas da invalidação) + os 7 interruptores (regime, trailing, time stop, trailing do runner, saída RF, Chop Exit e invalidação)
    expect(screen.getAllByText('padrão ligado (como na produção)')).toHaveLength(5);
    expect(screen.getByText('Escolha um ativo para executar.')).toBeTruthy();
    expect(screen.getByText(/aparece aqui assim que você escolher um ativo/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Executar Backtest/ }).disabled).toBe(true);
  });

  it('mexer num slider marca "● diferente do padrão" e conta "1 diferente do padrão"', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByRole('tab', { name: /Ajuste Fino \(What-If\)/ }));
    await screen.findByText('tudo no padrão');
    const slider = screen.getAllByRole('slider')[0];
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(await screen.findByText('1 diferente do padrão')).toBeTruthy();
    expect(screen.getByLabelText('diferente do padrão')).toBeTruthy();
  });
});

describe('Backtest — "Aplicar ao Scanner" mostra o que muda', () => {
  const comPine = (cfg) => report({ trialLabel: 'trial-teste', reproducibility: { pineConfig: cfg, configHash: 'h' } });
  const abrir = async () => { fireEvent.click(screen.getByText('Aplicar ao Scanner')); return screen.findByRole('alertdialog'); };

  it('lista os parâmetros que mudam (atual → trial)', async () => {
    await loadJson(comPine({ ...DEFAULTS, minScore: 80 }));
    const dialog = await abrir();
    expect(await within(dialog).findByText(/1 parâmetro muda:/)).toBeTruthy();
    expect(within(dialog).getByText(/minScore:/).textContent).toMatch(/minScore: 75 → 80/);
  });

  it('config igual: "Nenhum parâmetro muda"', async () => {
    await loadJson(comPine({ ...DEFAULTS }));
    const dialog = await abrir();
    expect(await within(dialog).findByText(/Nenhum parâmetro muda/)).toBeTruthy();
  });

  it('REGRESSÃO (Codex, PR #616): leitura vinda da CÓPIA GUARDADA (cache, degraded:false) também NÃO afirma o que muda — pode estar velha', async () => {
    pineStatus = { source: 'cache', degraded: false };
    await loadJson(comPine({ ...DEFAULTS }));
    const dialog = await abrir();
    expect(await within(dialog).findByText(/Não foi possível ler a configuração atual para comparar/)).toBeTruthy();
    expect(within(dialog).queryByText(/Nenhum parâmetro muda/)).toBeNull();
  });

  it('leitura degradada (banco falhou): NÃO afirma o que muda — avisa para conferir', async () => {
    pineStatus = { source: 'defaults', degraded: true };
    await loadJson(comPine({ ...DEFAULTS, minScore: 80 }));
    const dialog = await abrir();
    expect(await within(dialog).findByText(/Não foi possível ler a configuração atual para comparar/)).toBeTruthy();
    expect(within(dialog).queryByText(/parâmetro muda/)).toBeNull();
    await waitFor(() => expect(within(dialog).getByText('Aplicar')).toBeTruthy());
  });
});
