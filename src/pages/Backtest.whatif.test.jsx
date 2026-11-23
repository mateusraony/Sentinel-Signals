// @vitest-environment jsdom
//
// 22/11/2026 — Ajuste Fino (What-If) refeito: recalcula SOZINHO ao mexer, compara com o padrão, guarda cada teste num histórico (neste navegador),
// confere os candles e analisa a sensibilidade. Aqui, a aba inteira contra candles sintéticos (o motor em si tem testes próprios em quickBacktest.test.js).
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { renderPage, makeFakeBackendModule } from './__fixtures__/renderPage.jsx';

const fetchCandlesMock = vi.fn();
const { setConfigMock, updateAssetMock, statusMock } = vi.hoisted(() => ({ setConfigMock: vi.fn(async () => ({})), updateAssetMock: vi.fn(async () => ({})), statusMock: vi.fn(() => ({ source: 'postgres', degraded: false })) }));
const ASSETS = [{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, rf_period: 20, rf_multiplier: 3.5 }];

vi.mock('@/api/entities', async () => {
  const mod = makeFakeBackendModule({ populated: false });
  const base = mod.backend;
  return { backend: { ...base, entities: { ...base.entities, MonitoredAsset: { ...base.entities.MonitoredAsset, list: async () => ASSETS, update: updateAssetMock }, StrategyConfig: { ...base.entities.StrategyConfig, set: setConfigMock } } } };
});
vi.mock('@/lib/pineParser', async (importOriginal) => ({
  ...(await importOriginal()),
  getPineConfig: async () => ({ ...(await importOriginal()).DEFAULTS }),
  getPineConfigStatus: () => statusMock(),
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
  setConfigMock.mockClear(); updateAssetMock.mockClear(); statusMock.mockReturnValue({ source: 'postgres', degraded: false });
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
    expect(screen.getByRole('region', { name: 'Resultado ao vivo' })).toBeTruthy(); // faixa grudada: o resultado fica à vista enquanto rola pelos controles
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
    expect(screen.getAllByRole('img', { name: /^Expectância em R conforme/ })).toHaveLength(9); // os 6 controles + os 3 de distância do trailing (ligados por padrão, como na produção)
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

describe('What-If — filtro de regime e time stop (padrão = produção)', () => {
  it('os dois interruptores começam LIGADOS (como a produção); desligar o regime recalcula, marca "diferente do padrão" e vira outro teste no histórico', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    const regime = screen.getByRole('switch', { name: 'Filtro de regime (ADX/Choppiness)' });
    const timeStop = screen.getByRole('switch', { name: 'Time stop' });
    expect(regime.getAttribute('aria-checked')).toBe('true');
    expect(timeStop.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('tudo no padrão')).toBeTruthy();
    const hist = screen.getByRole('complementary', { name: 'Histórico de testes' });
    await waitFor(() => expect(within(hist).getByText('1 nesta janela')).toBeTruthy(), { timeout: 4000 });
    fireEvent.click(regime);
    expect(await screen.findByText('1 diferente do padrão')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Filtro de regime (ADX/Choppiness)' }).getAttribute('aria-checked')).toBe('false');
    await waitFor(() => expect(within(hist).getByText('2 nesta janela')).toBeTruthy(), { timeout: 5000 });
    expect(within(hist).getAllByText(/Regime (on|off)/).map(e => e.textContent).join(' ')).toMatch(/Regime off/);
    fireEvent.click(screen.getByRole('button', { name: 'Voltar ao padrão' }));
    expect(await screen.findByText('tudo no padrão')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Filtro de regime (ADX/Choppiness)' }).getAttribute('aria-checked')).toBe('true');
  });

  it('o funil mostra o destino "barrados pelo filtro de regime" e o painel "Posso confiar?" diz que regime e time stop agora são simulados', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    expect(screen.getByText(/barrados pelo filtro de regime/)).toBeTruthy();
    const d = within(screen.getByText(/Posso confiar\?/).closest('details'));
    expect(d.getByText(/Filtro de regime ADX\/Choppiness por tier — ligado neste teste/)).toBeTruthy();
    expect(d.getByText(/Time stop por tier \(48 \/ 64 \/ 96 candles\) — ligado neste teste/)).toBeTruthy();
    expect(d.getByText(/Trailing do stop ANTES do TP1 — ligado neste teste/)).toBeTruthy(); // agora também é simulado (padrão = produção)
  });
});

// Slider do Radix no jsdom: sem layout e sem captura de ponteiro. Aqui os dois são simulados para poder ARRASTAR de verdade (mover sem soltar).
function fakeDrag() {
  const proto = Element.prototype;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.hasPointerCapture ??= () => true;
  const root = screen.getAllByRole('slider')[2].parentElement.parentElement;
  root.getBoundingClientRect = () => ({ left: 0, right: 200, width: 200, top: 0, bottom: 10, height: 10, x: 0, y: 0, toJSON() {} });
  const fire = (type, x) => root.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 5 }));
  return { down: (x) => fire('pointerdown', x), move: (x) => fire('pointermove', x), up: (x) => { fire('pointerup', x); window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); } };
}

