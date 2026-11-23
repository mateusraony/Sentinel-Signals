// @vitest-environment jsdom
//
// 22/11/2026 — Ajuste Fino (What-If) refeito: recalcula SOZINHO ao mexer, compara com o padrão, guarda cada teste num histórico (neste navegador),
// confere os candles e analisa a sensibilidade. Aqui, a aba inteira contra candles sintéticos (o motor em si tem testes próprios em quickBacktest.test.js).
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderPage, makeFakeBackendModule } from './__fixtures__/renderPage.jsx';

const fetchCandlesMock = vi.fn();
const ASSETS = [{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, rf_period: 20, rf_multiplier: 3.5 }];

vi.mock('@/api/entities', async () => {
  const mod = makeFakeBackendModule({ populated: false });
  const base = mod.backend;
  return { backend: { ...base, entities: { ...base.entities, MonitoredAsset: { ...base.entities.MonitoredAsset, list: async () => ASSETS } } } };
});
vi.mock('@/lib/pineParser', async (importOriginal) => ({
  ...(await importOriginal()),
  getPineConfig: async () => ({ ...(await importOriginal()).DEFAULTS }),
  getPineConfigStatus: () => ({ source: 'postgres', degraded: false }),
}));
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));
vi.mock('@/lib/AuthContext', () => ({ AuthProvider: ({ children }) => children, useAuth: () => ({ user: { uid: 't' }, role: 'admin', loading: false }) }));
vi.mock('@/lib/marketDataProvider', () => ({ fetchCandles: (...a) => fetchCandlesMock(...a), fetchCurrentPrice: async () => null, fetch24hStats: async () => null, MARKET_SOURCE: 'spot', DATA_EXCHANGE: 'binance', EXECUTOR: 'browser' }));
vi.mock('@/lib/apiBackend', () => ({ callBackend: vi.fn(async () => ({ status: 'in_progress' })) }));

import Backtest from './Backtest.jsx';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function synth(n, seed = 3, vol = 0.012) {
  const R = rng(seed); let p = 100; let drift = 0; const out = []; const H4 = 4 * 3600e3; let t = Math.floor(Date.now() / H4) * H4 - n * H4; // termina agora: os dados são "recentes"
  for (let i = 0; i < n; i++) {
    if (i % 60 === 0) drift = (R() - 0.5) * 0.006;
    const o = p; const c = o * (1 + drift + (R() - 0.5) * 2 * vol);
    out.push({ openTime: t, open: o, high: Math.max(o, c) * (1 + R() * vol * 0.6), low: Math.min(o, c) * (1 - R() * vol * 0.6), close: c, volume: 1000 + R() * 800, closeTime: t + 4 * 3600e3 - 1, isClosed: true });
    t += 4 * 3600e3; p = c;
  }
  return out;
}

beforeEach(() => {
  localStorage.clear();
  fetchCandlesMock.mockReset();
  fetchCandlesMock.mockResolvedValue(synth(600));
});
afterEach(() => cleanup());

async function openWhatIf() {
  renderPage(<Backtest />);
  fireEvent.click(await screen.findByRole('tab', { name: /Ajuste Fino \(What-If\)/ }));
  await screen.findByText('Escolha um ativo para executar.');
}
async function pickAsset() {
  const select = screen.getByText('Ativo').parentElement.querySelector('select');
  await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: 'a1' } });
}
async function nudgeSlider(index = 2) {
  const slider = screen.getAllByRole('slider')[index];
  slider.focus();
  fireEvent.keyDown(slider, { key: 'ArrowRight' });
  fireEvent.keyDown(slider, { key: 'ArrowRight' });
}

