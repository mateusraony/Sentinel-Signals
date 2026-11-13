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
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import TradeCard, { ScoreBar } from './TradeCard.jsx';

// useLivePrice (via TradeCard) passou a logar falha de cotação com
// src/lib/logger.js (achado "SEM COTAÇÃO", 2026-09-18), que importa
// @/api/entities → @/lib/apiBackend → @/lib/firebaseClient — e este último
// chama `getAuth(app)` NO CARREGAMENTO DO MÓDULO, o que lança sem env vars
// reais de Firebase. Mesmo mock que src/pages/pagesSmoke.test.jsx já usa
// pelo mesmo motivo — não inventa um mecanismo novo.
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));

// Achado A-6 (3ª sub-rodada): TradeCard ganhou Tooltip/TooltipTrigger, que
// precisam de um preço real pra exercitar a agulha da LevelRail e as
// células de nível (só viram gatilho quando `level.pct !== null`, e isso
// depende de `useLivePrice` → `fetchCurrentPrice`). Mesmo padrão de mock já
// usado em src/hooks/useLivePrice.test.jsx (vi.hoisted + vi.fn, pra poder
// trocar o valor resolvido por teste). Default null preserva o
// comportamento que os testes pré-existentes abaixo já assumiam (nenhum
// deles depende de preço real).
const { fetchCurrentPriceMock } = vi.hoisted(() => ({ fetchCurrentPriceMock: vi.fn() }));
vi.mock('@/lib/marketDataProvider', () => ({ fetchCurrentPrice: fetchCurrentPriceMock }));
beforeEach(() => {
  fetchCurrentPriceMock.mockReset();
  fetchCurrentPriceMock.mockResolvedValue(null);
});

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
      <TooltipProvider>
        <TradeCard operation={op} expandAll />
      </TooltipProvider>
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

// Item 280: 1 emoji = 1 significado — runner é 🏃 (antes 🚀 aqui e ⚡ no cartão do ativo).
describe('TradeCard — emojis do banner (item 280)', () => {
  it('runner ativo usa 🏃, nunca 🚀', () => {
    const { container } = renderCard(baseOp({ status: 'RUNNER_ACTIVE', current_stop: 60000 }));
    screen.getByText(/🏃 Runner ativo/);
    expect(container.textContent).not.toMatch(/🚀/);
  });
});

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
    screen.getByText(/🟡 Stop no breakeven — sem prejuízo/i); // item 280: 🟡 = breakeven (antes 🔄)
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
        <TooltipProvider>
          <TradeCard operation={op} />
        </TooltipProvider>
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