describe('What-If — o histórico só registra quando o controle é SOLTO e não duplica valores repetidos (pedido do usuário, 23/11)', () => {
  it('arrastando um controle nada é registrado; ao soltar, registra UM teste só', async () => {
    await openWhatIf();
    await pickAsset();
    const hist = await screen.findByRole('complementary', { name: 'Histórico de testes' });
    await waitFor(() => expect(within(hist).getByText('1 nesta janela')).toBeTruthy(), { timeout: 4000 });
    const drag = fakeDrag();
    act(() => { drag.down(60); });
    act(() => { drag.move(80); });
    act(() => { drag.move(100); });
    await screen.findByText(/diferente do padrão/); // o resultado acompanha o arrasto…
    await new Promise(r => setTimeout(r, 1600)); // …mas, com o controle ainda preso, nada é gravado (antes gravava ao pausar 1,2 s)
    expect(within(hist).getByText('1 nesta janela')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('sentinel_whatif_history_v1')).runs).toHaveLength(1);
    expect(within(hist).getByText(/ainda não registrado/)).toBeTruthy();
    act(() => { drag.up(100); });
    await waitFor(() => expect(within(hist).getByText('2 nesta janela')).toBeTruthy(), { timeout: 4000 });
    expect(JSON.parse(localStorage.getItem('sentinel_whatif_history_v1')).runs).toHaveLength(2);
  }, 15000);

  it('voltar aos MESMOS valores de um teste já feito não cria outro: o histórico não cresce', async () => {
    await openWhatIf();
    await pickAsset();
    const hist = await screen.findByRole('complementary', { name: 'Histórico de testes' });
    await waitFor(() => expect(within(hist).getByText('1 nesta janela')).toBeTruthy(), { timeout: 4000 });
    await nudgeSlider(2); // padrão → valor novo (2 testes)
    await waitFor(() => expect(within(hist).getByText('2 nesta janela')).toBeTruthy(), { timeout: 4000 });
    const slider = screen.getAllByRole('slider')[2];
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' }); // de volta ao padrão
    await screen.findByText('tudo no padrão');
    await new Promise(r => setTimeout(r, 1500));
    expect(within(hist).getByText('2 nesta janela')).toBeTruthy(); // continua 2: o teste do padrão só foi atualizado
    expect(JSON.parse(localStorage.getItem('sentinel_whatif_history_v1')).runs).toHaveLength(2);
    expect(within(hist).getByRole('status', { name: 'Este teste no histórico' }).textContent).toMatch(/Em tela agora: #\d de 2/);
  }, 15000);

  it('o painel mostra "Em tela agora" com a posição, mesmo com a lista longa; e o aviso de "muitas combinações" é só um aviso que não bloqueia', async () => {
    const mk = (n) => ({
      key: `k${n}`, at: `2026-11-22T10:${String(n).padStart(2, '0')}:00.000Z`, starred: false,
      dataset: { assetId: 'a1', symbol: 'BTCUSDT', timeframe: '4h', candleCount: 500, windowEnd: 5 },
      params: { atrMult: 2, tp1R: 1.5, rfPeriod: 20, rfMult: 3.5, minScore: 50 + n, regime: 1, timeStop: 1 },
      summary: { expectancyR: n / 100, counted: 20, winRate: 50, profitFactor: 1.2, maxDrawdownPct: 3, conclusive: false },
    });
    // 10 testes numa janela de MESMA identidade da tela exige o mesmo windowEnd: pegamos o da tela depois de carregar e regravamos
    await openWhatIf();
    await pickAsset();
    const hist = await screen.findByRole('complementary', { name: 'Histórico de testes' });
    await waitFor(() => expect(within(hist).getByText('1 nesta janela')).toBeTruthy(), { timeout: 4000 });
    const saved = JSON.parse(localStorage.getItem('sentinel_whatif_history_v1')).runs;
    const windowEnd = saved[0].dataset.windowEnd;
    const many = Array.from({ length: 10 }, (_, n) => ({ ...mk(n), dataset: { ...mk(n).dataset, windowEnd } }));
    cleanup();
    localStorage.setItem('sentinel_whatif_history_v1', JSON.stringify({ v: 1, runs: [...saved, ...many] }));
    await openWhatIf();
    await pickAsset();
    const hist2 = await screen.findByRole('complementary', { name: 'Histórico de testes' });
    await within(hist2).findByText('11 nesta janela');
    expect(within(hist2).getByRole('note').textContent).toMatch(/não bloqueia nada.*11 combinações.*sorte/);
    expect(within(hist2).getByRole('status', { name: 'Este teste no histórico' }).textContent).toMatch(/Em tela agora: #\d+ de 11/);
  }, 20000);
});

describe('What-If — trailing do stop antes do TP1 (padrão = produção)', () => {
  // O rótulo acessível fica no contêiner do Radix, não no polegar (role=slider): os de trailing são os polegares 6, 7 e 8 (depois dos 6 controles principais).
  const THUMB = { 'Trailing: começa em (× ATR)': 6, 'Runner: distância do trailing (× ATR)': 7, 'Trailing: distância (× ATR)': 8 };
  const sliderByName = (name) => screen.getAllByRole('slider')[THUMB[name]];
  const isDisabled = (el) => el.hasAttribute('data-disabled');

  it('vem LIGADO como na produção, com os dois ajustes (começo e distância) usáveis e o padrão 1 / 2 × ATR', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    const sw = screen.getByRole('switch', { name: 'Trailing do stop antes do TP1' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    const start = sliderByName('Trailing: começa em (× ATR)'); const dist = sliderByName('Trailing: distância (× ATR)');
    expect(start.getAttribute('aria-valuenow')).toBe('1');
    expect(dist.getAttribute('aria-valuenow')).toBe('2');
    expect(isDisabled(start) || isDisabled(dist)).toBe(false);
    expect(screen.getByText('tudo no padrão')).toBeTruthy();
  });

  it('desligar apaga os dois ajustes, conta 1 diferente do padrão e grava o teste com trailing desligado; ligar de novo volta ao teste do padrão (sem duplicar)', async () => {
    await openWhatIf();
    await pickAsset();
    const hist = await screen.findByRole('complementary', { name: 'Histórico de testes' });
    await waitFor(() => expect(within(hist).getByText('1 nesta janela')).toBeTruthy(), { timeout: 4000 });
    fireEvent.click(screen.getByRole('switch', { name: 'Trailing do stop antes do TP1' }));
    expect(await screen.findByText('1 diferente do padrão')).toBeTruthy();
    expect(isDisabled(sliderByName('Trailing: começa em (× ATR)'))).toBe(true);
    expect(isDisabled(sliderByName('Trailing: distância (× ATR)'))).toBe(true);
    await waitFor(() => expect(within(hist).getByText('2 nesta janela')).toBeTruthy(), { timeout: 4000 });
    const saved = JSON.parse(localStorage.getItem('sentinel_whatif_history_v1')).runs;
    expect(saved.some(r => r.params.trail === 0)).toBe(true);
    expect(within(hist).getByText(/Trailing off/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Trailing do stop antes do TP1' }));
    await screen.findByText('tudo no padrão');
    await new Promise(r => setTimeout(r, 1500));
    expect(within(hist).getByText('2 nesta janela')).toBeTruthy(); // o teste do padrão só foi atualizado
  }, 15000);

  it('mexer na distância do trailing marca ● e conta como diferente do padrão', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    const dist = sliderByName('Trailing: distância (× ATR)');
    dist.focus();
    fireEvent.keyDown(dist, { key: 'ArrowRight' });
    fireEvent.keyDown(dist, { key: 'ArrowRight' });
    expect(await screen.findByText('1 diferente do padrão')).toBeTruthy();
    expect(sliderByName('Trailing: distância (× ATR)').getAttribute('aria-valuenow')).toBe('2.2');
  });

  it('a análise das saídas tem a linha "Stop do trailing" e o painel "Posso confiar?" diz que o trailing é simulado', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    expect(screen.getByText('Stop do trailing (antes do TP1)')).toBeTruthy();
    const d = within(screen.getByText(/Posso confiar\?/).closest('details'));
    expect(d.getByText(/Trailing do stop ANTES do TP1 — ligado neste teste/)).toBeTruthy();
  });

  it('a sensibilidade só varre os ajustes do trailing quando ele está ligado', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    fireEvent.click(screen.getByRole('switch', { name: 'Trailing do stop antes do TP1' }));
    await screen.findByText('1 diferente do padrão');
    await waitFor(() => expect(screen.queryByText(/Recalculando/)).toBeNull(), { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: 'Analisar sensibilidade' }));
    expect(await screen.findByRole('button', { name: 'Analisar de novo' })).toBeTruthy();
    expect(screen.getAllByRole('img', { name: /^Expectância em R conforme/ })).toHaveLength(7); // 6 controles + a distância do runner; sem os 2 do trailing pré-TP1
  }, 15000);
});

