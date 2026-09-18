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
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import TradeCard from './TradeCard.jsx';

// useLivePrice (via TradeCard) passou a logar falha de cotação com
// src/lib/logger.js (achado "SEM COTAÇÃO", 2026-09-18), que importa
// @/api/entities → @/lib/apiBackend → @/lib/firebaseClient — e este último
// chama `getAuth(app)` NO CARREGAMENTO DO MÓDULO, o que lança sem env vars
// reais de Firebase. Mesmo mock que src/pages/pagesSmoke.test.jsx já usa
// pelo mesmo motivo — não inventa um mecanismo novo.
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));

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
    screen.getByText(/Stop atingido — operação encerrada pela proteção inicial/i);
  });

  // Achado da varredura geral (2026-09-18): quando o TP1 já foi bancado mas
  // o resultado LÍQUIDO ainda assim fecha em prejuízo (ex.: o stop pós-TP1
  // nunca avançou e o preço despencou até ele), o banner alegava "proteção
  // INICIAL" enquanto o texto de evidência logo abaixo (OperationDecisionNote,
  // reason_code stop_hit_runner) diz explicitamente "depois do TP1" —
  // contradição direta sobre o mesmo evento. `TradeCard.test.jsx` só cobria
  // o ramo pré-TP1 até esta rodada.
  it('REGRESSÃO: TP1 já bancado mas resultado líquido é prejuízo — banner não alega mais "proteção inicial"', () => {
    renderCard(baseOp({ tp1_hit: true, initial_stop: 55000, current_stop: 55000 }));
    screen.getByText(/Stop atingido — operação encerrada pela proteção pós-TP1/i);
    expect(screen.queryByText(/proteção inicial/i)).toBeNull();
  });
});

describe('TradeCard — StatusBanner do CLOSED usa closedReasonLabel, não "encerrada manualmente" fixo', () => {
  // Achado da revisão de UI (2026-09-15): CLOSED cobre 3 encerramentos
  // AUTOMÁTICOS do motor (Time Stop, Chop Exit, TP1_FULL) além do fechamento
  // manual, mas o banner sempre dizia "encerrada manualmente" — mesmo quando
  // foi o motor que decidiu sair sozinho.
  it('closed_reason TIME_STOP mostra o motivo real, não "manualmente"', () => {
    renderCard(baseOp({ status: 'CLOSED', closed_reason: 'TIME_STOP' }));
    screen.getByText(/Encerrada pelo motor — tempo esgotado/i);
    expect(screen.queryByText(/encerrada manualmente/i)).toBeNull();
  });

  it('closed_reason CHOP_EXIT mostra o motivo real', () => {
    renderCard(baseOp({ status: 'CLOSED', closed_reason: 'CHOP_EXIT' }));
    screen.getByText(/Encerrada pelo motor — mercado sem direção/i);
  });

  it('sem closed_reason (fechamento manual de verdade) continua mostrando "encerrada manualmente"', () => {
    renderCard(baseOp({ status: 'CLOSED', closed_reason: 'Encerrado manualmente' }));
    screen.getByText(/Operação encerrada manualmente/i);
  });
});

describe('TradeCard — market_source aparece nos detalhes técnicos', () => {
  it('futures mostra "Futures" (dado já gravado na operação, sem recalcular nada)', () => {
    renderCard(baseOp({ market_source: 'futures' }));
    screen.getByText(/Futures/);
  });

  it('spot mostra "Spot"', () => {
    renderCard(baseOp({ market_source: 'spot' }));
    screen.getByText(/Spot/);
  });

  it('ausente (op legada) não quebra nem mostra nada', () => {
    renderCard(baseOp({ market_source: undefined }));
    expect(screen.queryByText(/Spot|Futures/)).toBeNull();
  });
});

// Achado de clareza (pedido do usuário, 2026-09-18): headline+why só
// apareciam dentro de "Detalhes técnicos" (fechado por padrão) — os testes
// acima usam `expandAll`, que nunca exercitou esse ponto cego. Este bloco
// renderiza SEM expandAll (o estado real que o usuário vê primeiro).
describe('TradeCard — resumo do "por quê" visível sem expandir', () => {
  function renderCompact(op) {
    const client = makeTestQueryClient();
    return render(
      <QueryClientProvider client={client}>
        <TradeCard operation={op} />
      </QueryClientProvider>,
    );
  }

  it('REGRESSÃO: headline + why aparecem sem clicar em "Detalhes técnicos"', () => {
    renderCompact(baseOp({
      status: 'SIGNAL_CONFIRMED', tp1_hit: false, tp1_hit_at: null,
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'awaiting_tp1',
        facts: { distance_to_tp1: 10, distance_to_stop: 5 }, data_status: 'LIVE',
      },
    }));
    screen.getByText('Monitorando');
    screen.getByText(/Nenhuma condição de saída foi atingida/);
    // A evidência numérica (detalhe granular) continua fora da visão
    // compacta — só o resumo sobe, não o bloco inteiro.
    expect(screen.queryByText(/faltam 10\.0000 até o TP1/)).toBeNull();
  });
});

describe('TradeCard — decision_snapshot (Fase 3, gestão HOLDING/PROTECTED)', () => {
  it('operação aberta com decision_snapshot mostra headline + evidência', () => {
    renderCard(baseOp({
      status: 'SIGNAL_CONFIRMED', tp1_hit: false, tp1_hit_at: null,
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'awaiting_tp1',
        facts: { distance_to_tp1: 10, distance_to_stop: 5 }, data_status: 'LIVE',
      },
    }));
    screen.getByText('Monitorando');
    screen.getByText(/faltam 10\.0000 até o TP1, 5\.0000 de folga até o stop/);
  });

  it('operação aberta sem decision_snapshot (legada) não mostra o bloco nem quebra', () => {
    renderCard(baseOp({ status: 'SIGNAL_CONFIRMED', tp1_hit: false, tp1_hit_at: null }));
    expect(screen.queryByText(/faltam.*até o TP1/)).toBeNull();
  });

  // Fase 4 — EXIT ganhou builder próprio (buildStopHitSnapshot etc.), então
  // toda op que fecha a partir de agora carrega um decision_snapshot de EXIT
  // fresco, nunca mais o HOLDING/PROTECTED residual da última passada aberta
  // (o gate isOpenOp que escondia esse residual foi removido — ver
  // docs/known-risks.md). Este teste cobre o caso comum: EXIT.
  it('operação ENCERRADA com decision_snapshot de EXIT mostra o bloco', () => {
    renderCard(baseOp({
      status: 'STOP_HIT',
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'stop_hit_pre_tp1',
        facts: { stop: 98, stop_check_price: 97.5 }, data_status: 'LIVE',
      },
    }));
    screen.getByText('Stop atingido');
    screen.getByText(/stop em 98\.0000, preço tocou 97\.5000/);
  });

  // Achado de revisão (Codex, PR #376): uma op fechada ANTES da Fase 4 pode
  // carregar um decision_snapshot residual de HOLDING/PROTECTED (Fase 3
  // nunca escrevia snapshot de EXIT) — sem o guard, o bloco mostraria
  // "Monitorando" numa operação já encerrada há muito tempo.
  it('operação ENCERRADA com decision_snapshot residual de HOLDING (op fechada antes da Fase 4) NÃO mostra o bloco', () => {
    renderCard(baseOp({
      status: 'STOP_HIT',
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'awaiting_tp1',
        facts: { distance_to_tp1: 10, distance_to_stop: 5 }, data_status: 'LIVE',
      },
    }));
    expect(screen.queryByText('Monitorando')).toBeNull();
  });
});