// Achado A-6 do Raio-X de UI/UX (3ª sub-rodada): 9 ocorrências de title=
// nativo em TradeCard.jsx. 8 viraram Tooltip/TooltipTrigger asChild com
// tabIndex={0} (elementos não focáveis por padrão — diferente da 2ª
// sub-rodada, que era só botões); a 9ª (agulha de preço na LevelRail, sem
// texto/foco) só teve o title= removido, sem Tooltip — decisão de design:
// é puramente decorativa e o aria-label do <div role="img"> pai já
// descreve a mesma informação por completo (docs/known-risks.md item 206).
describe('TradeCard — elementos usam Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: linha "Aberta em ..." (camada 1, sempre visível) não tem title=, vira gatilho focável', () => {
    renderCard(baseOp());
    const badge = screen.getByText(/^Aberta em /);
    expect(badge.getAttribute('title')).toBeNull();
    expect(badge.getAttribute('tabindex')).toBe('0');
  });

  it('REGRESSÃO: badge de status curto não tem title= nativo, vira gatilho focável (tooltip = status.desc)', () => {
    renderCard(baseOp({ status: 'RUNNER_ACTIVE', tp1_hit: true }));
    const badge = screen.getByText('Runner');
    expect(badge.getAttribute('title')).toBeNull();
    expect(badge.getAttribute('tabindex')).toBe('0');
  });

  it('REGRESSÃO: "🎚 Tier" não tem title= nativo, vira gatilho focável', () => {
    renderCard(baseOp({ tier: 'B' }));
    const tierLine = screen.getByText(/Tier B/);
    expect(tierLine.getAttribute('title')).toBeNull();
    expect(tierLine.getAttribute('tabindex')).toBe('0');
  });

  it('REGRESSÃO: fonte do mercado (Spot/Futures) não tem title= nativo, vira gatilho focável', () => {
    renderCard(baseOp({ market_source: 'futures' }));
    const marketBadge = screen.getByText(/Futures/);
    expect(marketBadge.getAttribute('title')).toBeNull();
    expect(marketBadge.getAttribute('tabindex')).toBe('0');
  });

  it('REGRESSÃO: bloco MFE/MAE não tem title= nativo, vira gatilho focável', () => {
    renderCard(baseOp({ mfe_r: 1.2, mae_r: -0.5 }));
    const mfeBlock = screen.getByText(/MFE/).closest('[tabindex="0"]');
    expect(mfeBlock).not.toBeNull();
    expect(mfeBlock.getAttribute('title')).toBeNull();
  });

  it('REGRESSÃO: legenda "em aberto · bruto" (só com posição aberta) não tem title= nativo, vira gatilho focável', async () => {
    fetchCurrentPriceMock.mockResolvedValue(60500);
    renderCard(baseOp({ status: 'SIGNAL_CONFIRMED', tp1_hit: false, tp1_hit_at: null }));
    const legend = await screen.findByText('em aberto · bruto');
    expect(legend.getAttribute('title')).toBeNull();
    expect(legend.getAttribute('tabindex')).toBe('0');
  });

  it('REGRESSÃO: aviso de cotação desatualizada (MilestoneLine, ⚠️) não tem title= nativo, vira gatilho focável', async () => {
    // isStale = price !== null && (isError || idade > 90s). Semeia dado
    // "sucesso, mas velho" (updatedAt no passado) e nunca resolve o
    // refetch em segundo plano (staleTime:0 dispara um automaticamente) —
    // assim a idade não é apagada por um refetch concorrente durante o
    // teste, sem precisar simular erro de rede.
    const client = makeTestQueryClient();
    client.setQueryData(['live-price', 'BTCUSDT'], 60500, { updatedAt: Date.now() - 200_000 });
    fetchCurrentPriceMock.mockReturnValue(new Promise(() => {}));
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <TradeCard operation={baseOp({ status: 'SIGNAL_CONFIRMED', tp1_hit: false, tp1_hit_at: null, current_stop: 59000 })} expandAll />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const warning = await screen.findByText('⚠️');
    expect(warning.getAttribute('title')).toBeNull();
    expect(warning.getAttribute('tabindex')).toBe('0');
  });

  it('REGRESSÃO: célula de nível (grid stop/entrada/TP1/TP2) não tem title= nativo, vira gatilho focável quando há preço', async () => {
    fetchCurrentPriceMock.mockResolvedValue(60500);
    renderCard(baseOp({ current_stop: 59000 }));
    const tp1Cell = await waitFor(() => {
      // Item 303: o nome do nível aparece duas vezes (em cima da trilha, decorativo, e na célula da grade) — o gatilho é a célula.
      const cell = screen.getAllByText('TP1 ✓').map((el) => el.closest('[tabindex="0"]')).find(Boolean);
      expect(cell).toBeTruthy();
      return cell;
    });
    expect(tp1Cell.getAttribute('title')).toBeNull();
  });

  it('a agulha de preço na LevelRail não vira Tooltip (decorativa, sem foco) — só o title= sai, coberto pelo aria-label do pai', async () => {
    fetchCurrentPriceMock.mockResolvedValue(60500);
    const { container } = renderCard(baseOp({ current_stop: 59000 }));
    await waitFor(() => {
      const rail = container.querySelector('[role="img"]');
      expect(rail).not.toBeNull();
      expect(rail.querySelector('[title]')).toBeNull();
      expect(rail.getAttribute('aria-label')).toMatch(/Stop \$.*entrada \$.*TP1 \$.*TP2 \$/);
    });
  });
});


// Item 277 (review do PR-B): operação sem score numérico (MACD/EMA/RSI/SMC) não
// mostra "🧩 0/100" inventado.
describe('ScoreBar — sem score numérico, nada', () => {
  it('não renderiza sem score e mostra 🧩 com score', () => {
    for (const score of [undefined, null, NaN, '85']) {
      const { container, unmount } = render(<ScoreBar score={score} />);
      expect(container.firstChild).toBeNull();
      unmount();
    }
    render(<ScoreBar score={72} />);
    expect(screen.getByText('🧩 72/100')).toBeTruthy();
  });
});