describe('What-If — automático', () => {
  it('ao escolher o ativo busca os candles e mostra o resultado SOZINHO (sem clicar em nada)', async () => {
    await openWhatIf();
    await pickAsset();
    expect(await screen.findByRole('status', { name: 'O que este resultado diz' })).toBeTruthy();
    expect(fetchCandlesMock).toHaveBeenCalledWith('BTCUSDT', '4h', 500);
    expect(screen.getByRole('region', { name: 'Atual comparado com o padrão' })).toBeTruthy();
    expect(screen.getByText(/Os parâmetros são os do padrão/)).toBeTruthy();
    expect(screen.getByText(/Tier do ativo:/)).toBeTruthy();
  });

  it('mexer num parâmetro recalcula sozinho e mostra a diferença para o padrão', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    const calls = fetchCandlesMock.mock.calls.length;
    await nudgeSlider(2);
    expect(await screen.findByText('1 diferente do padrão')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Os parâmetros são os do padrão/)).toBeNull(), { timeout: 3000 });
    expect(fetchCandlesMock.mock.calls.length).toBe(calls); // recalcular NÃO busca candles de novo
  });

  it('"Voltar ao padrão" desfaz tudo; fica desabilitado quando já está no padrão', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    const back = screen.getByRole('button', { name: 'Voltar ao padrão' });
    expect(back.disabled).toBe(true);
    await nudgeSlider(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Voltar ao padrão' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Voltar ao padrão' }));
    expect(await screen.findByText('tudo no padrão')).toBeTruthy();
  });

  it('modo manual: desligar o automático faz o resultado esperar o clique, e avisa que está desatualizado', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    fireEvent.click(screen.getByRole('switch', { name: 'Atualizar o resultado sozinho' }));
    await nudgeSlider(2);
    expect(await screen.findByText(/o resultado abaixo ainda é do teste anterior/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Executar Backtest/ }));
    await waitFor(() => expect(screen.queryByText(/ainda é do teste anterior/)).toBeNull());
    expect(localStorage.getItem('sentinel_whatif_auto_v1')).toBe('0');
  });
});