describe('What-If — runner depois do TP1 e piso R:R (padrão = produção)', () => {
  const THUMB_RUNNER = 7; // distância do trailing do runner
  const THUMB_MINRR = 5; // piso R:R (6º controle principal)

  it('vêm LIGADOS como na produção: trailing do runner 2× ATR, saída pelo Range Filter e piso 1,2R', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    expect(screen.getByRole('switch', { name: 'Trailing do runner depois do TP1' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Saída do runner pelo Range Filter' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getAllByRole('slider')[THUMB_RUNNER].getAttribute('aria-valuenow')).toBe('2');
    expect(screen.getAllByRole('slider')[THUMB_MINRR].getAttribute('aria-valuenow')).toBe('1.2');
    expect(screen.getByText('tudo no padrão')).toBeTruthy();
  });

  it('desligar o trailing do runner apaga só a distância dele e conta como 1 diferente; a saída por RF conta à parte', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    fireEvent.click(screen.getByRole('switch', { name: 'Trailing do runner depois do TP1' }));
    expect(await screen.findByText('1 diferente do padrão')).toBeTruthy();
    expect(screen.getAllByRole('slider')[THUMB_RUNNER].hasAttribute('data-disabled')).toBe(true);
    expect(screen.getAllByRole('slider')[6].hasAttribute('data-disabled')).toBe(false); // o trailing PRÉ-TP1 segue usável
    fireEvent.click(screen.getByRole('switch', { name: 'Saída do runner pelo Range Filter' }));
    expect(await screen.findByText('2 diferentes do padrão')).toBeTruthy();
  });

  it('piso R:R acima do TP1 barra todas as entradas e o funil diz isso (acoplamento tp1R × piso)', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    const minRR = screen.getAllByRole('slider')[THUMB_MINRR];
    minRR.focus();
    for (let i = 0; i < 6; i++) fireEvent.keyDown(minRR, { key: 'ArrowRight' }); // 1,2 → 1,8 (acima do TP1 de 1,5)
    expect(await screen.findByText(/barrados pelo piso de risco\/retorno/, {}, { timeout: 4000 })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/O piso de risco\/retorno está barrando as entradas/)).toBeTruthy(), { timeout: 4000 });
  }, 15000);

  it('"Posso confiar?" lista runner e piso como feitos e só o filtro 4h/15m (e Chop/invalidação desligados) como não feitos', async () => {
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    const d = within(screen.getByText(/Posso confiar\?/).closest('details'));
    expect(d.getByText(/Trailing do stop do RUNNER depois do TP1 — ligado neste teste/)).toBeTruthy();
    expect(d.getByText(/Saída do runner pelo Range Filter — ligado neste teste/)).toBeTruthy();
    expect(d.getByText(/Piso de risco\/retorno do TP1/)).toBeTruthy();
    expect(d.getByText(/Chop Exit e invalidação do Range Filter ANTES do TP1/)).toBeTruthy();
  });
});

