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
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
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
// Usado só pelo describe do achado A-6 (botão "Parar de acompanhar") no
// fim do arquivo — mantém um run em polling pra exercitar o botão de
// cancelar sem depender de rede real.
vi.mock('@/lib/apiBackend', () => ({
  callBackend: vi.fn(async () => ({ status: 'in_progress' })),
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

// Mesmo REPORT_JSON, mas com `overall.curve` populado com 1 op fechada real
// (mínimo pra `equitySim`, em ReportBody, não ficar `null` — só usado no
// teste do achado A-7 que precisa do campo "Capital inicial" renderizado,
// que só aparece com `equitySim` não-nulo).
const REPORT_JSON_COM_CURVE = JSON.stringify({
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
  overall: {
    ...CASCADE_STATS, total: 1, counted: 1, wins: 0, losses: 1,
    curve: [{
      cumulativePct: -1.67, outcome: 'LOSS',
      op: {
        id: 'op1', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY',
        status: 'STOP_HIT', entry_price: 60000, initial_stop: 59000,
        current_stop: 59000, exit_price: 59000,
        stop_hit_at: '2026-01-05T00:00:00.000Z', closed_at: '2026-01-05T00:00:00.000Z',
        created_date: '2026-01-01T00:00:00.000Z',
      },
    }],
  },
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

// Achado M-17 do Raio-X de UI/UX (glossário de termos técnicos): "CAGR" era
// o único SummaryCard da tela sem a prop `tooltip` — os outros já usam o
// mesmo padrão (`InfoTooltip`/`TooltipTrigger`, achado A-6). Precisa de
// `equitySim` não-nulo (curve populada), daí reusar REPORT_JSON_COM_CURVE.
describe('Backtest — SummaryCard "CAGR" tem tooltip explicando o termo (achado M-17)', () => {
  it('REGRESSÃO: label "CAGR" é focável (tem tooltip)', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));
    const textarea = await screen.findByPlaceholderText(/"range":/);
    fireEvent.change(textarea, { target: { value: REPORT_JSON_COM_CURVE } });
    fireEvent.click(screen.getByText(/Analisar relatório colado/i));
    await screen.findByText('Expectância');

    // SummaryCard renderiza o gatilho como <button> nativo (sem `asChild`,
    // diferente do padrão `<span tabIndex={0}>` usado noutros lugares) —
    // um <button> já é focável por padrão, sem precisar de tabIndex
    // explícito, então o discriminador aqui é a própria tag.
    const cagr = await screen.findByText('CAGR');
    expect(cagr.tagName).toBe('BUTTON');
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

// Achado A-6 do Raio-X de UI/UX (2ª sub-rodada, Grupo 1): o botão "Parar
// de acompanhar este run" (TriggerBacktestPanel, ícone-só) usava `title=`
// nativo. Migrado pro Tooltip do Radix + `aria-label` (sem o aria-label,
// perderia o nome acessível por completo). O botão só aparece com um run
// em polling (`isBusy && runId`) — pré-populamos o localStorage que o
// componente lê ao montar (mesmo mecanismo de retomada após reload já
// usado em produção) em vez de simular o fluxo completo de disparo.
describe('Backtest — botão "Parar de acompanhar" (TriggerBacktestPanel) usa Tooltip em vez de title= (achado A-6)', () => {
  afterEach(() => localStorage.removeItem('sentinel_backtest_trigger_v1'));

  it('REGRESSÃO: não tem title= nativo, mantém nome acessível via aria-label', async () => {
    localStorage.setItem('sentinel_backtest_trigger_v1', JSON.stringify({ runId: 'run123', htmlUrl: null, trialLabel: null }));
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));

    const cancelButton = await screen.findByRole('button', { name: /Parar de acompanhar este run/i });
    expect(cancelButton.getAttribute('title')).toBeNull();
  });
});

// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 2ª sub-rodada): 4 campos desta página usavam `outline-none` sem
// substituto visível de foco — mesmo achado/fix de TriggerBacktestPanel.jsx
// (1ª sub-rodada): "Capital inicial" (aba "Desempenho Real", só aparece com
// relatório carregado), "Ativo"/"Período (candles)" (aba "Ajuste Fino") e o
// textarea "— ou cole o JSON —" (aba "Simulação").
describe('Backtest — campos têm foco visível (achado A-7)', () => {
  it('REGRESSÃO: "Capital inicial" tem focus-visible:ring', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));
    const textarea = await screen.findByPlaceholderText(/"range":/);
    fireEvent.change(textarea, { target: { value: REPORT_JSON_COM_CURVE } });
    fireEvent.click(screen.getByText(/Analisar relatório colado/i));
    await screen.findByText('Expectância');

    const capitalInicial = await screen.findByText('Capital inicial');
    const input = capitalInicial.parentElement.querySelector('input');
    expect(input.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });

  it('REGRESSÃO: "Ativo" e "Período (candles)" (aba Ajuste Fino) têm focus-visible:ring', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByText(/Ajuste Fino \(What-If\)/i));

    const ativoSelect = screen.getByText('Ativo').parentElement.querySelector('select');
    const periodoSelect = screen.getByText('Período (candles)').parentElement.querySelector('select');
    expect(ativoSelect.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
    expect(periodoSelect.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });

  it('REGRESSÃO: textarea "— ou cole o JSON —" tem focus-visible:ring', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));

    const textarea = await screen.findByPlaceholderText(/"range":/);
    expect(textarea.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });
});

