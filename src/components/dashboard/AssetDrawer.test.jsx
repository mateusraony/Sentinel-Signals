// @vitest-environment jsdom
//
// Refinamentos (seção E do Raio-X de UI/UX): a lista "Sinais Recentes" tinha
// campos sem rótulo — timeframe, motivo (reason) e horário relativo
// apareciam nus, sem indicar o que representavam (BUY/SELL e "Confl." já
// eram autoexplicativos, por isso ficaram de fora). Componente não tinha
// teste dedicado antes.
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within, act, fireEvent } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AssetDrawer from './AssetDrawer.jsx';

vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));
// Funding só é buscado pelo FundingLine, depois de "Dados técnicos" aberto.
const fetchMarkPriceMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/marketDataProvider', () => ({ fetchMarkPrice: (...args) => fetchMarkPriceMock(...args) }));

const ASSET = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', exchange: 'binance' };

const SIGNAL = {
  id: 'sig1', asset_id: 'a1', signal_type: 'BUY', timeframe: '4h',
  price_at_signal: 65000, reason: 'Confluência de RF + estrutura SMC',
  created_date: '2026-09-26T10:00:00.000Z',
};

afterEach(() => cleanup());

function renderDrawer(props) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AssetDrawer
        asset={ASSET}
        signals={[SIGNAL]}
        tradeOps={[]}
        onClose={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('AssetDrawer — "Sinais Recentes" tem rótulos inline (Refinamentos)', () => {
  it('REGRESSÃO: timeframe, motivo e horário aparecem rotulados, não nus', async () => {
    renderDrawer({});

    await screen.findByText('BTC/USDT');
    expect(screen.getByText('TF')).toBeTruthy();
    expect(screen.getByText(/Motivo:/)).toBeTruthy();
    expect(screen.getByText(/Quando:/)).toBeTruthy();
    // O conteúdo original continua presente, só ganhou o prefixo.
    expect(screen.getByText('4H')).toBeTruthy();
    // A tese também aparece na seção "Por quê?" (fechada); o motivo da lista fica ao lado do rótulo.
    expect(screen.getByText(/Motivo:/).parentElement.textContent).toMatch(/Confluência de RF \+ estrutura SMC/);
  });
});

// Achado da varredura pós-Raio-X, Round 3 (2026-09-27): "Nenhuma operação
// registrada."/"Nenhum sinal registrado." não diziam quando algo apareceria
// — beco sem saída (é uma gaveta por-ativo, sem filtro pra limpar nem outra
// tela pra linkar, então a ação certa é reassurance textual).
describe('AssetDrawer — empty states de Operações/Sinais explicam quando algo vai aparecer (Round 3 pós-Raio-X)', () => {
  it('REGRESSÃO: sem operações, mostra reassurance em vez de só "Nenhuma operação registrada."', async () => {
    renderDrawer({ signals: [], tradeOps: [] });
    await screen.findByText('BTC/USDT');
    expect(screen.getByText(/Nenhuma operação registrada ainda — abre aqui quando o motor confirmar um sinal/)).toBeTruthy();
  });

  it('REGRESSÃO: sem sinais, mostra reassurance em vez de só "Nenhum sinal registrado."', async () => {
    renderDrawer({ signals: [], tradeOps: [] });
    await screen.findByText('BTC/USDT');
    expect(screen.getByText(/Nenhum sinal registrado ainda — aparece aqui quando o scan encontrar uma oportunidade/)).toBeTruthy();
  });
});

// Fase 1, passo 2 (docs/known-risks.md item 256): N1 do Decision Card — estado,
// níveis, ação e frescor REAL no lugar do "LIVE" verde fixo. Tudo vem do
// presenter (`decisionCardPresenter.js`); o drawer não busca nem recalcula nada.
const NOW = Date.parse('2026-10-03T18:00:00.000Z');
const MIN = 60 * 1000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const FRESH_ASSET = { ...ASSET, is_active: true, last_scan_at: iso(5 * MIN) };
const STATE_4H = {
  asset_id: 'a1', timeframe: '4h', last_close: 68200, last_candle_time: '2026-10-03T16:00:00.000Z',
  rf_direction: 1, rsi_zone: 'neutral', macd_histogram: 0.5, trend_ema: 'bullish',
};
const FRESH_SIGNAL = {
  ...SIGNAL, source: 'range_filter', created_date: iso(30 * MIN), context: { score: 82, reasons: [] },
};
const ACTIVE_OP = {
  id: 'op1', asset_id: 'a1', side: 'BUY', timeframe: '15m', signal_timeframe: '4h',
  status: 'RUNNER_ACTIVE', entry_price: 100, initial_stop: 95, current_stop: 100,
  tp1: 105, tp2: 110, rr_at_entry: 1.5, score: 82, created_date: iso(2 * 60 * MIN),
};

function renderN1(props) {
  return renderDrawer({ asset: FRESH_ASSET, signals: [FRESH_SIGNAL], assetStates: [STATE_4H], now: NOW, ...props });
}
const summary = () => within(screen.getByRole('region', { name: 'Resumo da decisão' }));

describe('AssetDrawer N1 — frescor real no lugar do "LIVE" fixo', () => {
  it('REGRESSÃO: ativo sem leitura nunca aparece como LIVE', async () => {
    renderN1({ asset: ASSET });
    await screen.findByText('BTC/USDT');
    expect(screen.getByText('SEM LEITURA')).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('ativo com scan recente = LIVE + idade do scan', async () => {
    renderN1();
    await screen.findByText('BTC/USDT');
    expect(screen.getByText('LIVE')).toBeTruthy();
    expect(screen.getByText(/scan há 5 min/)).toBeTruthy();
  });

  it('REGRESSÃO: ativo parado há 45 min = STALE (e não LIVE)', async () => {
    renderN1({ asset: { ...FRESH_ASSET, last_scan_at: iso(45 * MIN) } });
    await screen.findByText('BTC/USDT');
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('erro persistente de leitura = ERRO', async () => {
    renderN1({ asset: { ...FRESH_ASSET, scan_error_since: iso(40 * MIN) } });
    await screen.findByText('BTC/USDT');
    expect(screen.getByText('ERRO')).toBeTruthy();
  });
});

describe('AssetDrawer N1 — sinal sem operação', () => {
  it('mostra o estado derivado, último fechamento, "níveis não definidos" e o score com a ressalva', async () => {
    renderN1();
    await screen.findByText('BTC/USDT');
    const s = summary();
    expect(s.getByText('Aguardando confirmação · BUY')).toBeTruthy();
    expect(s.getByText(/\$68,200\.00/)).toBeTruthy();
    expect(s.getByText(/candle 03\/10 13:00 BRT/)).toBeTruthy();
    expect(s.getByText(/Níveis: ainda não definidos/)).toBeTruthy();
    expect(s.getByText(/Score técnico 82\/100/)).toBeTruthy();
    expect(s.getByText(/não é probabilidade/)).toBeTruthy();
  });

  it('evento informativo (MACD 4h) nunca é "aguardando confirmação"', async () => {
    renderN1({ signals: [{ ...FRESH_SIGNAL, source: 'macd' }] });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText('Só informação · BUY')).toBeTruthy();
    expect(summary().queryByText(/Aguardando/)).toBeNull();
  });

  it('sem sinal nem operação: estado "none" explícito', async () => {
    renderN1({ signals: [], tradeOps: [] });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText('Sem sinal nem operação registrados')).toBeTruthy();
  });

  it('estados do ativo indisponíveis: nunca inventa o último fechamento', async () => {
    renderN1({ assetStates: [], statesUnavailable: true });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText(/Último fechamento: não foi possível carregar agora\./)).toBeTruthy();
  });

  it('sem AssetState (e sem erro): "indisponível", nunca 0', async () => {
    renderN1({ assetStates: [] });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText('Último fechamento: indisponível.')).toBeTruthy();
  });
});

describe('AssetDrawer N1 — operação ativa', () => {
  it('mostra estado, stop (com a postura), entrada, TP1, TP2 e R:R gravados', async () => {
    renderN1({ tradeOps: [ACTIVE_OP] });
    await screen.findByText('BTC/USDT');
    const s = summary();
    expect(s.getByText('Runner ativo (TP1 atingido)')).toBeTruthy();
    for (const label of ['Stop', 'Entrada', 'TP1', 'TP2', 'R:R']) expect(s.getByText(label)).toBeTruthy();
    expect(s.getByText('breakeven')).toBeTruthy();
    expect(s.getByText('1 : 1.5')).toBeTruthy();
    expect(s.getByText('$110.00')).toBeTruthy();
    expect(s.queryByText(/Níveis: ainda não definidos/)).toBeNull();
  });

  it('operação sem TP2 e sem R:R: "—", nunca 0', async () => {
    renderN1({ tradeOps: [{ ...ACTIVE_OP, tp2: undefined, rr_at_entry: undefined }] });
    await screen.findByText('BTC/USDT');
    expect(summary().getAllByText('—').length).toBe(2);
  });
});

describe('AssetDrawer N1 — erro de carregamento é fail-closed (itens 193-196)', () => {
  it('REGRESSÃO: operações indisponíveis + sinal existente NÃO afirma "aguardando confirmação"', async () => {
    renderN1({ tradeOpsUnavailable: true });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText(/Não foi possível carregar as operações agora — por isso/)).toBeTruthy();
    expect(summary().queryByText(/Aguardando/)).toBeNull();
    expect(summary().queryByText(/Score técnico/)).toBeNull();
  });

  it('sinais indisponíveis e nenhuma operação: não afirma "sem sinal"', async () => {
    renderN1({ signals: [], tradeOps: [], signalsUnavailable: true });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText(/Não foi possível carregar os sinais agora — por isso/)).toBeTruthy();
    expect(summary().queryByText('Sem sinal nem operação registrados')).toBeNull();
  });
});

