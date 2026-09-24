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
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, render } from '@testing-library/react';
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

function mockBackend({ operations, signals }) {
  vi.doMock('@/api/entities', () => ({
    backend: {
      entities: {
        TradeOperation: { list: async () => operations, filter: async () => operations },
        SignalEvent: {
          list: async () => signals,
          filter: async () => signals,
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
    expect(screen.queryByText('Avisos em análise')).toBeNull();
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
    expect(screen.queryByText(/a cada 5 minutos/i)).toBeNull();
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