// Achado M-9 do Raio-X de UI/UX (docs/known-risks.md item 222/223, sub-rodada
// B): os 4 gráficos Recharts desta página (curva ingênua, distribuição de
// resultados, curva de capital real, funil de rejeição de entrada) não
// tinham `role="img"`/`aria-label` — ResponsiveContainer não repassa esses
// atributos pro <div> interno (confirmado lendo node_modules/recharts), daí
// o wrapper <div> em volta é quem carrega o role/aria-label. O aria-label
// cita os dados subjacentes (não só uma contagem/rótulo genérico) — lição do
// achado do Codex review no PR #426 (M-9 sub-rodada A), que pegou um
// aria-label incompleto escondendo dado real de leitor de tela.
const REPORT_JSON_M9 = JSON.stringify({
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
  overall: {
    ...CASCADE_STATS, total: 2, counted: 2, wins: 1, losses: 1,
    curve: [
      {
        cumulativePct: 1.5, outcome: 'WIN',
        op: {
          id: 'op1', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY',
          status: 'TP2_HIT', entry_price: 60000, initial_stop: 59000,
          current_stop: 59000, exit_price: 61000,
          tp2_hit_at: '2026-01-03T00:00:00.000Z', closed_at: '2026-01-03T00:00:00.000Z',
          created_date: '2026-01-01T00:00:00.000Z',
        },
      },
      {
        cumulativePct: -0.17, outcome: 'LOSS',
        op: {
          id: 'op2', asset_id: 'a2', symbol: 'ETHUSDT', side: 'SELL',
          status: 'STOP_HIT', entry_price: 3000, initial_stop: 3100,
          current_stop: 3100, exit_price: 3100,
          stop_hit_at: '2026-01-05T00:00:00.000Z', closed_at: '2026-01-05T00:00:00.000Z',
          created_date: '2026-01-02T00:00:00.000Z',
        },
      },
    ],
  },
  byCascade: { '4h_15m': CASCADE_STATS },
  costs: { model: {} },
  entryFunnel: {
    '4h_15m': { byReason: { adx_low: 3, choppiness: 2 } },
    '1h_5m': { byReason: { adx_low: 1, choppiness: 4 } },
  },
});