describe('AssetDrawer N1 — layout e pureza', () => {
  it('largura: tela cheia no celular e sm:max-w-md no desktop (antes max-w-sm)', async () => {
    renderN1();
    await screen.findByText('BTC/USDT');
    const cls = screen.getByRole('dialog').className;
    expect(cls).toMatch(/\bw-full\b/);
    expect(cls).toMatch(/sm:max-w-md/);
    expect(cls).not.toMatch(/sm:max-w-sm/);
  });

  it('o drawer não busca dado nem calcula: só props + presenter (sem useQuery/entidades/funding)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/dashboard/AssetDrawer.jsx'), 'utf8');
    expect(src).not.toMatch(/useQuery|useFundingRate|@\/api\/entities|fetch\(/);
    expect(src).toMatch(/buildDecisionCard/);
  });
});

describe('AssetDrawer — relógio próprio (Codex #461: badge não pode congelar em LIVE)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('REGRESSÃO: sem mudar nenhuma prop, o badge passa de LIVE para STALE com o tempo', () => {
    // Sem `now` injetado: o drawer usa o próprio relógio.
    renderDrawer({ asset: FRESH_ASSET, signals: [FRESH_SIGNAL], assetStates: [STATE_4H] });
    expect(screen.getByText('LIVE')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(31 * MIN); });
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  // React Query/Radix também agendam timers: conta só os intervalos de 30 s do drawer.
  const tickIntervals = (spy) => spy.mock.calls.filter(([, ms]) => ms === 30 * 1000).length;

  it('o intervalo de 30 s é criado e limpo no desmonte', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderDrawer({ asset: FRESH_ASSET, signals: [FRESH_SIGNAL], assetStates: [STATE_4H] });
    expect(tickIntervals(setSpy)).toBe(1);
    const id = setSpy.mock.results.find((_, k) => setSpy.mock.calls[k][1] === 30 * 1000).value;
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(id);
  });

  it('com `now` injetado não cria intervalo', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    renderDrawer({ asset: FRESH_ASSET, signals: [FRESH_SIGNAL], assetStates: [STATE_4H], now: NOW });
    expect(tickIntervals(setSpy)).toBe(0);
  });

  it('operações carregando: mensagem discreta, nunca "Aguardando confirmação"', () => {
    renderDrawer({ asset: FRESH_ASSET, signals: [FRESH_SIGNAL], assetStates: [STATE_4H], now: NOW, tradeOpsLoading: true });
    expect(summary().getByRole('status').textContent).toBe('Carregando operações…');
    expect(summary().queryByText(/Aguardando/)).toBeNull();
  });
});

