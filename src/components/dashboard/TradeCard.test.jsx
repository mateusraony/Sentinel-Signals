// @vitest-environment jsdom
//
// StatusBanner's STOP_HIT text (item 166 Fase 2, "UI reimplementando regra
// do motor") first moved off `op.tp1_hit` to `stopPosture(op)` — but
// stopPosture only compares the NOMINAL stop price against entry, which
// isn't the realized result of a CLOSED operation. Codex review (PR #318)
// found the gap: a stop exactly at (or just past) entry with the TP1 partial
// already banked is a real WIN once you count the partial leg, not a
// "breakeven" — and, in the other direction, a pre-TP1 trailing stop
// nominally past entry can still net BE/LOSS after fee/slippage/funding
// (Fase 5 costs). The banner now keys off `classifyOutcome(op)` — the same
// realized-result source of truth PerformanceOverview.jsx/
// TradeEntryMarkers.jsx already use — never the stop's geometric posture.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import TradeCard from './TradeCard.jsx';

// Sem test.globals no vite.config.js, o cleanup automático do RTL entre
// testes não é acionado — dois cenários que produzem o MESMO texto de banner
// (os dois testes de "Stop travou lucro" abaixo, de propósito, é o ponto do
// achado do Codex) colidiam em getByText sem isto (DOM do teste anterior
// ainda montado).
afterEach(cleanup);

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

describe('TradeCard — StatusBanner do STOP_HIT usa classifyOutcome(op), não a postura geométrica do stop', () => {
  it('stop travado bem além da entrada, com TP1 já bancado, é um ganho real', () => {
    // getByText lança se não achar — a própria chamada já é a asserção
    // "existe"; sem @testing-library/jest-dom neste projeto (removido de
    // propósito, ver git log), não há .toBeInTheDocument().
    renderCard(baseOp({ current_stop: 60900 }));
    screen.getByText(/Stop travou lucro/i);
    expect(screen.queryByText(/sem prejuízo/i)).toBeNull();
  });

  it('stop NOMINALMENTE na entrada, mas com TP1 já bancado, também é ganho real — não "breakeven"', () => {
    // Achado do Codex (PR #318): stopPosture(op) via só current_stop==entry
    // e chamava isso de "breakeven", ignorando os 50% já realizados com
    // lucro no TP1. classifyOutcome soma as duas pernas: o resultado líquido
    // aqui é +0,71% (bem acima do epsilon de 0,1%) — é um ganho, mostrar
    // "sem prejuízo" subestimaria o resultado real da operação.
    renderCard(baseOp({ current_stop: 60000 }));
    screen.getByText(/Stop travou lucro/i);
    expect(screen.queryByText(/sem prejuízo/i)).toBeNull();
  });

  it('stop pré-TP1 avançado além da entrada, mas líquido de custo, é breakeven de verdade', () => {
    // O outro lado do achado do Codex: sem TP1 bancado, um stop nominalmente
    // ACIMA da entrada (o que o trailing pré-TP1 do item 132 produz) pode
    // ainda assim fechar líquido em ~0 depois de taxa/slippage (Fase 5) — a
    // postura geométrica classificaria isso como "locked" (lucro), mas o
    // resultado realizado é breakeven. entry 60000 / stop 60070 rende
    // pnlPct ≈ -0,003% com o modelo de custo padrão — dentro do epsilon.
    renderCard(baseOp({ tp1_hit: false, tp1_hit_at: null, current_stop: 60070 }));
    screen.getByText(/Stop no breakeven — sem prejuízo/i);
  });

  it('stop original (nunca avançou, sem TP1) continua mostrando o texto de risco', () => {
    renderCard(baseOp({ tp1_hit: false, tp1_hit_at: null, current_stop: 59000 }));
    screen.getByText(/Stop atingido — revisar setup/i);
  });
});