describe('Backtest — gráficos Recharts têm role="img"/aria-label descrevendo os dados (achado M-9)', () => {
  it('REGRESSÃO: os 4 gráficos (curva ingênua, distribuição, capital real, funil) expõem role=img com aria-label com dados', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));
    const textarea = await screen.findByPlaceholderText(/"range":/);
    fireEvent.change(textarea, { target: { value: REPORT_JSON_M9 } });
    fireEvent.click(screen.getByText(/Analisar relatório colado/i));
    await screen.findByText('Expectância');

    const images = await screen.findAllByRole('img');
    const labels = images.map(el => el.getAttribute('aria-label')).filter(Boolean);

    expect(labels.some(l => l.includes('curva ingênua de PnL acumulado') && l.includes('2 operações'))).toBe(true);
    expect(labels.some(l => l.includes('distribuição de resultados') && l.includes('Vitórias 1') && l.includes('Derrotas 1'))).toBe(true);
    expect(labels.some(l => l.includes('curva de capital real') && l.includes('capital final $'))).toBe(true);
    expect(labels.some(l =>
      l.includes('funil de rejeição de entrada')
      && l.includes('adx_low: 3 em 4h→15m, 1 em 1h→5m')
      && l.includes('choppiness: 2 em 4h→15m, 4 em 1h→5m')
    )).toBe(true);
  });

  // Achado do Codex review no PR #428: com nº de operações sem teto (ao
  // contrário dos widgets do Dashboard, com poucas categorias fixas),
  // enumerar tudo no aria-label seria impraticável — o dado ponto a ponto
  // (operação/símbolo/resultado/capital) vai numa tabela `sr-only` (oculta
  // visualmente, presente na árvore de acessibilidade) linkada via
  // aria-details (não aria-describedby — achado do Codex review no PR #429,
  // item 228: aria-describedby colapsaria a tabela num texto único),
  // mantendo o aria-label como resumo curto.
  it('REGRESSÃO: curva ingênua e curva de capital real têm tabela sr-only com dado ponto a ponto, linkada via aria-details', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));
    const textarea = await screen.findByPlaceholderText(/"range":/);
    fireEvent.change(textarea, { target: { value: REPORT_JSON_M9 } });
    fireEvent.click(screen.getByText(/Analisar relatório colado/i));
    await screen.findByText('Expectância');

    const images = await screen.findAllByRole('img');
    const equityCurveImg = images.find(el => (el.getAttribute('aria-label') || '').includes('curva ingênua de PnL acumulado'));
    const realEquityImg = images.find(el => (el.getAttribute('aria-label') || '').includes('curva de capital real'));
    expect(equityCurveImg).toBeTruthy();
    expect(realEquityImg).toBeTruthy();

    const equityCurveTableId = equityCurveImg.getAttribute('aria-details');
    const realEquityTableId = realEquityImg.getAttribute('aria-details');
    expect(equityCurveTableId).toBeTruthy();
    expect(realEquityTableId).toBeTruthy();

    const equityCurveTable = document.getElementById(equityCurveTableId);
    const realEquityTable = document.getElementById(realEquityTableId);
    expect(equityCurveTable).toBeTruthy();
    expect(realEquityTable).toBeTruthy();
    expect(equityCurveTable.className).toMatch(/sr-only/);
    expect(realEquityTable.className).toMatch(/sr-only/);

    // BTCUSDT/ETHUSDT são os 2 símbolos das operações da fixture — precisam
    // aparecer linha a linha nas 2 tabelas, não só resumidos.
    expect(equityCurveTable.textContent).toMatch(/BTCUSDT/);
    expect(equityCurveTable.textContent).toMatch(/ETHUSDT/);
    expect(realEquityTable.textContent).toMatch(/BTCUSDT/);
    expect(realEquityTable.textContent).toMatch(/ETHUSDT/);
  });
});

// Relatório COM reproducibility.pineConfig — habilita o botão "Aplicar ao
// Scanner" (o REPORT_JSON padrão deste arquivo omite de propósito, pro
// caso do botão desabilitado do describe A-6 acima).
const REPORT_JSON_COM_PINECONFIG = JSON.stringify({
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
  overall: { ...CASCADE_STATS, total: 10, counted: 10, wins: 6, losses: 4 },
  byCascade: { '4h_15m': CASCADE_STATS },
  costs: { model: {} },
  trialLabel: 'trial-teste',
  reproducibility: { pineConfig: { minScore: 80 }, configHash: 'abc123' },
});

// Achado da varredura pós-Raio-X, Round 2 (2026-09-27): "Aplicar ao
// Scanner" usava window.confirm() nativo (quebra o tema escuro) — migrado
// pro AlertDialog já existente e nunca usado. Mock próprio (a fixture
// compartilhada `makeFakeBackendModule` não tem `StrategyConfig.set`) pra
// poder confirmar chamada/não-chamada e o estado "Aplicado!" pós-confirmação.
describe('Backtest — "Aplicar ao Scanner" usa AlertDialog em vez de confirm() nativo (Round 2 pós-Raio-X)', () => {
  afterEach(() => {
    vi.doUnmock('@/api/entities');
    vi.resetModules();
  });

  it('REGRESSÃO: diálogo mostra o trial; Cancelar não chama StrategyConfig.set; confirmar aplica e mostra "Aplicado!"', async () => {
    const setMock = vi.fn(async (id, data) => ({ id, ...data }));
    vi.doMock('@/api/entities', async () => {
      const { makeFakeBackendModule } = await import('./__fixtures__/renderPage.jsx');
      const base = makeFakeBackendModule({ populated: false }).backend;
      return { backend: { ...base, entities: { ...base.entities, StrategyConfig: { ...base.entities.StrategyConfig, set: setMock } } } };
    });
    vi.resetModules();
    const { default: BacktestFresh } = await import('./Backtest.jsx');
    renderPage(<BacktestFresh />);

    fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));
    const textarea = await screen.findByPlaceholderText(/"range":/);
    fireEvent.change(textarea, { target: { value: REPORT_JSON_COM_PINECONFIG } });
    fireEvent.click(screen.getByText(/Analisar relatório colado/i));
    await screen.findByText('Expectância');

    fireEvent.click(screen.getByText('Aplicar ao Scanner'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/trial-teste/)).toBeTruthy();

    fireEvent.click(within(dialog).getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(setMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Aplicar ao Scanner'));
    const dialog2 = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog2).getByText('Aplicar'));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith('current', expect.objectContaining({ minScore: 80 })));
    await screen.findByText('Aplicado!');
  });
});