// Item 278 (PR-C): operação que não veio do motor tem marca visível — e diz
// que fica fora das estatísticas.
describe('TradeCard — marca de simulação manual e de encerramento à mão (item 278)', () => {
  it('🧪 SIMULAÇÃO em operação criada pelo painel', () => {
    renderCard(baseOp({ source: 'manual' }));
    expect(screen.getByText(/🧪 Simulação manual/)).toBeTruthy();
    expect(screen.getByText(/nenhuma ordem foi enviada/i)).toBeTruthy();
    expect(screen.getAllByText(/fora da medição do motor/).length).toBeGreaterThan(0);
  });

  it('✏️ encerrada à mão (edição, Encerrar ou Invalidar pelo painel)', () => {
    for (const closed_reason of ['Alterado manualmente', 'Encerrado manualmente', 'Invalidado manualmente']) {
      const { unmount } = renderCard(baseOp({ closed_reason }));
      expect(screen.getByText(/✏️ Encerrada à mão/)).toBeTruthy();
      unmount();
    }
  });

  it('operação do motor não ganha marca', () => {
    renderCard(baseOp());
    expect(screen.queryByText(/🧪 Simulação manual|✏️ Encerrada à mão/)).toBeNull();
  });
});

// Item 303 — pedido do usuário (13/11/2026) depois de olhar uma operação real (QNT/USDT, venda, stop já além da entrada):
// "não consigo bater o olho e entender o que está acontecendo", "fica confuso saber em que horário foi aberta", "o que já tem
// garantido se fechar nesse novo stop", "os motivos estão muito simples".
describe('TradeCard — cartão legível de bater o olho (item 303)', () => {
  const qnt = (overrides = {}) => ({
    id: 'qnt', symbol: 'QNTUSDT', side: 'SELL', status: 'SIGNAL_CONFIRMED', timeframe: '15m', signal_timeframe: '4h',
    entry_price: 180.56, initial_stop: 199.4, current_stop: 171.6, tp1: 152.3, tp2: 124.04,
    partial_percent: 50, runner_percent: 50, score: 85,
    created_date: '2026-11-10T19:57:00.000Z',
    candle_open_time: '2026-11-10T12:00:00.000Z', candle_close_time: '2026-11-10T15:59:59.999Z', candle_status: 'CLOSED',
    mfe_r: 1.08, mae_r: -0.05, bars_to_mfe: 9,
    signal_reasons: ['Follow-through confirmado (+25)', 'MACD hist negativo (+20)', 'Indicador que o glossário não conhece (+7)'],
    pre_tp1_stop_advanced_at: '2026-11-12T20:10:00.000Z',
    decision_snapshot: {
      decision: 'PROTECTED', reason_code: 'pre_tp1_trailing_advanced',
      facts: { favorable_move: 20.33, required_move: 5.6857, stop_before: 172, stop_after: 171.6 },
      evaluated_at: '2026-11-12T20:10:00.000Z',
    },
    ...overrides,
  });

  function renderCollapsed(op, props = {}) {
    return render(
      <QueryClientProvider client={makeTestQueryClient()}>
        <TooltipProvider>
          <TradeCard operation={op} {...props} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }
  const zones = (container) => [...container.querySelectorAll('[data-rail-zone]')].map((el) => el.getAttribute('data-rail-zone'));
  const legend = (container) => [...container.querySelectorAll('[data-rail-legend]')].map((el) => el.textContent);
  const guarantee = (container) => container.querySelector('[data-guarantee]');

  describe('quando abriu', () => {
    it('hora de abertura por extenso, em Brasília, uma vez só, e há quanto tempo está aberta', () => {
      renderCollapsed(qnt());
      expect(screen.getAllByText('Aberta em 10/11 às 16:57')).toHaveLength(1);
      expect(screen.getByText(/^· há \d+d \d+h$/)).toBeTruthy();
    });

    it('operação encerrada não ganha "há …" (seria o tempo desde a abertura, não a duração)', () => {
      renderCollapsed(baseOp());
      expect(screen.getByText(/^Aberta em /)).toBeTruthy();
      expect(screen.queryByText(/^· há /)).toBeNull();
    });

    it('sem data de criação, a linha some (nunca "Invalid date")', () => {
      const { container } = renderCollapsed(qnt({ created_date: null }));
      expect(screen.queryByText(/^Aberta em /)).toBeNull();
      expect(container.textContent).not.toMatch(/Invalid/i);
    });

    it('o selo de timeframe diz aviso → entrada ("4H → 15M"), não só o da entrada', () => {
      renderCollapsed(qnt());
      expect(screen.getByText('4H → 15M')).toBeTruthy();
    });

    it('REGRESSÃO: a vela do aviso é chamada pelo nome e não há mais "Fechado" solto numa operação ativa', () => {
      const { container } = renderCard(qnt());
      expect(screen.getByText(/Vela do aviso \(4H\): 10\/11 09:00 → 10\/11 12:59 \(Brasília\)\s*· vela já fechada/)).toBeTruthy();
      expect(container.textContent).not.toMatch(/✅ Fechado/);
      expect(container.textContent).not.toMatch(/\bBRT\b/);
    });

    it('vela ainda aberta e operação sem vela gravada', () => {
      const { unmount } = renderCard(qnt({ candle_status: 'OPEN' }));
      expect(screen.getByText(/vela ainda aberta/)).toBeTruthy();
      unmount();
      const { container } = renderCard(qnt({ candle_open_time: null, candle_close_time: null }));
      expect(container.textContent).not.toMatch(/Vela do aviso/);
    });
  });

  describe('a trilha', () => {
    it('REGRESSÃO: stop além da entrada vira "lucro protegido" — nenhuma faixa de risco por cima do verde', () => {
      const { container } = renderCollapsed(qnt());
      expect(zones(container)).toEqual(['riskRemoved', 'locked', 'reward']);
      expect(legend(container)).toEqual(['risco já eliminado', 'lucro protegido', 'falta buscar']);
    });

    it('stop ainda no inicial: risco em jogo + o que falta buscar', () => {
      const { container } = renderCollapsed(qnt({ current_stop: 199.4, decision_snapshot: null }));
      expect(zones(container)).toEqual(['risk', 'reward']);
      expect(legend(container)).toEqual(['risco em jogo', 'falta buscar']);
    });

    it('os nomes ficam escritos em cima da trilha, com o stop inicial como marcador próprio', () => {
      const { container } = renderCollapsed(qnt());
      const labels = [...container.querySelectorAll('[data-rail-label]')].map((el) => el.textContent);
      expect(labels).toEqual(['Stop inicial', 'Entrada', 'Stop 🔒', 'TP1', 'TP2']);
      expect(container.querySelector('[data-rail-marker="initialStop"]')).not.toBeNull();
      expect(container.querySelector('[role="img"]').getAttribute('aria-label')).toMatch(/Stop inicial \$199\.40\./);
    });

    it('sem stop inicial diferente do atual, não há marcador de stop inicial', () => {
      const { container } = renderCollapsed(qnt({ current_stop: 199.4, decision_snapshot: null }));
      expect(container.querySelector('[data-rail-marker="initialStop"]')).toBeNull();
      expect(container.querySelector('[role="img"]').getAttribute('aria-label')).not.toMatch(/Stop inicial/);
    });

    it('venda: lucro à direita, com o aviso escrito, e a grade de preços na mesma ordem da trilha', () => {
      const { container } = renderCollapsed(qnt());
      expect(screen.getByText(/venda: o lucro cresce para a direita \(preço caindo\)/)).toBeTruthy();
      const cells = [...container.querySelectorAll('.grid.grid-cols-4 > div')].map((el) => el.textContent);
      expect(cells.map((t) => t.match(/^(Entrada|Stop 🔒|TP1|TP2)/)?.[1])).toEqual(['Entrada', 'Stop 🔒', 'TP1', 'TP2']);
      const pos = (key) => parseFloat(container.querySelector(`[data-rail-marker="${key}"]`).style.left);
      expect(pos('initialStop')).toBeLessThan(pos('entry'));
      expect(pos('entry')).toBeLessThan(pos('stop'));
      expect(pos('stop')).toBeLessThan(pos('tp1'));
      expect(pos('tp1')).toBeLessThan(pos('tp2'));
    });

    it('compra não ganha o aviso de venda', () => {
      const { container } = renderCollapsed({
        ...qnt(), side: 'BUY', entry_price: 100, initial_stop: 95, current_stop: 95, tp1: 107.5, tp2: 115, decision_snapshot: null,
      });
      expect(container.textContent).not.toMatch(/venda: o lucro cresce/);
    });

    it('operação encerrada: a trilha continua, mas sem a legenda do que "está em jogo"', () => {
      const { container } = renderCollapsed(qnt({ status: 'STOP_HIT', exit_price: 171.6 }));
      expect(zones(container).length).toBeGreaterThan(0);
      expect(legend(container)).toEqual([]);
    });

    it('a agulha do preço aparece quando há cotação', async () => {
      fetchCurrentPriceMock.mockResolvedValue(161.79);
      const { container } = renderCollapsed(qnt());
      await waitFor(() => expect(container.querySelector('[data-rail-needle]')).not.toBeNull());
      const needle = parseFloat(container.querySelector('[data-rail-needle]').style.left);
      const pos = (key) => parseFloat(container.querySelector(`[data-rail-marker="${key}"]`).style.left);
      expect(needle).toBeGreaterThan(pos('stop'));
      expect(needle).toBeLessThan(pos('tp1'));
      expect(screen.getByText('▲ preço agora')).toBeTruthy();
    });
  });

  describe('com quanto fecha se bater no stop', () => {
    it('stop no lucro: diz o % e o R, com o preço do stop', () => {
      const { container } = renderCollapsed(qnt());
      const line = guarantee(container);
      expect(line.getAttribute('data-guarantee')).toBe('profit');
      expect(line.textContent).toMatch(/^🛡️ Lucro protegido: se o preço voltar e bater no stop \(\$171\.60\), a operação fecha com \+4\.96% \(\+0\.48R\)\./);
    });

    it('stop no inicial: diz a perda, sem a palavra "protegido"', () => {
      const { container } = renderCollapsed(qnt({ current_stop: 199.4, decision_snapshot: null }));
      const line = guarantee(container);
      expect(line.getAttribute('data-guarantee')).toBe('loss');
      expect(line.textContent).toMatch(/^🛑 Risco em jogo: se o preço bater no stop \(\$199\.40\), a operação fecha com -10\.43% \(-1\.00R\)\./);
      expect(line.textContent).not.toMatch(/protegido/);
    });

    it('stop na entrada: zero a zero, sem número inventado', () => {
      const { container } = renderCollapsed(qnt({ current_stop: 180.56, decision_snapshot: null }));
      const line = guarantee(container);
      expect(line.getAttribute('data-guarantee')).toBe('zero');
      expect(line.textContent).toMatch(/^🟡 Breakeven: se o preço voltar e bater no stop \(\$180\.56\), a operação fecha no zero a zero\./);
      expect(line.textContent).not.toMatch(/%/);
    });

    it('runner: a conta já soma a parcela realizada no TP1 e diz isso', () => {
      const { container } = renderCollapsed(qnt({ status: 'RUNNER_ACTIVE', tp1_hit: true, tp1_hit_price: 152.3, current_stop: 180.56, decision_snapshot: null }));
      const line = guarantee(container);
      expect(line.getAttribute('data-guarantee')).toBe('profit');
      expect(line.textContent).toMatch(/a operação fecha com \+7\.83% \(\+0\.75R\), já contando os 50% realizados no TP1\./);
    });

    it('sem stop inicial (legado): mostra o % e omite o R em vez de inventar', () => {
      const { container } = renderCollapsed(qnt({ initial_stop: null, decision_snapshot: null }));
      expect(guarantee(container).textContent).toMatch(/a operação fecha com \+4\.96%\./);
      expect(guarantee(container).textContent).not.toMatch(/R\)/);
    });

    it('operação encerrada não mostra a frase (o resultado real está no banner/Histórico)', () => {
      const { container } = renderCollapsed(qnt({ status: 'STOP_HIT', exit_price: 171.6 }));
      expect(guarantee(container)).toBeNull();
    });

    it('avisa que é bruto e no preço do stop, em gatilho focável (sem title= nativo)', () => {
      renderCollapsed(qnt());
      const tag = screen.getByText('bruto · no preço do stop');
      expect(tag.getAttribute('tabindex')).toBe('0');
      expect(tag.getAttribute('title')).toBeNull();
    });
  });

  describe('a história até agora', () => {
    it('aparece SEM clicar em "Detalhes técnicos", em ordem, com o "de A para B" do stop', () => {
      renderCollapsed(qnt());
      const story = screen.getByRole('group', { name: 'A história até agora' });
      const steps = [...story.querySelectorAll('li')].map((li) => li.textContent);
      expect(steps).toHaveLength(4);
      expect(steps[0]).toBe('📍 Abriu uma operação de venda a $180.56 em 10/11 às 16:57 (aviso do gráfico de 4H, confirmado no de 15M).');
      expect(steps[1]).toMatch(/^O stop inicial ficou em \$199\.40: o risco assumido era de -10\.43%/);
      expect(steps[2]).toMatch(/^Desde a entrada: no melhor ponto chegou a \+11\.27% \(\+1\.08R\)/);
      expect(steps[3]).toBe('🛡️ Stop protegido: a última mudança foi em 12/11 às 17:10, de $172.00 para $171.60 (o inicial era $199.40).');
    });

    it('operação encerrada não ganha este bloco (a história completa fica no Histórico)', () => {
      renderCollapsed(qnt({ status: 'STOP_HIT', exit_price: 171.6 }));
      expect(screen.queryByRole('group', { name: 'A história até agora' })).toBeNull();
    });
  });

  describe('por que entrou', () => {
    it('cada motivo conhecido vem com título, "O que é", "Por que conta" e os pontos', () => {
      renderCard(qnt());
      const block = screen.getByRole('group', { name: 'Por que entrou' });
      const items = [...block.querySelectorAll('li')];
      expect(items).toHaveLength(3);
      expect(items[0].textContent).toMatch(/^O movimento continuou depois da virada\+25 pontosO que é: .+Por que conta: .+/);
      expect(items[1].textContent).toMatch(/^Força do movimento a favor \(MACD negativo\)\+20 pontosO que é: .+queda.+Por que conta: /);
      expect(block.textContent).toMatch(/Por que entrou — regras a favor na hora do aviso: 3/);
      expect(block.textContent).toMatch(/🧩 85\/100/);
    });

    it('motivo que o glossário não conhece aparece como veio, sem explicação inventada', () => {
      renderCard(qnt());
      const items = [...screen.getByRole('group', { name: 'Por que entrou' }).querySelectorAll('li')];
      expect(items[2].textContent).toBe('Indicador que o glossário não conhece+7 pontos');
    });

    it('fica atrás de "Detalhes técnicos" (não polui a primeira leitura)', () => {
      renderCollapsed(qnt());
      expect(screen.queryByRole('group', { name: 'Por que entrou' })).toBeNull();
    });

    it('sem motivos e sem score: o bloco não existe; só com score: só a barra', () => {
      const { unmount } = renderCard(qnt({ signal_reasons: [], score: null }));
      expect(screen.queryByRole('group', { name: 'Por que entrou' })).toBeNull();
      unmount();
      renderCard(qnt({ signal_reasons: null }));
      const block = screen.getByRole('group', { name: 'Por que entrou' });
      expect(block.querySelectorAll('li')).toHaveLength(0);
      expect(block.textContent).toMatch(/🧩 85\/100/);
    });

    it('REGRESSÃO: os números da trilha saem em linguagem simples, não em "movimento favorável 20.3300, gatilho da trilha em 5.6857"', () => {
      const { container } = renderCard(qnt());
      expect(screen.getByText(/A trilha do stop só começa a agir depois que o preço anda \$5\.6857 \(3\.15% da entrada\) a favor\. No melhor ponto ele já andou \$20\.3300 \(11\.26%\): a proteção está ativa\. \(medido em 12\/11 às 17:10, Brasília\)/)).toBeTruthy();
      expect(container.textContent).not.toMatch(/gatilho da trilha em/);
    });
  });

  it('railProfitToRight desligado (comparação visual): eixo de preço fixo e o aviso muda de lado', () => {
    const { container } = renderCollapsed(qnt(), { railProfitToRight: false });
    expect(screen.getByText(/venda: o lucro cresce para a esquerda \(preço caindo\)/)).toBeTruthy();
    const pos = (key) => parseFloat(container.querySelector(`[data-rail-marker="${key}"]`).style.left);
    expect(pos('tp2')).toBeLessThan(pos('entry'));
  });
});
