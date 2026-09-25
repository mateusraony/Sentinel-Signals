/**
 * @vitest-environment jsdom
 *
 * Achado de clareza (pedido do usuário, 2026-09-18 — precedente em
 * docs/known-risks.md item 175, "revisão de clareza/copy... pedido separado
 * do usuário", nunca feita por falta de evidência concreta até agora): na
 * aba Histórico, o "por quê" de uma operação (explainOperationDecision)
 * só aparecia dentro do bloco expandido — o card fechado mostrava só
 * badge + número. Este arquivo prova que a linha de "por quê" agora
 * aparece SEM precisar clicar, e que o fallback de operação legada (sem
 * decision_snapshot de EXIT) não afirma mais uma causa fixa incorreta pro
 * caso breakeven.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';

const AGORA = '2026-09-18T12:00:00.000Z';

// Op fechada com decision_snapshot de EXIT (Fase 4) — deve mostrar o `why`
// já na linha compacta, sem precisar expandir.
const OP_COM_SNAPSHOT = {
  id: 'op1', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY',
  status: 'STOP_HIT', entry_price: 60000, initial_stop: 59000,
  current_stop: 59000, tp1: 61000, tp2: 62000, exit_price: 59000,
  stop_hit_at: AGORA, closed_at: AGORA, tp1_hit: false,
  partial_percent: 50, created_date: AGORA,
  decision_snapshot: {
    decision: 'EXIT', reason_code: 'stop_hit_pre_tp1',
    facts: { stop: 59000, stop_check_price: 58990 }, data_status: 'LIVE',
    evaluated_at: AGORA, executor: 'cron',
  },
};

// Op legada BE SEM decision_snapshot de EXIT, tp1_hit FALSE — o texto antigo
// afirmava categoricamente "stop movido para entrada após TP1", que é falso
// aqui (o breakeven veio do trailing pré-TP1, TP1 nunca foi atingido).
const OP_LEGADA_BE_SEM_TP1 = {
  id: 'op2', asset_id: 'a2', symbol: 'ETHUSDT', side: 'BUY',
  status: 'STOP_HIT', entry_price: 3000, initial_stop: 2900,
  current_stop: 3000, tp1: 3100, tp2: 3200, exit_price: 3000.5,
  stop_hit_at: AGORA, closed_at: AGORA, tp1_hit: false,
  partial_percent: 50, created_date: AGORA,
};

function mockBackend(operations) {
  vi.doMock('@/api/entities', () => ({
    backend: {
      entities: {
        TradeOperation: { list: async () => operations, filter: async () => operations },
      },
    },
  }));
}

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.doUnmock('@/api/entities');
});

describe('TradeHistory — "por quê" visível sem precisar expandir', () => {
  it('REGRESSÃO: o texto de explicação aparece no card FECHADO, não só ao expandir', async () => {
    mockBackend([OP_COM_SNAPSHOT]);
    const { default: TradeHistory } = await import('./TradeHistory.jsx');
    renderPage(<TradeHistory />);

    await screen.findByText('BTC/USDT');
    // "O preço tocou o stop antes de TP1 ser atingido." é o `why` de
    // stop_hit_pre_tp1 (OPERATION_COPY, decisionExplanation.js) — deve
    // aparecer sem nenhum clique.
    screen.getByText(/tocou o stop antes de TP1/i);
  });

  it('REGRESSÃO: fallback de op legada BE não afirma mais "stop movido para entrada após TP1" quando tp1_hit é false', async () => {
    mockBackend([OP_LEGADA_BE_SEM_TP1]);
    const { default: TradeHistory } = await import('./TradeHistory.jsx');
    renderPage(<TradeHistory />);

    await screen.findByText('ETH/USDT');
    expect(screen.queryByText(/stop movido para entrada após TP1/i)).toBeNull();
    // Texto honesto pro caso: veio do trailing pré-TP1, não do breakeven pós-TP1.
    screen.getByText(/avançou o suficiente antes do TP1/i);
  });
});

// Achado A-6 do Raio-X de UI/UX (5ª sub-rodada): 5 ocorrências de title=
// nativo em TradeHistory.jsx (Tier, "Situação rara", resumo de ambíguos,
// MFE, MAE) — todas em <span> não focável com texto visível ao lado.
// Migradas pro Tooltip do Radix (TooltipTrigger asChild + tabIndex={0}
// novo), mesmo Padrão 3 já usado em Backtest.jsx/TradeCard.jsx/
// EventTimeline.jsx.
const OP_A6 = {
  id: 'op3', asset_id: 'a3', symbol: 'PENDLEUSDT', side: 'BUY',
  status: 'STOP_HIT', entry_price: 5, initial_stop: 4.8,
  current_stop: 4.8, tp1: 5.2, tp2: 5.4, exit_price: 4.8,
  stop_hit_at: AGORA, closed_at: AGORA, tp1_hit: false,
  partial_percent: 50, created_date: AGORA,
  tier: 'B', exit_ambiguous: true, mfe_r: 1.2, mae_r: -0.5,
};

describe('TradeHistory — badges usam Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: badge de Tier não tem title= nativo, vira gatilho focável', async () => {
    mockBackend([OP_A6]);
    const { default: TradeHistory } = await import('./TradeHistory.jsx');
    renderPage(<TradeHistory />);

    await screen.findByText('PENDLE/USDT');
    const tierBadge = screen.getByText('B');
    expect(tierBadge.getAttribute('title')).toBeNull();
    expect(tierBadge.getAttribute('tabindex')).toBe('0');
  });

  it('REGRESSÃO: badge "Situação rara" não tem title= nativo, vira gatilho focável', async () => {
    mockBackend([OP_A6]);
    const { default: TradeHistory } = await import('./TradeHistory.jsx');
    renderPage(<TradeHistory />);

    await screen.findByText('PENDLE/USDT');
    const badge = screen.getByText(/Situação rara/);
    expect(badge.getAttribute('title')).toBeNull();
    expect(badge.getAttribute('tabindex')).toBe('0');
  });

  it('REGRESSÃO: resumo "N ambíguo(s)" (rodapé) não tem title= nativo, vira gatilho focável', async () => {
    mockBackend([OP_A6]);
    const { default: TradeHistory } = await import('./TradeHistory.jsx');
    renderPage(<TradeHistory />);

    await screen.findByText('PENDLE/USDT');
    const summary = screen.getByText(/ambíguo/);
    expect(summary.getAttribute('title')).toBeNull();
    expect(summary.getAttribute('tabindex')).toBe('0');
  });

  it('REGRESSÃO: MFE/MAE (bloco expandido) não têm title= nativo, viram gatilho focável', async () => {
    mockBackend([OP_A6]);
    const { default: TradeHistory } = await import('./TradeHistory.jsx');
    const { container } = renderPage(<TradeHistory />);

    await screen.findByText('PENDLE/USDT');
    fireEvent.click(container.querySelector('[aria-expanded]'));

    const mfe = await screen.findByText(/MFE/);
    const mae = screen.getByText(/MAE/);
    expect(mfe.getAttribute('title')).toBeNull();
    expect(mfe.getAttribute('tabindex')).toBe('0');
    expect(mae.getAttribute('title')).toBeNull();
    expect(mae.getAttribute('tabindex')).toBe('0');
  });
});