// Round 4 da nova varredura pós-Raio-X (2026-09-27): faixas de cor de Win
// Rate/Drawdown/Profit Factor passaram a vir de src/lib/metricColorRanges.js
// em vez de expressões inline por arquivo — inclui 2 correções reais: o
// glow do card "Taxa de acerto" era fixo ciano (não acompanhava a cor do
// valor) e o Profit Factor ganhou o estado "Marginal" (antes só existia em
// PerformanceReport.jsx).
const REPORT_JSON_COR_FAIXAS = JSON.stringify({
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
  overall: {
    ...CASCADE_STATS, total: 10, counted: 10, wins: 4, losses: 6,
    winRate: 40, profitFactor: 1.2, maxDrawdownPct: 20,
  },
  byCascade: { '4h_15m': CASCADE_STATS },
  costs: { model: {} },
});

describe('Backtest — Win Rate/Drawdown/Profit Factor com cor compartilhada (Round 4 pós-Raio-X)', () => {
  it('REGRESSÃO: Win Rate 40% (abaixo de 50%) tem glow laranja, não mais o glow ciano fixo', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));
    const textarea = await screen.findByPlaceholderText(/"range":/);
    fireEvent.change(textarea, { target: { value: REPORT_JSON_COR_FAIXAS } });
    fireEvent.click(screen.getByText(/Analisar relatório colado/i));
    await screen.findByText('Expectância');

    const wrLabel = screen.getAllByText('Taxa de acerto').find(el => el.tagName === 'SPAN');
    const wrCard = wrLabel.closest('.relative.overflow-hidden');
    const glow = wrCard.querySelector('.absolute.top-0.right-0');
    expect(glow.style.background).toMatch(/rgba\(255,159,67/);
  });

  it('REGRESSÃO: Profit Factor 1.2 mostra "⚠ Marginal" em laranja (não mais "⚠ Baixo" dividindo cor com Baixo)', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));
    const textarea = await screen.findByPlaceholderText(/"range":/);
    fireEvent.change(textarea, { target: { value: REPORT_JSON_COR_FAIXAS } });
    fireEvent.click(screen.getByText(/Analisar relatório colado/i));
    await screen.findByText('Expectância');

    expect(screen.getByText('⚠ Marginal')).toBeTruthy();
    expect(screen.queryByText('⚠ Baixo')).toBeNull();
  });

  it('REGRESSÃO: Máx. Drawdown 20% (acima de 15%) fica vermelho, mesma faixa de PerformanceMetricsBar.jsx', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));
    const textarea = await screen.findByPlaceholderText(/"range":/);
    fireEvent.change(textarea, { target: { value: REPORT_JSON_COR_FAIXAS } });
    fireEvent.click(screen.getByText(/Analisar relatório colado/i));
    await screen.findByText('Expectância');

    const ddValue = screen.getByText('-20.00%');
    expect(ddValue.style.color).toBe('rgb(255, 20, 120)');
  });
});

// Round 4 da nova varredura pós-Raio-X (2026-09-27): os 2 gráficos de
// equity (curva ingênua + curva de capital real) ganharam o mesmo padrão
// já em produção em src/components/trades/PnLChart.jsx — Area + gradiente
// + ReferenceLine — que antes não tinham (LineChart simples, cor fixa).
// jsdom não mede o ResponsiveContainer (fica 0x0 mesmo com o polyfill de
// ResizeObserver — confirmado, mesma limitação de PnLChart.test.jsx, que
// por isso nunca testa o SVG interno do gráfico, só role="img"/aria-label/
// tabela sr-only) — o teste abaixo confirma que o markup de acessibilidade
// continua intacto após a troca de LineChart pra AreaChart; a prova visual
// do gradiente/ReferenceLine em si é feita rodando a página real (ver
// verificação final da rodada).
describe('Backtest — gráficos de equity mantêm acessibilidade após virar Area+gradiente+ReferenceLine (Round 4 pós-Raio-X)', () => {
  it('REGRESSÃO: role=img/aria-label/tabela sr-only dos 2 gráficos continuam intactos', async () => {
    renderPage(<Backtest />);
    fireEvent.click(await screen.findByText(/Simulação \(GitHub\)/i));
    const textarea = await screen.findByPlaceholderText(/"range":/);
    fireEvent.change(textarea, { target: { value: REPORT_JSON_COM_CURVE } });
    fireEvent.click(screen.getByText(/Analisar relatório colado/i));
    await screen.findByText('Expectância');

    const images = screen.getAllByRole('img');
    expect(images.some(img => img.getAttribute('aria-label')?.includes('Gráfico de área da curva ingênua'))).toBe(true);
    expect(images.some(img => img.getAttribute('aria-label')?.includes('Gráfico de área da curva de capital real'))).toBe(true);
  });
});