// Passo 3 (item 256): seção "Por quê?" em português simples. O presenter já
// entrega o conteúdo; o painel só mostra, fechado por padrão.
describe('AssetDrawer N2 — seção "Por quê?"', () => {
  const why = () => within(screen.getByRole('region', { name: 'Por quê' }));
  const toggle = () => screen.getByRole('button', { name: 'Por quê?' });
  const content = () => document.getElementById('decision-why-content');
  const SIGNAL_WITH_REASONS = {
    ...FRESH_SIGNAL, reason: 'BTC — compra no 4h', context: { score: 82, reasons: ['MACD hist positivo (+20)'] },
  };

  it('vem fechada por padrão (conteúdo escondido por CSS, mas montado) e abre ao tocar', () => {
    renderN1({ signals: [SIGNAL_WITH_REASONS] });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(content().className).toMatch(/\bhidden\b/);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(content().className).not.toMatch(/\bhidden\b/);
    fireEvent.click(toggle());
    expect(content().className).toMatch(/\bhidden\b/);
  });

  it('mostra tese e o que ajuda', () => {
    renderN1({ signals: [SIGNAL_WITH_REASONS] });
    expect(why().getByText('BTC — compra no 4h')).toBeTruthy();
    expect(why().getByText(/MACD hist positivo/)).toBeTruthy();
  });

  it('REGRESSÃO: sem nenhum "contra" registrado, diz "Nada registrado" e NUNCA sugere ausência de risco', () => {
    renderN1({ signals: [SIGNAL_WITH_REASONS] });
    expect(why().getByText('Nada registrado — isso não garante que não exista risco.')).toBeTruthy();
    expect(screen.queryByText(/nenhum risco|sem risco|tudo certo/i)).toBeNull();
  });

  it('o que atrapalha vem em linguagem simples, com a etiqueta de quando é (agora / no sinal)', () => {
    renderN1({
      signals: [{ ...SIGNAL_WITH_REASONS, context: { ...SIGNAL_WITH_REASONS.context, tf_1d_direction: -1 } }],
      assetStates: [{ ...STATE_4H, rsi_zone: 'overbought' }],
    });
    const li1 = why().getByText(/O preço já subiu muito \(RSI sobrecomprado\) agora no 4h/).closest('li');
    expect(li1.textContent).toMatch(/\[agora\]/);
    const li2 = why().getByText(/O gráfico de 1 dia aponta para o lado oposto/).closest('li');
    expect(li2.textContent).toMatch(/\[no sinal\]/);
    expect(why().queryByText(/Nada registrado — isso não garante/)).toBeNull();
  });

  it('o que anularia a ideia: "ainda não definido" sem operação; stop atual com operação', () => {
    renderN1({ signals: [SIGNAL_WITH_REASONS] });
    expect(why().getByText(/Ainda não definido — a operação ainda não existe/)).toBeTruthy();
    cleanup();
    renderN1({ signals: [], tradeOps: [ACTIVE_OP] });
    expect(why().getByText(/Stop atual: \$100/)).toBeTruthy();
    expect(why().queryByText(/Ainda não definido/)).toBeNull();
  });

  it('os gráficos concordam?: seta com texto acessível, "?" quando falta dado e etiqueta de origem', () => {
    renderN1({
      signals: [{ ...SIGNAL_WITH_REASONS, context: { ...SIGNAL_WITH_REASONS.context, tf_1d_direction: -1 } }],
      assetStates: [STATE_4H], // rf_direction 1 no 4h, nada no 1h
    });
    const items = why().getAllByRole('listitem').filter(li => li.getAttribute('aria-label'));
    expect(items.map(li => li.getAttribute('aria-label'))).toEqual([
      '1h: sem dado', '4h: compra (agora)', '1d: venda (no sinal)',
    ]);
    expect(why().getByText('?')).toBeTruthy();
  });

  it('REGRESSÃO (Codex #463): direção 0 é NEUTRO conhecido — não "sem dado"', () => {
    renderN1({
      signals: [{ ...SIGNAL_WITH_REASONS, context: { ...SIGNAL_WITH_REASONS.context, tf_1d_direction: 0 } }],
      assetStates: [STATE_4H],
    });
    const labels = why().getAllByRole('listitem').map(li => li.getAttribute('aria-label')).filter(Boolean);
    expect(labels).toContain('1d: neutro (no sinal)');
    expect(labels).toContain('1h: sem dado'); // o que realmente falta continua "sem dado"
    expect(why().getByText('neutro', { exact: false })).toBeTruthy();
  });

  it('REGRESSÃO (Codex #463): a evidência numérica do "contra" (rejeição pior) aparece junto do item', () => {
    const rejected = {
      ...SIGNAL_WITH_REASONS, last_rejection_reason: 'regime_rejected',
      decision_snapshot: {
        reason_code: 'regime_rejected', data_status: 'LIVE',
        evaluated_at: '2026-10-03T17:50:00.000Z', facts: { adx: 18, adx_min: 22 },
      },
    };
    renderN1({ signals: [rejected] });
    const items = why().getAllByRole('listitem');
    const withEvidence = items.find(li => /ADX/.test(li.textContent));
    expect(withEvidence, 'nenhum item mostra a evidência (ADX …)').toBeTruthy();
    expect(withEvidence.textContent).toMatch(/medido às/);
  });

  it('sem sinal, com erro ou carregando: a seção nem aparece (nada de afirmar sem dado)', () => {
    renderN1({ signals: [], tradeOps: [] });
    expect(screen.queryByRole('button', { name: 'Por quê?' })).toBeNull();
    cleanup();
    renderN1({ tradeOpsUnavailable: true });
    expect(screen.queryByRole('button', { name: 'Por quê?' })).toBeNull();
    cleanup();
    renderN1({ tradeOpsLoading: true });
    expect(screen.queryByRole('button', { name: 'Por quê?' })).toBeNull();
  });
});