describe('What-If — aplicar ao scanner AO VIVO: o USUÁRIO escolhe, parâmetro por parâmetro', () => {
  const openBtn = () => screen.getByRole('button', { name: /Aplicar ao scanner…/ });
  const nudgeThumb = async (idx, key = 'ArrowRight', times = 2) => { const sl = screen.getAllByRole('slider')[idx]; sl.focus(); for (let i = 0; i < times; i++) fireEvent.keyDown(sl, { key }); };
  const ready = async () => { await openWhatIf(); await pickAsset(); await screen.findByRole('status', { name: 'O que este resultado diz' }); await waitFor(() => expect(openBtn().disabled).toBe(false), { timeout: 4000 }); };
  const openDialog = async () => { await waitFor(() => expect(openBtn().disabled).toBe(false), { timeout: 4000 }); fireEvent.click(openBtn()); const dlg = await screen.findByRole('alertdialog'); await within(dlg).findByText(/Lendo a configuração atual do scanner/).catch(() => null); await waitFor(() => expect(within(dlg).queryByText(/Lendo a configuração atual do scanner/)).toBeNull()); return dlg; };
  const confirmBtn = (dlg) => within(dlg).getByRole('button', { name: /^Aplicar/ });

  it('o botão fica disponível a qualquer hora (mesmo sem ter mexido em nada); sem diferença, o diálogo diz que não há o que aplicar e nada pode ser aplicado', async () => {
    await ready();
    const dlg = await openDialog();
    await within(dlg).findByText(/Nenhum parâmetro desta tela difere do scanner agora/);
    expect(confirmBtn(dlg).disabled).toBe(true);
    // os iguais ficam recolhidos num bloco à parte, com o valor atual e a caixinha desligada
    expect(within(dlg).getByText(/Já iguais ao scanner \(\d+\) — nada a aplicar/)).toBeTruthy();
    expect(within(dlg).getAllByText(/igual ao scanner/).length).toBeGreaterThan(5);
    expect(within(dlg).getByRole('checkbox', { name: 'TP1 (R)' }).disabled).toBe(true);
    expect(setConfigMock).not.toHaveBeenCalled();
  });

  it('lista TODOS os parâmetros com o valor atual do scanner → o da tela; só os que diferem têm caixinha; grava SÓ o que ficou marcado', async () => {
    await ready();
    await nudgeThumb(1); // TP1: 1,5 → 1,7
    await nudgeThumb(0, 'ArrowLeft', 0); // (sem efeito; mantém o stop no padrão)
    await nudgeThumb(5); // Piso R:R: 1,2 → 1,4
    await screen.findByText('2 diferentes do padrão');
    const dlg = await openDialog();
    expect(within(dlg).getByText(/2 parâmetros diferem do scanner/)).toBeTruthy();
    const tp1 = within(dlg).getByRole('checkbox', { name: 'TP1 (R)' });
    const rr = within(dlg).getByRole('checkbox', { name: 'Piso R:R do TP1' });
    expect(tp1.checked).toBe(true); expect(rr.checked).toBe(true); // os que diferem vêm marcados; o usuário desmarca o que não quer
    expect(within(dlg).getByRole('checkbox', { name: 'Score mínimo' }).disabled).toBe(true); // igual ao scanner: sem caixinha
    expect(within(dlg).getByText(/TP1 \(R\):/).textContent).toMatch(/1\.5.*→.*1\.7/);
    expect(within(dlg).getByText(/Nenhuma ordem é enviada/)).toBeTruthy();
    expect(within(dlg).getByText(/ainda não faz a confirmação de 15 min/)).toBeTruthy();
    expect(setConfigMock).not.toHaveBeenCalled(); // abrir o diálogo não grava nada
    fireEvent.click(rr); // o usuário DESMARCA o piso: ele escolhe só o TP1
    expect(confirmBtn(dlg).textContent).toMatch(/Aplicar 1 escolhido/);
    fireEvent.click(confirmBtn(dlg));
    await waitFor(() => expect(setConfigMock).toHaveBeenCalledTimes(1));
    const [id, payload] = setConfigMock.mock.calls[0];
    expect(id).toBe('current');
    expect(Object.keys(payload).sort()).toEqual(['tp1R', 'updated_at']); // o piso desmarcado NÃO foi
    expect(payload.tp1R).toBeCloseTo(1.7, 5);
    expect(await screen.findByText(/Aplicado ao scanner: 1 parâmetro global/)).toBeTruthy();
    expect(updateAssetMock).not.toHaveBeenCalled();
  }, 20000);

  it('"desmarcar todos" deixa o botão desligado; "marcar todos" liga de novo', async () => {
    await ready();
    await nudgeThumb(1);
    await screen.findByText('1 diferente do padrão');
    const dlg = await openDialog();
    fireEvent.click(within(dlg).getByRole('button', { name: 'desmarcar todos' }));
    expect(confirmBtn(dlg).disabled).toBe(true);
    fireEvent.click(within(dlg).getByRole('button', { name: 'marcar todos' }));
    expect(confirmBtn(dlg).disabled).toBe(false);
  }, 20000);

  it('stop (× ATR) não é configuração do scanner: aparece como "não dá para aplicar" e nunca é gravado', async () => {
    await ready();
    await nudgeThumb(0); // Stop (× ATR)
    await screen.findByText('1 diferente do padrão');
    const dlg = await openDialog();
    await within(dlg).findByText(/Não dá para aplicar ao scanner:/);
    expect(within(dlg).getByText(/tier de volatilidade/)).toBeTruthy();
    expect(confirmBtn(dlg).disabled).toBe(true);
    expect(setConfigMock).not.toHaveBeenCalled();
  }, 20000);

  it('configuração do scanner não lida do banco (cópia/padrões): não afirma nada e NÃO deixa aplicar', async () => {
    await ready();
    await nudgeThumb(1);
    await screen.findByText('1 diferente do padrão');
    await waitFor(() => expect(openBtn().disabled).toBe(false), { timeout: 4000 });
    statusMock.mockReturnValue({ source: 'cache', degraded: false });
    fireEvent.click(openBtn());
    const dlg = await screen.findByRole('alertdialog');
    await within(dlg).findByText(/Não foi possível ler a configuração atual do scanner/);
    expect(confirmBtn(dlg).disabled).toBe(true);
  }, 20000);

  it('Range Filter é POR ATIVO: vem desmarcado; só grava no ativo se você marcar (MonitoredAsset.update, não a configuração global)', async () => {
    await ready();
    await nudgeThumb(2); // RF Period: 20 → 22
    await screen.findByText('1 diferente do padrão');
    const dlg = await openDialog();
    const rf = within(dlg).getByRole('checkbox', { name: 'Range Filter deste ativo: período' });
    expect(rf.checked).toBe(false);
    expect(confirmBtn(dlg).disabled).toBe(true); // nada marcado
    fireEvent.click(rf);
    await waitFor(() => expect(confirmBtn(dlg).disabled).toBe(false));
    fireEvent.click(confirmBtn(dlg));
    await waitFor(() => expect(updateAssetMock).toHaveBeenCalledTimes(1));
    expect(updateAssetMock).toHaveBeenCalledWith('a1', { rf_period: 22 });
    expect(setConfigMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/Aplicado ao scanner: Range Filter de BTCUSDT/)).toBeTruthy();
  }, 20000);

  it('falha ao gravar: diz que NÃO aplicou (nunca afirma "aplicado")', async () => {
    setConfigMock.mockRejectedValueOnce(new Error('banco fora'));
    await ready();
    await nudgeThumb(1);
    await screen.findByText('1 diferente do padrão');
    const dlg = await openDialog();
    fireEvent.click(confirmBtn(dlg));
    expect(await screen.findByText(/Não foi possível aplicar ao scanner agora \(banco fora\)/)).toBeTruthy();
    expect(screen.queryByText(/Aplicado ao scanner/)).toBeNull();
  }, 20000);
});