describe('What-If — histórico dos testes', () => {
  it('registra sozinho cada combinação (padrão e a alterada), grava no navegador e ranqueia', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    const hist = screen.getByRole('complementary', { name: 'Histórico de testes' });
    await waitFor(() => expect(within(hist).getByText('1 nesta janela')).toBeTruthy(), { timeout: 4000 });
    await nudgeSlider(2);
    await waitFor(() => expect(within(hist).getByText('2 nesta janela')).toBeTruthy(), { timeout: 5000 });
    expect(within(hist).getByText('melhor até agora')).toBeTruthy();
    expect(within(hist).getByText('em tela')).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem('sentinel_whatif_history_v1'));
    expect(saved.runs).toHaveLength(2);
    expect(saved.runs[0].params).toHaveProperty('minScore');
  });

  it('"Usar" volta aos parâmetros daquele teste, e favoritar/apagar funcionam', async () => {
    await openWhatIf();
    await pickAsset();
    const hist = await screen.findByRole('complementary', { name: 'Histórico de testes' });
    await waitFor(() => expect(within(hist).getByText('1 nesta janela')).toBeTruthy(), { timeout: 4000 });
    await nudgeSlider(2);
    await waitFor(() => expect(within(hist).getByText('2 nesta janela')).toBeTruthy(), { timeout: 5000 });
    // o teste do padrão está na lista e NÃO é o que está em tela: "Usar" fica habilitado nele
    const usar = within(hist).getAllByRole('button', { name: 'Usar' }).find(b => !b.disabled);
    fireEvent.click(usar);
    expect(await screen.findByText('tudo no padrão')).toBeTruthy();
    const star = within(hist).getAllByRole('button', { name: 'Marcar como favorito' })[0];
    fireEvent.click(star);
    expect(within(hist).getAllByRole('button', { name: 'Tirar dos favoritos' })).toHaveLength(1);
    fireEvent.click(within(hist).getAllByRole('button', { name: 'Apagar este teste' })[1]);
    await waitFor(() => expect(within(hist).getByText('1 nesta janela')).toBeTruthy());
  });

  it('o histórico sobrevive ao recarregar (testes antigos aparecem à parte, sem ativo escolhido)', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('sentinel_whatif_history_v1') ?? '{"runs":[]}').runs.length).toBeGreaterThanOrEqual(1), { timeout: 4000 });
    cleanup();
    await openWhatIf();
    expect(screen.getByText(/Testes em outras janelas de dados \(1\)/)).toBeTruthy();
  });

  it('"Apagar todo o histórico" pede confirmação', async () => {
    await openWhatIf();
    await pickAsset();
    const hist = await screen.findByRole('complementary', { name: 'Histórico de testes' });
    await waitFor(() => expect(within(hist).getByText('1 nesta janela')).toBeTruthy(), { timeout: 4000 });
    fireEvent.click(within(hist).getByRole('button', { name: 'Apagar todo o histórico' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(within(hist).getByText('1 nesta janela')).toBeTruthy();
    fireEvent.click(within(hist).getByRole('button', { name: 'Apagar todo o histórico' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('Apagar tudo'));
    expect(await within(hist).findByText('nenhum ainda')).toBeTruthy();
  });
});

describe('What-If — confiança nos dados e análise', () => {
  it('a conferência dos candles e a lista do que o simulador NÃO faz estão disponíveis (recolhidas)', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    const sum = screen.getByText(/Posso confiar\?/);
    expect(sum.closest('details').open).toBe(false);
    const d = within(sum.closest('details'));
    expect(d.getByText(/Candles recebidos:/)).toBeTruthy();
    expect(d.getByText(/Preços coerentes:/)).toBeTruthy();
    expect(d.getByText(/Filtro de regime ADX\/Choppiness/)).toBeTruthy();
    expect(d.getByText(/Médias EMA 20\/50 no score/)).toBeTruthy();
    expect(screen.getByText(/Dados conferidos: tudo certo/)).toBeTruthy();
  });

  it('dado com buraco vira ponto de atenção visível no cabeçalho', async () => {
    const c = synth(600); fetchCandlesMock.mockResolvedValue([...c.slice(0, 300), ...c.slice(305)]);
    await openWhatIf();
    await pickAsset();
    expect(await screen.findByText(/Dados conferidos: há pontos de atenção/)).toBeTruthy();
  });

  it('análise visual: gráfico do preço com as operações, funil de sinais e distribuição', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    expect(screen.getByRole('img', { name: /Gráfico do preço de BTCUSDT com \d+ operações simuladas marcadas/ })).toBeTruthy();
    expect(screen.getByText(/sinais do Range Filter/)).toBeTruthy();
    expect(screen.getByText('Como terminaram')).toBeTruthy();
    expect(screen.getByText('Compra × venda')).toBeTruthy();
  });

  it('sensibilidade: roda sob demanda e mostra um gráfico + leitura por parâmetro', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    fireEvent.click(screen.getByRole('button', { name: 'Analisar sensibilidade' }));
    expect(await screen.findByRole('button', { name: 'Analisar de novo' })).toBeTruthy();
    expect(screen.getAllByRole('img', { name: /^Expectância em R conforme/ })).toHaveLength(5);
  });
});

describe('What-If — erros', () => {
  it('falha ao buscar candles: mensagem + "Tentar de novo" que realmente tenta', async () => {
    fetchCandlesMock.mockRejectedValueOnce(new Error('Binance API error (451)'));
    await openWhatIf();
    await pickAsset();
    expect(await screen.findByText(/Não foi possível buscar os candles: Binance API error \(451\)/)).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'O que este resultado diz' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('status', { name: 'O que este resultado diz' })).toBeTruthy();
  });

  it('candles de menos para simular: explica, em vez de uma tela vazia', async () => {
    fetchCandlesMock.mockResolvedValue(synth(40));
    await openWhatIf();
    await pickAsset();
    expect(await screen.findByText(/Não foi possível simular: Candles insuficientes/)).toBeTruthy();
  });
});
