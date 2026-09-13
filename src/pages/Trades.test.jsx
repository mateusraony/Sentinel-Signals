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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';

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