describe('What-If — reavaliar o histórico nos dados atuais', () => {
  const seed = (runs) => localStorage.setItem('sentinel_whatif_history_v1', JSON.stringify({ v: 1, runs }));
  const old = (over = {}) => ({
    key: 'k-antiga', at: '2026-11-01T10:00:00.000Z', starred: false,
    dataset: { assetId: 'a1', symbol: 'BTCUSDT', timeframe: '4h', candleCount: 500, windowEnd: 1 },
    params: { atrMult: 2, tp1R: 1.5, rfPeriod: 20, rfMult: 3.5, minScore: 60, regime: 1, timeStop: 1 },
    summary: { expectancyR: 0.4, counted: 12, winRate: 50, profitFactor: 1.5, maxDrawdownPct: 4, conclusive: false },
    ...over,
  });

  it('com testes de uma janela mais antiga do MESMO ativo/período, oferece reavaliar; ao clicar, cria o resultado na janela atual e a oferta some', async () => {
    seed([old()]);
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    const hist = screen.getByRole('complementary', { name: 'Histórico de testes' });
    const botao = await within(hist).findByRole('button', { name: /Reavaliar nos dados atuais \(1\)/ });
    fireEvent.click(botao);
    expect(await within(hist).findByText('1 teste reavaliado nos dados atuais.')).toBeTruthy();
    await waitFor(() => expect(within(hist).queryByRole('button', { name: /Reavaliar nos dados atuais/ })).toBeNull());
    // o teste é UM SÓ (mesmos valores não duplicam): o resultado novo, da janela atual, SUBSTITUIU o antigo
    const saved = JSON.parse(localStorage.getItem('sentinel_whatif_history_v1')).runs;
    expect(saved.some(r => r.dataset.windowEnd === 1)).toBe(false);
    expect(saved.filter(r => r.params.minScore === 60)).toHaveLength(1);
    expect(saved.find(r => r.params.minScore === 60).dataset.windowEnd).not.toBe(1);
  });

  it('não oferece reavaliar para outro ativo nem quando não há nada antigo', async () => {
    seed([old({ dataset: { assetId: 'a9', symbol: 'XUSDT', timeframe: '4h', candleCount: 500, windowEnd: 1 }, key: 'k-outro' })]);
    await openWhatIf();
    await pickAsset();
    await screen.findByRole('status', { name: 'O que este resultado diz' });
    expect(screen.queryByRole('button', { name: /Reavaliar nos dados atuais/ })).toBeNull();
  });

  it('teste gravado antes dos interruptores aparece como "Regime off · Time stop off" (valia sem esses filtros)', async () => {
    const legacy = old({ key: 'k-legado' }); delete legacy.params.regime; delete legacy.params.timeStop;
    seed([legacy]);
    await openWhatIf();
    expect(screen.getByText(/Testes em outras janelas de dados \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Regime off · Time stop off/)).toBeTruthy();
  });
});
