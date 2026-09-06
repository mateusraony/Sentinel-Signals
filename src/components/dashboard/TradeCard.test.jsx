// @vitest-environment jsdom
//
// StatusBanner's STOP_HIT text (item 166 Fase 2, "UI reimplementando regra
// do motor") keyed the "breakeven" label off `op.tp1_hit` — exactly the
// heuristic item 154 already removed from the level-color/label logic
// elsewhere in this same file, replaced by `stopPosture(op)`, which compares
// the stored stop against entry instead of assuming a fixed post-TP1 state.
// `advanceTrailingStop` (scanner.js) keeps moving the stop past breakeven
// after TP1, so a runner that stops out can carry real locked-in profit —
// the banner missed that fix and still said "sem prejuízo" (no loss) instead
// of showing the win.
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import TradeCard from './TradeCard.jsx';

function renderCard(op) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TradeCard operation={op} expandAll />
    </QueryClientProvider>,
  );
}

function baseOp(overrides = {}) {
  return {
    id: 'op1', symbol: 'BTCUSDT', side: 'BUY', timeframe: '4h', status: 'STOP_HIT',
    entry_price: 60000, initial_stop: 59000, tp1: 61000, tp2: 62000,
    tp1_hit: true, tp1_hit_at: '2026-09-01T00:00:00.000Z',
    created_date: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TradeCard — StatusBanner do STOP_HIT usa stopPosture(op), não tp1_hit', () => {
  it('stop travado ALÉM da entrada (lucro real) mostra o ganho, não "sem prejuízo"', () => {
    // BUY com current_stop bem acima da entrada — exatamente o cenário que
    // advanceTrailingStop produz num runner que andou bastante após o TP1.
    // getByText lança se não achar — a própria chamada já é a asserção
    // "existe"; sem @testing-library/jest-dom neste projeto (removido de
    // propósito, ver git log), não há .toBeInTheDocument().
    renderCard(baseOp({ current_stop: 60900 }));
    screen.getByText(/Stop travou lucro/i);
    expect(screen.queryByText(/sem prejuízo/i)).toBeNull();
  });

  it('stop exatamente na entrada continua mostrando breakeven', () => {
    renderCard(baseOp({ current_stop: 60000 }));
    screen.getByText(/Stop no breakeven — sem prejuízo/i);
  });

  it('stop original (nunca avançou, sem tp1_hit) continua mostrando o texto de risco', () => {
    renderCard(baseOp({ tp1_hit: false, tp1_hit_at: null, current_stop: 59000 }));
    screen.getByText(/Stop atingido — revisar setup/i);
  });
});