// Passo 4 (item 256): "Dados técnicos" e "Histórico deste ativo", recolhidos por padrão.
describe('AssetDrawer N3 — "Dados técnicos" e "Histórico deste ativo"', () => {
  const techToggle = () => screen.getByRole('button', { name: /Dados técnicos/ });
  const techContent = () => document.getElementById('decision-tech-content');
  const historyToggle = () => screen.getByRole('button', { name: /Histórico deste ativo/ });
  const historyContent = () => document.getElementById('decision-history-content');
  const openTech = () => fireEvent.click(techToggle());

  beforeEach(() => { fetchMarkPriceMock.mockReset(); fetchMarkPriceMock.mockResolvedValue({ lastFundingRate: 0.0001, nextFundingTime: Date.parse('2026-10-03T24:00:00.000Z') }); });

  it('"Dados técnicos" vem fechado e NÃO busca funding até ser aberto', async () => {
    renderN1();
    expect(techToggle().getAttribute('aria-expanded')).toBe('false');
    expect(techContent().className).toMatch(/\bhidden\b/);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMarkPriceMock).not.toHaveBeenCalled();
    openTech();
    expect(techToggle().getAttribute('aria-expanded')).toBe('true');
    expect(techContent().className).not.toMatch(/\bhidden\b/);
    await screen.findByText(/Funding: \+0\.0100%/);
    expect(fetchMarkPriceMock).toHaveBeenCalledWith('BTCUSDT');
    expect(within(techContent()).getByText(/Informativo, não influencia o sinal/)).toBeTruthy();
  });

  it('funding indisponível: diz "indisponível", nunca um número', async () => {
    fetchMarkPriceMock.mockResolvedValue({ lastFundingRate: null, nextFundingTime: null });
    renderN1();
    openTech();
    await screen.findByText(/Funding: indisponível agora/);
    expect(screen.queryByText(/Funding: [+-]/)).toBeNull();
  });

  it('fonte dos dados: rótulos legíveis quando gravados; "não registrado" quando faltam', async () => {
    renderN1({
      tradeOps: [{ ...ACTIVE_OP, market_source: 'futures', executor: 'browser', decision_snapshot: { evaluated_at: '2026-10-03T16:00:00.000Z' } }],
    });
    openTech();
    let box = within(techContent());
    expect(box.getByText('Preços: Binance Futures')).toBeTruthy();
    expect(box.getByText('Lido por: este navegador')).toBeTruthy();
    expect(box.getByText(/Avaliação do motor: 03\/10 13:00 BRT/)).toBeTruthy();
    cleanup();
    renderN1();
    openTech();
    box = within(techContent());
    expect(box.getByText('Preços: não registrado')).toBeTruthy();
    expect(box.getByText('Lido por: não registrado')).toBeTruthy();
    expect(box.getByText('Avaliação do motor: não registrado')).toBeTruthy();
  });

  it('probabilidade: sempre "indisponível", sem nenhum número', () => {
    renderN1();
    openTech();
    expect(within(techContent()).getByText('Indisponível — score e histórico não são probabilidade calibrada.')).toBeTruthy();
    expect(techContent().textContent).not.toMatch(/\d+\s?%.*probab|probab.*\d+\s?%/i);
  });

  it('"Histórico deste ativo" vem fechado, com o contador, e mantém as listas montadas', () => {
    renderN1({ tradeOps: [ACTIVE_OP] });
    expect(historyToggle().getAttribute('aria-expanded')).toBe('false');
    expect(historyToggle().textContent).toMatch(/1 operações · 1 sinais/);
    expect(historyContent().className).toMatch(/\bhidden\b/);
    expect(within(historyContent()).getByText('Operações')).toBeTruthy();
    expect(within(historyContent()).getByText('Sinais Recentes')).toBeTruthy();
    fireEvent.click(historyToggle());
    expect(historyContent().className).not.toMatch(/\bhidden\b/);
  });

  it('a operação ativa não repete entrada/TP1/TP2 no histórico; operação encerrada continua mostrando', () => {
    renderN1({ tradeOps: [ACTIVE_OP, { ...ACTIVE_OP, id: 'op0', status: 'STOP_HIT', created_date: iso(48 * 60 * MIN) }] });
    const hist = within(historyContent());
    expect(hist.getAllByText('Níveis no resumo, acima.')).toHaveLength(1);
    // só a operação encerrada exibe a grade (Entrada/TP1/TP2)
    expect(hist.getAllByText('Entrada')).toHaveLength(1);
  });

  it('REGRESSÃO (Codex #465): duas pernas ativas no mesmo ativo — só a do resumo perde a grade; a outra mantém seus níveis', () => {
    const other = { ...ACTIVE_OP, id: 'op-smc', cascade: '1h_5m', signal_timeframe: '1h', entry_price: 61000, tp1: 62000, tp2: 63000, created_date: iso(5 * 60 * MIN) };
    renderN1({ tradeOps: [ACTIVE_OP, other] }); // ACTIVE_OP é a mais nova → é a do resumo
    const hist = within(historyContent());
    expect(hist.getAllByText('Níveis no resumo, acima.')).toHaveLength(1);
    expect(hist.getAllByText('Entrada')).toHaveLength(1); // a perna mais antiga ainda mostra Entrada/TP1/TP2
    expect(hist.getByText('$61,000.00')).toBeTruthy();
  });

  it('sem operação ativa, nada some do histórico', () => {
    renderN1({ tradeOps: [{ ...ACTIVE_OP, status: 'STOP_HIT' }] });
    expect(within(historyContent()).queryByText('Níveis no resumo, acima.')).toBeNull();
    expect(within(historyContent()).getByText('Entrada')).toBeTruthy();
  });
});
