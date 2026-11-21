/**
 * @vitest-environment jsdom
 *
 * Regressão: "Avisos em análise" mostrando um sinal como
 * "já passou / nenhuma operação foi aberta" para um ativo que TEM uma
 * `TradeOperation` genuinamente ativa (docs/known-risks.md item 174
 * addendum) — achado a partir de um print real do usuário (PENDLEUSDT/
 * ETHFIUSDT simultaneamente em "Avisos em análise" e "Operações Ativas").
 *
 * Causa raiz: `activeKey` (Trades.jsx) comparava `TradeOperation.timeframe`
 * (timeframe de EXECUÇÃO — '15m'/'5m') contra `SignalEvent.timeframe`
 * (timeframe do SINAL — '4h'/'1h') — as duas chaves nunca batiam para
 * nenhuma operação da cascata nativa, então o aviso do sinal que abriu a
 * operação nunca era escondido.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderPage, makeTestQueryClient } from './__fixtures__/renderPage.jsx';

const SIGNAL_4H = {
  id: 'sig1', asset_id: 'a1', symbol: 'PENDLEUSDT', timeframe: '4h',
  signal_type: 'BUY', source: 'range_filter', dedup_key: 'sig1',
  price_at_signal: 1.0, candle_time: '2026-09-13T09:00:00.000Z',
  created_date: '2026-09-13T09:00:00.000Z',
  // Mais de 4h atrás — teria sido marcado expired_logged pelo scanner.js
  // mesmo tendo gerado a operação abaixo (bug corrigido em scanner.js junto
  // com este, ver known-risks item 174 addendum).
  expired_logged: true,
};

const ACTIVE_OP = {
  id: 'trade_sig1', asset_id: 'a1', symbol: 'PENDLEUSDT', side: 'BUY',
  status: 'RUNNER_ACTIVE', timeframe: '15m', signal_timeframe: '4h',
  cascade: '4h_15m', entry_price: 1.0, initial_stop: 0.9,
  current_stop: 1.0, tp1: 1.1, tp2: 1.2, tp1_hit: true, partial_percent: 50,
  created_date: '2026-09-13T09:05:00.000Z',
};

function mockBackend({ operations, signals, transitionTradeOp, assets = [] }) {
  vi.doMock('@/api/entities', () => ({
    backend: {
      entities: {
        MonitoredAsset: { list: async () => assets, filter: async () => assets },
        TradeOperation: { list: async () => operations, filter: async () => operations },
        SignalEvent: {
          list: async () => signals,
          filter: async () => signals,
          update: async (id, data) => ({ id, ...data }),
        },
      },
      tradeOps: { transitionTradeOp: transitionTradeOp || (async () => ({ applied: false })) },
    },
  }));
  vi.doMock('@/lib/marketDataProvider', () => ({
    fetchCandles: async () => [],
    fetchCurrentPrice: async () => null,
    fetch24hStats: async () => null,
    MARKET_SOURCE: 'spot',
    DATA_EXCHANGE: 'binance',
    EXECUTOR: 'browser',
  }));
}

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.doUnmock('@/api/entities');
  vi.doUnmock('@/lib/marketDataProvider');
});

// jsdom não implementa ResizeObserver — necessário só quando `history` tem
// operações (o bloco "Performance Report + Charts", recharts, monta). Mesmo
// polyfill mínimo de src/pages/pagesSmoke.test.jsx, não um mecanismo novo.
beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

describe('Trades — "Avisos em análise" nunca contradiz "Operações Ativas"', () => {
  it('esconde o aviso de um sinal cuja operação já está ativa', async () => {
    mockBackend({ operations: [ACTIVE_OP], signals: [SIGNAL_4H] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    // A operação ativa aparece em "Operações Ativas"... (getByText/findByText
    // lançam se não achar — a própria chamada já é a asserção "existe"; sem
    // @testing-library/jest-dom neste projeto, ver TradeCard.test.jsx).
    await screen.findByText('Operações Ativas');
    await screen.findByText('PENDLE/USDT');

    // ...e o sinal que a originou NUNCA deve aparecer como "Avisos em
    // análise" dizendo que nenhuma operação foi aberta — antes da correção,
    // a chave `${symbol}_${timeframe}` não batia e este texto aparecia.
    expect(screen.queryByRole('heading', { name: 'Avisos em análise' })).toBeNull();
    expect(screen.queryByText(/nenhuma operação foi aberta/i)).toBeNull();
  });

  it('sem operação ativa correspondente, o aviso expirado aparece normalmente', async () => {
    mockBackend({ operations: [], signals: [SIGNAL_4H] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText('PENDLE/USDT');
    await screen.findByText(/nenhuma operação foi aberta/i);
  });

  // docs/known-risks.md item 175 — SIGNAL_4H não tem last_rejection_reason
  // (nunca foi reavaliado pelo laço de retry que grava o campo). Antes da
  // correção, o card "Já passou" mostrava "Aviso recém-chegado... refaz a
  // conta a cada 5 minutos" — texto de sinal FRESCO num aviso com horas de
  // idade, achado a partir do print real do usuário.
  it('sinal expirado sem motivo salvo não finge que ainda está sendo checado a cada 5 minutos', async () => {
    mockBackend({ operations: [], signals: [SIGNAL_4H] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText('PENDLE/USDT');
    expect(screen.queryByText(/rec[ée]m-chegado/i)).toBeNull();
    expect(screen.queryByText(/a cada \d+ minutos/i)).toBeNull();
  });
});

// Achado de clareza (pedido do usuário, 2026-09-18): "Histórico Completo"
// (HistoryRow) era a seção mais vaga de todas — nenhum "por quê" visível,
// só um status badge de 1-2 palavras + o motivo escondido num `title=`
// (tooltip que morre no toque em mobile).
const CLOSED_OP_COM_SNAPSHOT = {
  id: 'op_hist1', asset_id: 'a3', symbol: 'SOLUSDT', side: 'BUY',
  status: 'STOP_HIT', timeframe: '15m', signal_timeframe: '4h',
  entry_price: 100, initial_stop: 95, current_stop: 95, tp1: 110, tp2: 120,
  exit_price: 95, tp1_hit: false, created_date: '2026-09-18T09:00:00.000Z',
  stop_hit_at: '2026-09-18T10:00:00.000Z', closed_at: '2026-09-18T10:00:00.000Z',
  decision_snapshot: {
    decision: 'EXIT', reason_code: 'stop_hit_pre_tp1',
    facts: { stop: 95, stop_check_price: 94.8 }, data_status: 'LIVE',
  },
};

// Achado de clareza (pedido do usuário, 2026-09-18): "Avisos em análise"
// (MonitoringCard) só usava rejectionCopy() — a frase categórica, nunca a
// evidência numérica de explainDecision (Fase 1 do Explainability V2, já
// consumida em outras telas).
const SIGNAL_WAITING_COM_EVIDENCIA = {
  id: 'sig_wait1', asset_id: 'a4', symbol: 'ADAUSDT', timeframe: '4h',
  signal_type: 'BUY', source: 'range_filter', dedup_key: 'sig_wait1',
  price_at_signal: 0.5, candle_time: '2026-09-18T09:00:00.000Z',
  created_date: '2026-09-18T09:00:00.000Z',
  last_rejection_reason: 'regime_rejected', last_rejection_detail: 'adx',
  decision_snapshot: {
    decision: 'ENTRY_BLOCKED', reason_code: 'regime_rejected', reason_detail: 'adx',
    facts: { adx: 14.2, adx_min: 20, chop: 40, chop_max: 58, tier: 'T2' },
    data_status: 'LIVE', evaluated_at: '2026-09-18T09:00:00.000Z', executor: 'cron',
  },
};

describe('Trades — "Avisos em análise" (MonitoringCard) mostra a evidência numérica', () => {
  it('REGRESSÃO: o número medido (ADX/Chop) aparece, não só a frase categórica', async () => {
    mockBackend({ operations: [], signals: [SIGNAL_WAITING_COM_EVIDENCIA] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText('ADA/USDT');
    // "força do movimento (ADX) 14.2 — mínimo exigido 20" é a evidência de
    // regime_rejected (decisionExplanation.js's formatEvidence).
    await screen.findByText(/ADX\) 14\.2 — mínimo exigido 20/i);
  });
});

// Refinamentos (seção E do Raio-X): o toggle global "Compacto/Detalhado"
// (showDetails, passado como expandAll pra TradeCard) não tinha efeito
// nenhum sobre MonitoringCard — cada "Aviso em análise" tinha seu próprio
// showDetails local, sempre começando fechado, ignorando o toggle da página.
describe('Trades — toggle "Compacto/Detalhado" também abre os cards de "Avisos em análise" (Refinamentos)', () => {
  it('REGRESSÃO: clicar em "Compacto" (vira "Detalhado") expande o MonitoringCard sem precisar clicar em "Detalhes técnicos"', async () => {
    // Precisa de um sinal na fase WAITING (não EXPIRED) — a fase EXPIRED
    // usa um JSX totalmente diferente, sem o toggle "Detalhes técnicos".
    // created_date "agora" garante que a janela de confirmação (4h) ainda
    // não passou.
    const SIGNAL_WAITING_FRESH = {
      id: 'sig_fresh1', asset_id: 'a5', symbol: 'DOTUSDT', timeframe: '4h',
      signal_type: 'BUY', source: 'range_filter', dedup_key: 'sig_fresh1',
      price_at_signal: 5.0, candle_time: new Date().toISOString(),
      created_date: new Date().toISOString(),
    };
    mockBackend({ operations: [], signals: [SIGNAL_WAITING_FRESH] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText('DOT/USDT');
    // "Gráfico de {timeframe}" é quebrado em 2 nós de texto pelo JSX
    // ({signal.timeframe?.toUpperCase()} interpolado) — matcher por função
    // olha o textContent do elemento inteiro, não um nó de texto isolado.
    const graficoMatcher = (_, el) => el.textContent === 'Gráfico de 4H';
    expect(screen.queryByText(graficoMatcher)).toBeNull();

    fireEvent.click(screen.getByText('Compacto'));

    await screen.findByText(graficoMatcher);
  });
});

// Auditoria do Telegram (2026-09-29), item 1.11 — `<ScoreBar score={signal.
// context?.score || 0} />` renderizava a barra em "〰 Fraco"/"0/100" pra
// qualquer sinal sem context.score, como se fosse uma confluência real e
// baixa medida, em vez de simplesmente não se aplicar. "Avisos em análise"
// só lista sinais `source === 'range_filter'` (Trades.jsx:557 — SMC/MACD/
// EMA/RSI nunca chegam aqui, achado durante a implementação deste item), e
// RF normalmente sempre carrega score — guard defensivo pra um
// context.score ausente/malformado, mesma categoria de robustez já aplicada
// em Alerts.jsx/AssetCard.jsx. Timeframe 4h (não 1h) porque só a cascata 4h
// alimenta a fila "acionável" (Trades.jsx:564-567) — um sinal 1h cai no
// acordeão "Sinais informativos", fechado por padrão.
describe('Trades — ScoreBar de "Avisos em análise" omite score falso quando context.score está ausente (Auditoria do Telegram, item 1.11)', () => {
  it('REGRESSÃO: sinal sem context.score não mostra ScoreBar nenhuma nos detalhes técnicos', async () => {
    const SIGNAL_SEM_SCORE = {
      id: 'sig_smc1', asset_id: 'a6', symbol: 'LINKUSDT', timeframe: '4h',
      signal_type: 'BUY', source: 'range_filter', dedup_key: 'sig_smc1',
      price_at_signal: 15.0, candle_time: new Date().toISOString(),
      created_date: new Date().toISOString(), context: {},
    };
    mockBackend({ operations: [], signals: [SIGNAL_SEM_SCORE] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText('LINK/USDT');
    fireEvent.click(screen.getByText('Compacto')); // expande "Detalhes técnicos" de todos os cards

    await screen.findByText((_, el) => el.textContent === 'Gráfico de 4H');
    expect(screen.queryByText('〰 Fraco')).toBeNull();
    expect(screen.queryByText('0/100')).toBeNull();
  });

  it('sinal com score real continua mostrando a ScoreBar', async () => {
    const SIGNAL_RF_COM_SCORE = {
      id: 'sig_rf1', asset_id: 'a7', symbol: 'AVAXUSDT', timeframe: '4h',
      signal_type: 'BUY', source: 'range_filter', dedup_key: 'sig_rf1',
      price_at_signal: 20.0, candle_time: new Date().toISOString(),
      created_date: new Date().toISOString(), context: { score: 72 },
    };
    mockBackend({ operations: [], signals: [SIGNAL_RF_COM_SCORE] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText('AVAX/USDT');
    fireEvent.click(screen.getByText('Compacto'));

    await screen.findByText('🧩 72/100');
  });
});

describe('Trades — "Histórico Completo" (HistoryRow) mostra o "por quê" sem precisar de hover', () => {
  it('REGRESSÃO: o texto de explicação aparece direto na linha, não só num title= (tooltip)', async () => {
    mockBackend({ operations: [CLOSED_OP_COM_SNAPSHOT], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    fireEvent.click(await screen.findByText('Histórico Completo'));
    // "O preço tocou o stop antes de TP1 ser atingido." é o `why` de
    // stop_hit_pre_tp1 — precisa estar no texto renderizado (não só num
    // atributo title, que findByText não enxerga). SOL/USDT aparece 2x na
    // tela (chart de performance + a linha do histórico), então a asserção
    // âncora no texto único do "por quê", não no símbolo.
    await screen.findByText(/tocou o stop antes de TP1/i);
  });
});

// Achado da revisão cética pós-PR #396 (docs/claude/ui-audit-criticos.md):
// a correção original do C-3 (estado de erro de rede) checava só o array
// BRUTO (`operations.length === 0`) pra decidir entre erro cheio e o texto
// vazio da seção "Operações Ativas" — mas o texto vazio ali é sobre o
// recorte FILTRADO por status ativo (`applyFilters(active)`), uma dimensão
// diferente. Com cache só de operações FECHADAS e um refetch que falha, a
// tela afirmava "Nenhuma operação ativa." com confiança total quando, na
// verdade, não foi confirmado — o mesmo tipo de silêncio enganoso que o C-3
// deveria ter eliminado, reaparecendo uma camada abaixo.
const OPERACAO_SO_FECHADA = {
  id: 'closed_cache1', asset_id: 'a9', symbol: 'BTCUSDT', side: 'BUY',
  status: 'STOP_HIT', timeframe: '15m', signal_timeframe: '4h',
  entry_price: 100, initial_stop: 95, current_stop: 95, tp1: 110, tp2: 120,
  exit_price: 95, created_date: '2026-09-20T09:00:00.000Z',
};

describe('Trades — "Operações Ativas" não afirma "Nenhuma" quando a atualização falhou', () => {
  it('REGRESSÃO: cache só com operação fechada + refetch que falha mostra "não confirmado", não "Nenhuma operação ativa."', async () => {
    vi.doMock('@/api/entities', () => ({
      backend: {
        entities: {
          TradeOperation: {
            list: async () => { throw new Error('Failed to fetch'); },
            filter: async () => [],
          },
          SignalEvent: { list: async () => [], filter: async () => [], update: async (id, data) => ({ id, ...data }) },
        },
        tradeOps: { transitionTradeOp: async () => ({ applied: false }) },
      },
    }));
    vi.doMock('@/lib/marketDataProvider', () => ({
      fetchCandles: async () => [],
      fetchCurrentPrice: async () => null,
      fetch24hStats: async () => null,
      MARKET_SOURCE: 'spot',
      DATA_EXCHANGE: 'binance',
      EXECUTOR: 'browser',
    }));

    const { default: Trades } = await import('./Trades.jsx');
    // Simula "carga anterior bem-sucedida, refetch em background falhou":
    // semeia o cache com dado real e deixa o queryFn sempre rejeitar — o
    // React Query mantém `data` do cache e vira `isError=true` no fetch
    // automático de montagem (staleTime 0 no client de teste).
    const client = makeTestQueryClient();
    client.setQueryData(['trade-operations'], [OPERACAO_SO_FECHADA]);

    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <MemoryRouter><Trades /></MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await screen.findByText(/não foi possível confirmar se há operações ativas/i);
    expect(screen.queryByText('Nenhuma operação ativa.')).toBeNull();
  });
});

// Achado da 3ª revisão cética (docs/claude/ui-audit-criticos.md): as seções
// "Avisos em análise"/"Observações de mercado" só renderizam quando há sinal
// (`.length > 0`) — uma falha em recentSignals fazia as duas simplesmente
// sumirem da tela, sem nenhum indício de que algo deu errado. Mesma classe
// de silêncio enganoso que o C-3 original corrigiu na query principal de
// cada página, só que numa query secundária fora daquele escopo.
describe('Trades — "Avisos em análise" não some silenciosamente quando recentSignals falha', () => {
  it('REGRESSÃO: erro ao carregar sinais recentes mostra aviso, em vez das seções sumirem sem explicação', async () => {
    vi.doMock('@/api/entities', () => ({
      backend: {
        entities: {
          TradeOperation: { list: async () => [], filter: async () => [] },
          SignalEvent: {
            list: async () => { throw new Error('Failed to fetch'); },
            filter: async () => [],
            update: async (id, data) => ({ id, ...data }),
          },
        },
        tradeOps: { transitionTradeOp: async () => ({ applied: false }) },
      },
    }));
    vi.doMock('@/lib/marketDataProvider', () => ({
      fetchCandles: async () => [],
      fetchCurrentPrice: async () => null,
      fetch24hStats: async () => null,
      MARKET_SOURCE: 'spot',
      DATA_EXCHANGE: 'binance',
      EXECUTOR: 'browser',
    }));

    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText(/não foi possível verificar avisos\/sinais recentes/i);
  });
});

// Achado A-12 do Raio-X de UI/UX: EditModal era uma <div> de overlay manual
// — sem Esc pra fechar, sem role="dialog", sem focus trap. Trocado pelo
// Dialog do Radix (mesmo padrão já usado em Assets.jsx/Alerts.jsx). Este
// teste prova que é o Dialog REAL montado, não só uma div parecida: existe
// um elemento com role="dialog" e Esc fecha.
describe('Trades — modal de edição (EditModal) usa Dialog acessível (achado A-12)', () => {
  it('REGRESSÃO: tem role="dialog" e fecha ao pressionar Esc', async () => {
    mockBackend({ operations: [ACTIVE_OP], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    fireEvent.click(await screen.findByText('Editar'));
    expect(await screen.findByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // Item 278 (PR-C): editar altera o registro, e encerrar por aqui tira a
  // operação das estatísticas — o diálogo avisa antes de salvar.
  it('avisa que altera o registro e que encerrar por aqui tira das estatísticas', async () => {
    mockBackend({ operations: [ACTIVE_OP], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);
    fireEvent.click(await screen.findByText('Editar'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/altera o registro desta operação/);
    expect(dialog.textContent).toMatch(/sai da medição do motor/);
    expect(dialog.textContent).toMatch(/sem encerrar não deixa marca/);
  });

  // 21/11/2026: o seletor mostrava `RUNNER_ACTIVE — …`/`SIGNAL_CONFIRMED — …`. O texto agora é em português; o VALOR que vai
  // pro banco continua sendo o status interno.
  it('o seletor de status fala português e guarda o status interno no valor', async () => {
    mockBackend({ operations: [ACTIVE_OP], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);
    fireEvent.click(await screen.findByText('Editar'));
    const dialog = await screen.findByRole('dialog');
    const select = dialog.querySelector('select');
    const opcoes = Array.from(select.options).map((o) => [o.value, o.textContent]);
    expect(opcoes.map(([v]) => v)).toEqual(['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE', 'TP2_HIT', 'STOP_HIT', 'INVALIDATED', 'CLOSED']);
    for (const [, texto] of opcoes) expect(texto).not.toMatch(/[A-Z]+_[A-Z_]+/);
    expect(opcoes.find(([v]) => v === 'RUNNER_ACTIVE')[1]).toMatch(/^Runner ativo/);
    // cabem inteiras no seletor da janela (o texto longo ficava cortado no "...o resto segu")
    for (const [, texto] of opcoes) expect(texto.length).toBeLessThanOrEqual(38);
    expect(select.value).toBe('RUNNER_ACTIVE');
  });

  it('com status final o campo de saída não mostra o nome técnico', async () => {
    mockBackend({ operations: [ACTIVE_OP], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);
    fireEvent.click(await screen.findByText('Editar'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(dialog.querySelector('select'), { target: { value: 'STOP_HIT' } });
    expect(dialog.textContent).toMatch(/Preço de saída/);
    expect(dialog.textContent).not.toMatch(/exit_price/);
  });
});

// Achado da varredura pós-Raio-X, Round 2 (2026-09-27): Invalidar/Encerrar
// usavam window.confirm() nativo (quebra o tema escuro) — migrados pro
// AlertDialog já existente e nunca usado (src/components/ui/alert-dialog.jsx).
// 1 diálogo compartilhado entre os 2 botões (estado { op, action }) — o
// 3º teste guarda contra um bug de estado obsoleto (abrir um, cancelar,
// abrir o outro, texto tem que atualizar).
describe('Trades — Invalidar/Encerrar usam AlertDialog em vez de confirm() nativo (Round 2 pós-Raio-X)', () => {
  it('REGRESSÃO: Invalidar abre AlertDialog; Cancelar não chama transitionTradeOp; confirmar chama com INVALIDATED', async () => {
    const transitionTradeOp = vi.fn(async () => ({ applied: true }));
    mockBackend({ operations: [ACTIVE_OP], signals: [], transitionTradeOp });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    fireEvent.click(await screen.findByRole('button', { name: 'Invalidar' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/mantido como histórico/)).toBeTruthy();

    fireEvent.click(within(dialog).getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(transitionTradeOp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Invalidar' }));
    const dialog2 = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog2).getByText('Invalidar'));
    await waitFor(() => expect(transitionTradeOp).toHaveBeenCalledWith(
      ACTIVE_OP.id, ACTIVE_OP.status, expect.objectContaining({ status: 'INVALIDATED' }), expect.anything()
    ));
  });

  it('REGRESSÃO: Encerrar chama transitionTradeOp com CLOSED', async () => {
    const transitionTradeOp = vi.fn(async () => ({ applied: true }));
    mockBackend({ operations: [ACTIVE_OP], signals: [], transitionTradeOp });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    fireEvent.click(await screen.findByRole('button', { name: 'Encerrar' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('Encerrar'));
    await waitFor(() => expect(transitionTradeOp).toHaveBeenCalledWith(
      ACTIVE_OP.id, ACTIVE_OP.status, expect.objectContaining({ status: 'CLOSED' }), expect.anything()
    ));
  });

  it('REGRESSÃO: abrir Invalidar, cancelar, abrir Encerrar mostra o texto de Encerrar (sem estado obsoleto)', async () => {
    mockBackend({ operations: [ACTIVE_OP], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    fireEvent.click(await screen.findByRole('button', { name: 'Invalidar' }));
    let dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/status muda para Invalidada/)).toBeTruthy();
    fireEvent.click(within(dialog).getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Encerrar' }));
    dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/status muda para Encerrada à mão/)).toBeTruthy();
    expect(within(dialog).queryByText(/Invalidada/)).toBeNull();
  });
});

// Achado A-6 do Raio-X de UI/UX (2ª sub-rodada, Grupo 1 — botões
// interativos): 3 botões usavam o atributo HTML nativo `title=` — tooltip
// feio do navegador, não acionável por teclado. Migrados pro Tooltip do
// Radix (mesmo padrão do resto do projeto). O botão só-ícone (dismiss X)
// também ganhou `aria-label`, sem o qual perderia o nome acessível por
// completo ao perder o `title=` (os outros 2 já têm texto visível, não
// precisam).
describe('Trades — botões usam Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: botão de dispensar aviso expirado (só-ícone) não tem title=, tem aria-label', async () => {
    mockBackend({ operations: [], signals: [SIGNAL_4H] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText('PENDLE/USDT');
    const dismissButton = screen.getByRole('button', { name: 'Tirar este aviso da lista' });
    expect(dismissButton.getAttribute('title')).toBeNull();
  });

  it('REGRESSÃO: botão "Dispensar" (aviso em espera) não tem title= nativo', async () => {
    // created_date recente (dentro da janela de 4h de CONFIRMATION_WINDOW_MS,
    // signalStatus.js) — garante fase WAITING, não EXPIRED (que usa o botão
    // ícone-só já coberto no teste anterior, não o "Dispensar" com texto).
    const freshSignal = { ...SIGNAL_WAITING_COM_EVIDENCIA, created_date: new Date().toISOString() };
    mockBackend({ operations: [], signals: [freshSignal] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText('ADA/USDT');
    const dismissButton = screen.getByText('Dispensar').closest('button');
    expect(dismissButton.getAttribute('title')).toBeNull();
  });

  it('REGRESSÃO: botão "Detalhado/Compacto" (densidade dos cards ativos) não tem title= nativo', async () => {
    mockBackend({ operations: [ACTIVE_OP], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText('Operações Ativas');
    const densityButton = screen.getByText('Compacto').closest('button');
    expect(densityButton.getAttribute('title')).toBeNull();
  });

  // 5ª sub-rodada (docs/known-risks.md item 208): achado durante a
  // varredura fresca do Grupo 2 — este `title=` de Trades.jsx (badge
  // "desde ...", quando um aviso fica travado no mesmo motivo de rejeição)
  // tinha sido deliberadamente deixado de fora da 2ª sub-rodada (item 205,
  // só cobria botões), mas a varredura nova o excluiu por engano ao
  // ignorar o arquivo inteiro (já tinha OUTRAS ocorrências corrigidas).
  it('REGRESSÃO: badge "desde ..." (motivo travado) não tem title= nativo, vira gatilho focável', async () => {
    const freshSignal = {
      ...SIGNAL_WAITING_COM_EVIDENCIA,
      created_date: new Date().toISOString(),
      last_rejection_at: new Date().toISOString(),
    };
    mockBackend({ operations: [], signals: [freshSignal] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText('ADA/USDT');
    const badge = screen.getByText(/^desde /);
    expect(badge.getAttribute('title')).toBeNull();
    expect(badge.getAttribute('tabindex')).toBe('0');
  });
});

// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 2ª sub-rodada): o filtro "Buscar operação..." usava `outline-none`
// sem substituto visível de foco — mesmo achado/fix de
// TriggerBacktestPanel.jsx (1ª sub-rodada).
describe('Trades — filtro "Buscar operação..." tem foco visível (achado A-7)', () => {
  it('REGRESSÃO: input tem focus-visible:ring', async () => {
    mockBackend({ operations: [], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    const search = await screen.findByPlaceholderText('Buscar operação...');
    expect(search.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });
});

// Fase 5 da auditoria do Telegram (2026-10-02), item 5.4 — a mensagem do
// Telegram agora linka `?id=<TradeOperation.id>`; esta página precisa abrir
// o EditModal dessa operação sozinha. `window.history.pushState` (não
// `route` de `renderPage`) — a leitura é via `window.location.search`
// direto, mesmo padrão de Assets.jsx; `MemoryRouter` não reflete no DOM real.
describe('Trades — deep link ?id= abre a operação exata (item 5.4)', () => {
  afterEach(() => window.history.pushState({}, '', '/'));

  it('REGRESSÃO: ?id=<id válido> abre o EditModal dessa operação', async () => {
    mockBackend({ operations: [ACTIVE_OP], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    window.history.pushState({}, '', '/trades?id=trade_sig1');
    renderPage(<Trades />);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/PENDLE\/USDT/)).toBeTruthy();
  });

  it('?id= sem correspondência na lista carregada não abre modal nem quebra a página', async () => {
    mockBackend({ operations: [ACTIVE_OP], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    window.history.pushState({}, '', '/trades?id=nao_existe');
    renderPage(<Trades />);

    await screen.findByText('PENDLE/USDT');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sem ?id= na URL, comportamento inalterado — nenhum modal abre sozinho', async () => {
    mockBackend({ operations: [ACTIVE_OP], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);

    await screen.findByText('PENDLE/USDT');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});


// Item 276 — a fila de "Avisos em análise" segue a mesma regra de "pode virar
// operação" do resto do app (Range Filter 4h e SMC 1h com a cascata ligada) e
// separa as fontes: um aviso de uma cascata não esconde o da outra.
describe('Trades — fila de avisos separa as cascatas (item 276)', () => {
  const recente = () => new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const maisRecente = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const SMC_1H = () => ({
    id: 'smc1', asset_id: 'a1', symbol: 'ETHUSDT', timeframe: '1h', signal_type: 'BUY',
    source: 'smc_structure', price_at_signal: 2000, created_date: recente(),
  });
  const RF_1H = () => ({
    id: 'rf1h', asset_id: 'a1', symbol: 'ETHUSDT', timeframe: '1h', signal_type: 'SELL',
    source: 'range_filter', price_at_signal: 2000, created_date: maisRecente(),
  });

  it('um Range Filter 1h mais novo não esconde um SMC 1h ainda esperando', async () => {
    mockBackend({
      operations: [], signals: [RF_1H(), SMC_1H()],
      assets: [{ id: 'a1', symbol: 'ETHUSDT', is_active: true, smc_enabled: true }],
    });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);
    await screen.findByRole('heading', { name: 'Avisos em análise' });
    await screen.findByText(/1 observações de mercado/);
  });

  it('SMC 1h de ativo com a cascata desligada vai para "observações de mercado", não para "em análise"', async () => {
    mockBackend({
      operations: [], signals: [SMC_1H()],
      assets: [{ id: 'a1', symbol: 'ETHUSDT', is_active: true, smc_enabled: false }],
    });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);
    await screen.findByText(/1 observações de mercado/);
    expect(screen.queryByRole('heading', { name: 'Avisos em análise' })).toBeNull();
  });

  // Achado do Codex (review do PR #502): o card "Só informação" caía no texto
  // genérico de "sem motivo salvo" — "Aviso recém-chegado... refaz a conta a
  // cada 5 minutos" — contradizendo o próprio badge de que não vira operação.
  it('card de observação sem motivo salvo não diz que o app está checando entrada', async () => {
    mockBackend({
      operations: [], signals: [SMC_1H()],
      assets: [{ id: 'a1', symbol: 'ETHUSDT', is_active: true, smc_enabled: false }],
    });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);
    fireEvent.click(await screen.findByText(/1 observações de mercado/));
    await screen.findByText('ETH/USDT');
    expect(screen.queryByText(/rec[ée]m-chegado|a cada \d+ minutos/i)).toBeNull();
    expect(screen.queryByText(/Checando agora/)).toBeNull();
  });

  it('uma operação SMC 1h ativa não esconde um aviso Range Filter 1h do mesmo ativo', async () => {
    const smcOp = {
      id: 'trade_smc_x', asset_id: 'a1', symbol: 'ETHUSDT', side: 'BUY', status: 'SIGNAL_CONFIRMED',
      timeframe: '5m', signal_timeframe: '1h', cascade: '1h_5m', entry_price: 2000, initial_stop: 1900,
      current_stop: 1900, tp1: 2150, tp2: 2300, tp1_hit: false, partial_percent: 50, created_date: recente(),
    };
    mockBackend({
      operations: [smcOp], signals: [RF_1H()],
      assets: [{ id: 'a1', symbol: 'ETHUSDT', is_active: true, smc_enabled: true }],
    });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);
    await screen.findByText('Operações Ativas');
    await screen.findByText(/1 observações de mercado/);
  });
});

// Item 304 (14/11/2026) — 2º PR da aba Trades: resumo do topo, filtros e a lista do histórico. Pedido do usuário depois do
// cartão (item 303): "melhorar a aba toda". Os achados que estes testes travam foram medidos no código antes de mexer.
describe('Trades — resumo do topo, filtros e histórico (item 304)', () => {
  const diasAtras = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const ATIVA_CASCATA = {
    id: 'op_cascata', asset_id: 'a1', symbol: 'QNTUSDT', side: 'SELL', status: 'SIGNAL_CONFIRMED',
    timeframe: '15m', signal_timeframe: '4h', cascade: '4h_15m', entry_price: 180, initial_stop: 200, current_stop: 170,
    tp1: 150, tp2: 120, partial_percent: 50, created_date: diasAtras(2),
  };
  const ATIVA_RISCO = {
    id: 'op_risco', asset_id: 'a2', symbol: 'SOLUSDT', side: 'BUY', status: 'SIGNAL_CONFIRMED',
    timeframe: '15m', signal_timeframe: '4h', cascade: '4h_15m', entry_price: 100, initial_stop: 95, current_stop: 95,
    tp1: 107.5, tp2: 115, partial_percent: 50, created_date: diasAtras(1),
  };
  const FECHADA_STOP_LUCRO = {
    id: 'op_fechada', asset_id: 'a3', symbol: 'LINKUSDT', side: 'SELL', status: 'STOP_HIT',
    timeframe: '15m', signal_timeframe: '4h', cascade: '4h_15m', entry_price: 20, initial_stop: 22, current_stop: 18,
    exit_price: 18, tp1: 17, tp2: 14, partial_percent: 50,
    created_date: '2026-09-10T12:00:00.000Z', stop_hit_at: '2026-09-12T15:30:00.000Z', closed_at: '2026-09-12T15:30:00.000Z',
  };
  const FECHADA_PERDA = {
    ...FECHADA_STOP_LUCRO, id: 'op_perda', symbol: 'AVAXUSDT', side: 'BUY', entry_price: 40, initial_stop: 38,
    current_stop: 38, exit_price: 38, tp1: 43, tp2: 46,
  };

  async function abrir(operations, signals = []) {
    mockBackend({ operations, signals });
    const { default: Trades } = await import('./Trades.jsx');
    const view = renderPage(<Trades />);
    await screen.findByText('Operações Ativas');
    return view;
  }
  const resumo = () => screen.getByRole('group', { name: 'Resumo de agora' });
  const botaoDoGrupo = (grupo, nome) => within(screen.getByRole('group', { name: grupo })).getByRole('button', { name: nome });

  describe('resumo de agora', () => {
    it('diz quantas estão ativas, como está o stop de cada uma e a soma em R se todas baterem no stop', async () => {
      await abrir([ATIVA_CASCATA, ATIVA_RISCO, FECHADA_STOP_LUCRO, FECHADA_PERDA]);
      await screen.findByText('QNT/USDT');
      const r = within(resumo());
      r.getByText('Operações ativas');
      expect(r.getAllByText('2')).toHaveLength(2); // 2 ativas e 2 fechadas
      r.getByText('1 com lucro protegido · 1 com risco em jogo');
      // +0,50R (QNT: stop 170 numa venda a 180 com risco de 20) e -1,00R (SOL no stop inicial)
      r.getByText('-0.50R');
      r.getByText('1 ganhos · 0 empates · 1 perdas');
    });

    it('sem operação ativa nem fechada: zeros e textos de vazio, nunca "NaN" nem soma inventada', async () => {
      await abrir([]);
      const r = within(resumo());
      r.getByText('nenhuma aberta agora');
      r.getByText('sem operação aberta');
      r.getByText('—');
      r.getByText('nenhuma no período');
      expect(resumo().textContent).not.toMatch(/NaN|undefined|null/);
    });

    it('o cabeçalho de sempre continua: "Atualizado há …" e a linha "N em análise · N ativas · N histórico"', async () => {
      const { container } = await abrir([ATIVA_CASCATA, ATIVA_RISCO, FECHADA_STOP_LUCRO]);
      await screen.findByText('QNT/USDT');
      expect(container.textContent).toMatch(/Atualizado há \d+(s|min|h|d)/);
      screen.getByText('0 em análise · 2 ativas · 1 histórico');
    });

    it('REGRESSÃO: o relógio do "Atualizado há" não redesenha a página inteira a cada segundo (vive num componente só dele)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await abrir([ATIVA_CASCATA]);
        await screen.findByText('QNT/USDT');
        const antes = screen.getByText('QNT/USDT');
        await vi.advanceTimersByTimeAsync(3000);
        // o mesmo nó do DOM: a página não foi remontada nem trocada
        expect(screen.getByText('QNT/USDT')).toBe(antes);
        const fonte = readFileSync('src/pages/Trades.jsx', 'utf8');
        const corpo = fonte.slice(fonte.indexOf('export default function Trades()'));
        expect(corpo, 'o setInterval de 1 s não pode voltar para dentro de Trades()').not.toMatch(/setInterval\(/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('ordem da página', () => {
    it('ordem: resumo → Relatório de Performance (de volta ao lugar de antes) → filtros → Operações Ativas → Avisos em análise → Histórico', async () => {
      const aviso = { ...SIGNAL_4H, id: 'sig_novo', symbol: 'XRPUSDT', asset_id: 'ax', created_date: new Date().toISOString(), expired_logged: false };
      await abrir([ATIVA_CASCATA, FECHADA_STOP_LUCRO], [aviso]);
      await screen.findByRole('heading', { name: 'Avisos em análise' });
      const titulos = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent.trim());
      const pos = (texto) => titulos.findIndex((t) => t.startsWith(texto));
      expect(pos('Relatório de Performance')).toBeGreaterThan(-1);
      expect(pos('Performance Acumulada')).toBeGreaterThan(-1);
      expect(pos('Relatório de Performance')).toBeLessThan(pos('Operações Ativas'));
      expect(pos('Performance Acumulada')).toBeLessThan(pos('Operações Ativas'));
      expect(pos('Operações Ativas')).toBeLessThan(pos('Avisos em análise'));
      expect(pos('Avisos em análise')).toBeLessThan(pos('Histórico Completo'));
      // o resumo de agora (cartões) e os filtros ficam antes/depois do relatório, respectivamente
      const resumoEl = resumo();
      const barra = screen.getByRole('search', { name: 'Filtros das operações' });
      const relatorio = screen.getByRole('heading', { name: 'Relatório de Performance' });
      expect(resumoEl.compareDocumentPosition(relatorio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(relatorio.compareDocumentPosition(barra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('os gráficos de performance continuam acompanhando os filtros (como antes)', async () => {
      await abrir([ATIVA_CASCATA, FECHADA_STOP_LUCRO, FECHADA_PERDA]);
      await screen.findByRole('heading', { name: 'Relatório de Performance' });
      fireEvent.click(botaoDoGrupo('Lado', 'BUY'));
      screen.getByText('(1 trades fechados)');
    });
  });

  describe('filtros', () => {
    it('REGRESSÃO: escolher "4H" mantém a operação da cascata 4h→15m na tela (antes escondia TODAS e dizia "Nenhuma operação ativa.")', async () => {
      await abrir([ATIVA_CASCATA]);
      await screen.findByText('QNT/USDT');
      fireEvent.click(botaoDoGrupo('Gráfico do aviso', '4H'));
      screen.getByText('QNT/USDT');
      expect(screen.queryByText('Nenhuma operação ativa.')).toBeNull();
    });

    it('REGRESSÃO: quando o filtro esconde tudo, a tela diz que HÁ operação ativa escondida e oferece limpar — não "Nenhuma operação ativa."', async () => {
      await abrir([ATIVA_CASCATA]);
      await screen.findByText('QNT/USDT');
      fireEvent.click(botaoDoGrupo('Gráfico do aviso', '1H'));
      expect(screen.queryByText('QNT/USDT')).toBeNull();
      expect(screen.queryByText('Nenhuma operação ativa.')).toBeNull();
      screen.getByText('Há 1 operação ativa, mas os filtros ligados a escondem.');
      fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros e mostrar' }));
      screen.getByText('QNT/USDT');
    });

    it('plural da mensagem de filtro escondendo', async () => {
      await abrir([ATIVA_CASCATA, ATIVA_RISCO]);
      await screen.findByText('QNT/USDT');
      fireEvent.click(botaoDoGrupo('Gráfico do aviso', '1D'));
      screen.getByText('Há 2 operações ativas, mas os filtros ligados as escondem.');
    });

    it('sem operação ativa de verdade continua "Nenhuma operação ativa.", mesmo com filtro ligado', async () => {
      await abrir([FECHADA_STOP_LUCRO]);
      fireEvent.click(botaoDoGrupo('Gráfico do aviso', '1H'));
      screen.getByText('Nenhuma operação ativa.');
    });

    it('"Limpar filtros (N)" e a linha "Filtros ligados" só aparecem com filtro, contam os filtros e dizem quanto está escondido', async () => {
      await abrir([ATIVA_CASCATA, ATIVA_RISCO, FECHADA_STOP_LUCRO]);
      await screen.findByText('QNT/USDT');
      expect(screen.queryByRole('button', { name: /Limpar filtros/ })).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();

      fireEvent.click(botaoDoGrupo('Lado', 'SELL'));
      screen.getByRole('button', { name: 'Limpar filtros (1)' });
      expect(screen.getByRole('status').textContent).toBe('Filtros ligados — mostrando 1 de 2 ativas · 0 de 0 avisos · 1 de 1 fechadas.');
      expect(screen.queryByText('SOL/USDT')).toBeNull();

      fireEvent.change(screen.getByPlaceholderText('Buscar operação...'), { target: { value: 'qnt' } });
      screen.getByRole('button', { name: 'Limpar filtros (2)' });

      fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros (2)' }));
      screen.getByText('SOL/USDT');
      expect(screen.getByPlaceholderText('Buscar operação...').value).toBe('');
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('o resumo do topo acompanha os filtros e avisa que está filtrado', async () => {
      await abrir([ATIVA_CASCATA, ATIVA_RISCO, FECHADA_STOP_LUCRO, FECHADA_PERDA]);
      await screen.findByText('QNT/USDT');
      within(resumo()).getByText('1 ganhos · 0 empates · 1 perdas');
      fireEvent.click(botaoDoGrupo('Lado', 'BUY'));
      const r = within(resumo());
      r.getByText('Operações ativas (com os filtros)');
      r.getByText('1 com risco em jogo');
      r.getByText('-1.00R');
      // as fechadas do resumo também são as do filtro (só a compra, que foi a perda)
      r.getByText('0 ganhos · 0 empates · 1 perdas');
    });

    it('período: o seletor recorta pela data de criação', async () => {
      await abrir([ATIVA_CASCATA, FECHADA_STOP_LUCRO]);
      await screen.findByText('QNT/USDT');
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'week' } });
      expect(screen.getByRole('status').textContent).toMatch(/· 0 de 1 fechadas\./);
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'all' } });
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('o evento global de "limpar filtros" do app continua funcionando', async () => {
      await abrir([ATIVA_CASCATA, ATIVA_RISCO]);
      await screen.findByText('QNT/USDT');
      fireEvent.click(botaoDoGrupo('Lado', 'SELL'));
      expect(screen.queryByText('SOL/USDT')).toBeNull();
      fireEvent(window, new Event('app-reset-filters'));
      await screen.findByText('SOL/USDT');
    });
  });

  describe('lista do histórico', () => {
    it('cada linha diz o selo aviso → entrada, o resultado em % e em R, quando abriu e fechou (com a duração) e por onde entrou e saiu', async () => {
      const { container } = await abrir([FECHADA_STOP_LUCRO]);
      fireEvent.click(await screen.findByText('Histórico Completo'));
      const linha = container.querySelector('[data-history-row="op_fechada"]');
      expect(linha).not.toBeNull();
      const texto = linha.textContent;
      expect(texto).toMatch(/LINK\/USDT/);
      expect(texto).toMatch(/4H → 15M/);
      expect(texto).toMatch(/Aberta 10\/09 09:00 → fechada 12\/09 12:30 \(2d 3h\)/);
      expect(texto).toMatch(/Entrada \$20\.0000 → saída \$18\.0000/);
      expect(texto).toMatch(/\+\d+\.\d{2}%/);
      expect(texto).toMatch(/\+0\.\d{2}R/);
    });

    it('REGRESSÃO: data e preços não ficam mais escondidos no celular (sem classe "hidden")', async () => {
      const { container } = await abrir([FECHADA_STOP_LUCRO]);
      fireEvent.click(await screen.findByText('Histórico Completo'));
      const linha = container.querySelector('[data-history-row="op_fechada"]');
      expect(linha.querySelector('.hidden')).toBeNull();
    });

    it('stop que fechou no lucro é "💰 Stop com lucro", não "🛑 Stop" ao lado de um resultado positivo; stop com perda segue "🛑 Stop"', async () => {
      const { container } = await abrir([FECHADA_STOP_LUCRO, FECHADA_PERDA]);
      fireEvent.click(await screen.findByText('Histórico Completo'));
      const lucro = container.querySelector('[data-history-row="op_fechada"]').textContent;
      const perda = container.querySelector('[data-history-row="op_perda"]').textContent;
      expect(lucro).toMatch(/💰 Stop com lucro/);
      expect(lucro).not.toMatch(/🛑/);
      expect(perda).toMatch(/🛑 Stop/);
      expect(perda).not.toMatch(/💰/);
    });

    it('o resumo da lista está em português e tem o caminho para a aba Histórico', async () => {
      await abrir([FECHADA_STOP_LUCRO, FECHADA_PERDA]);
      fireEvent.click(await screen.findByText('Histórico Completo'));
      screen.getByText('✓ Ganhos: 1');
      screen.getByText('✗ Perdas: 1');
      screen.getByText('↔ Empates: 0');
      const link = screen.getByRole('link', { name: /Ver a história de cada operação na aba Histórico/ });
      expect(link.getAttribute('href')).toBe('/history');
    });

    it('avisa quando a página bateu no teto de 100 operações carregadas — e só nesse caso', async () => {
      const muitas = Array.from({ length: 100 }, (_, i) => ({ ...FECHADA_PERDA, id: `op_${i}` }));
      await abrir(muitas);
      fireEvent.click(await screen.findByText('Histórico Completo'));
      screen.getByText(/carrega só as 100 operações mais recentes/);
      cleanup();
      vi.resetModules();
      await abrir(muitas.slice(0, 99));
      fireEvent.click(await screen.findByText('Histórico Completo'));
      expect(screen.queryByText(/carrega só as 100 operações mais recentes/)).toBeNull();
    });
  });
});

// Fase 5 do Contexto de Mercado (item 285, addendum 41): o selo "Aberta durante o CPI (10/11)" no "Histórico Completo". Correlação, nunca causa;
// só quando há dado confiável; o Histórico nunca depende dele (sem rede = sem selo, tela igual).
describe('Trades — selo "Aberta durante <evento>" no Histórico Completo', () => {
  const MESES = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
  const mensal = (dia) => MESES.map((m) => `${m}-${dia}`).reverse();
  const HISTORY = {
    version: 1,
    dates: {
      CPI: mensal('10'), NFP: mensal('06'), PPI: mensal('13'), PCE: mensal('12'),
      FOMC: ['2026-10-28', '2026-09-16', '2026-07-29', '2026-06-17', '2026-04-29', '2026-03-18', '2026-01-28', '2025-12-10'],
    },
  };
  const FECHADA = (id, abre, fecha) => ({
    id, asset_id: 'a3', symbol: 'SOLUSDT', side: 'BUY', status: 'STOP_HIT', timeframe: '15m', signal_timeframe: '4h',
    entry_price: 100, initial_stop: 95, current_stop: 95, tp1: 110, tp2: 120, exit_price: 95, tp1_hit: false,
    created_date: abre, entry_candle_time_15m: abre, stop_hit_at: fecha, closed_at: fecha,
    decision_snapshot: { decision: 'EXIT', reason_code: 'stop_hit_pre_tp1', facts: { stop: 95, stop_check_price: 94.8 }, data_status: 'LIVE' },
  });
  const COM_CPI = FECHADA('op_cpi', '2026-11-09T20:00:00.000Z', '2026-11-11T08:00:00.000Z');
  const SEM_EVENTO = FECHADA('op_livre', '2026-11-14T00:00:00.000Z', '2026-11-15T00:00:00.000Z');
  const ok = (body) => ({ ok: true, json: async () => body });

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-19T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function abrir(operations, fetchImpl) {
    vi.stubGlobal('fetch', fetchImpl);
    mockBackend({ operations, signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);
    fireEvent.click(await screen.findByText('Histórico Completo'));
    await screen.findAllByText(/tocou o stop antes de TP1/i);
  }
  const fetchOk = async (url) => (String(url).endsWith('history.json') ? ok(HISTORY) : ok([]));

  it('operação aberta quando saiu o CPI mostra o selo, com a dica "só coincidência"; a sem evento não mostra', async () => {
    await abrir([COM_CPI, SEM_EVENTO], fetchOk);
    const selo = await screen.findByText('Aberta durante o CPI (10/11)');
    expect(selo).toBeTruthy();
    expect(document.querySelectorAll('[data-op-event-marker]').length).toBe(1);
    const linha = selo.closest('[data-history-row]');
    expect(linha.getAttribute('data-history-row')).toBe('op_cpi');
    expect(selo.closest('[data-op-event-marker]').getAttribute('aria-label')).toMatch(/não diz que o evento mexeu no resultado/);
  });

  it('sem o histórico (rede falhou) a tela é a mesma de sempre e NENHUM selo aparece', async () => {
    await abrir([COM_CPI], async () => ({ ok: false, status: 404 }));
    expect(document.querySelector('[data-op-event-marker]')).toBeNull();
    expect(screen.getByText(/tocou o stop antes de TP1/i)).toBeTruthy();
  });

  it('operação que toca um mês sem CPI no histórico não ganha selo (nada é afirmado)', async () => {
    const semCpiJulho = { ...HISTORY, dates: { ...HISTORY.dates, CPI: HISTORY.dates.CPI.filter((d) => !d.startsWith('2026-07')) } };
    const naPausa = FECHADA('op_jul', '2026-07-20T00:00:00.000Z', '2026-07-30T00:00:00.000Z'); // inclui o FOMC de 29/07
    await abrir([naPausa], async (url) => (String(url).endsWith('history.json') ? ok(semCpiJulho) : ok([])));
    expect(document.querySelector('[data-op-event-marker]')).toBeNull();
  });

  it('o histórico de datas só é buscado depois de abrir o "Histórico Completo"', async () => {
    const f = vi.fn(fetchOk);
    vi.stubGlobal('fetch', f);
    mockBackend({ operations: [COM_CPI], signals: [] });
    const { default: Trades } = await import('./Trades.jsx');
    renderPage(<Trades />);
    await screen.findByText('Histórico Completo');
    expect(f.mock.calls.some(([u]) => String(u).endsWith('history.json'))).toBe(false);
    fireEvent.click(screen.getByText('Histórico Completo'));
    await screen.findByText('Aberta durante o CPI (10/11)');
    expect(f.mock.calls.some(([u]) => String(u).endsWith('history.json'))).toBe(true);
  });
});
