// @vitest-environment jsdom
//
// Achado do conselho de revisão (2026-09-15, docs/known-risks.md item 180):
// SignalChecklist.jsx nunca teve teste — mostrava "ENTRADA LIBERADA/
// BLOQUEADA" refazendo fetch de candles + calculateRangeFilter no navegador,
// sem nenhuma garantia de bater com o motor real. Reescrito para só LER
// SignalEvent.last_rejection_reason/_detail (gravado pelo motor) via
// rejectionCopy() — este teste prova que nenhum recálculo acontece: o mock
// de @/api/entities só expõe SignalEvent.get, sem marketDataProvider nenhum.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import SignalChecklist from './SignalChecklist.jsx';

const signalGetMock = vi.fn();
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      SignalEvent: { get: (...args) => signalGetMock(...args) },
    },
  },
}));

afterEach(() => { cleanup(); signalGetMock.mockReset(); });

function renderChecklist(props) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <SignalChecklist {...props} />
    </QueryClientProvider>,
  );
}

const baseSignal = {
  id: 'sig1', asset_id: 'asset1', symbol: 'BTCUSDT', signal_type: 'BUY', timeframe: '4h',
  created_date: new Date().toISOString(),
};

describe('SignalChecklist — signal completo já em mãos (AssetDrawer.jsx), zero fetch', () => {
  it('mostra o motivo real gravado pelo motor (rejectionCopy), sem chamar SignalEvent.get', () => {
    renderChecklist({
      signal: { ...baseSignal, last_rejection_reason: 'regime_rejected', last_rejection_detail: 'adx' },
      tradeOps: [],
    });
    fireEvent.click(screen.getByText(/Por que ainda não virou operação\?/i));
    expect(screen.getAllByText(/Movimento sem força/i).length).toBeGreaterThan(0);
    screen.getByText(/força da tendência ficou abaixo do mínimo/i);
    screen.getByText(/BLOQUEADA/i);
    expect(signalGetMock).not.toHaveBeenCalled();
  });

  it('operação ativa no mesmo ativo mostra BLOQUEADA mesmo sem last_rejection_reason — caso que o campo não cobre', () => {
    renderChecklist({
      signal: baseSignal,
      tradeOps: [{ asset_id: 'asset1', status: 'SIGNAL_CONFIRMED' }],
    });
    fireEvent.click(screen.getByText(/Por que ainda não virou operação\?/i));
    screen.getByText(/já existe uma operação ativa/i);
    screen.getByText(/BLOQUEADA/i);
  });
});

describe('SignalChecklist — achado do Codex (PR #369): timeframe fora de 4h não pode mostrar veredito contraditório', () => {
  // classifySignal() dá fase INFO pra qualquer timeframe != '4h' — antes da
  // correção, `blocked` olhava só a fase, então um sinal 1h REJEITADO (com
  // motivo já mostrado acima) ainda caía em "ENTRADA LIBERADA" verde,
  // contradizendo o próprio motivo.
  it('sinal 1h com last_rejection_reason mostra BLOQUEADA, nunca ENTRADA LIBERADA', () => {
    renderChecklist({
      signal: { ...baseSignal, timeframe: '1h', last_rejection_reason: 'regime_rejected', last_rejection_detail: 'chop' },
      tradeOps: [],
    });
    fireEvent.click(screen.getByText(/Por que ainda não virou operação\?/i));
    screen.getByText(/Preço andando de lado/i);
    screen.getByText(/BLOQUEADA/i);
    expect(screen.queryByText(/ENTRADA LIBERADA/i)).toBeNull();
  });

  it('sinal 1d sem motivo e sem op ativa não afirma nenhum veredito (nem verde nem vermelho) — mostra a ressalva informativa', () => {
    renderChecklist({ signal: { ...baseSignal, timeframe: '1d' }, tradeOps: [] });
    fireEvent.click(screen.getByText(/Por que ainda não virou operação\?/i));
    expect(screen.queryByText(/ENTRADA LIBERADA/i)).toBeNull();
    expect(screen.queryByText(/BLOQUEADA/i)).toBeNull();
    screen.getByText(/nunca vira operação/i);
  });

  it('sinal 1h sem motivo, mas com operação ativa, ainda mostra BLOQUEADA — fato universal, independe do timeframe', () => {
    renderChecklist({
      signal: { ...baseSignal, timeframe: '1h' },
      tradeOps: [{ asset_id: 'asset1', status: 'RUNNER_ACTIVE' }],
    });
    fireEvent.click(screen.getByText(/Por que ainda não virou operação\?/i));
    screen.getByText(/BLOQUEADA/i);
  });
});

describe('SignalChecklist — achado da varredura sistemática (item 196): ENTRADA LIBERADA falsa quando tradeOps não pôde ser confirmado', () => {
  it('sinal 4h sem motivo e sem op ativa mostra ENTRADA LIBERADA quando tradeOps é confiável (baseline)', () => {
    renderChecklist({ signal: baseSignal, tradeOps: [], tradeOpsUnavailable: false });
    fireEvent.click(screen.getByText(/Por que ainda não virou operação\?/i));
    screen.getByText(/ENTRADA LIBERADA/i);
  });

  it('mesmo sinal com tradeOpsUnavailable=true NUNCA afirma ENTRADA LIBERADA — mostra "não verificado"', () => {
    renderChecklist({ signal: baseSignal, tradeOps: [], tradeOpsUnavailable: true });
    fireEvent.click(screen.getByText(/Por que ainda não virou operação\?/i));
    expect(screen.queryByText(/ENTRADA LIBERADA/i)).toBeNull();
    screen.getByText(/NÃO VERIFICADO/i);
    screen.getByText(/não foi possível confirmar se já existe uma operação ativa/i);
  });

  it('um bloqueio já conhecido (last_rejection_reason) continua BLOQUEADA mesmo com tradeOpsUnavailable=true', () => {
    renderChecklist({
      signal: { ...baseSignal, last_rejection_reason: 'regime_rejected', last_rejection_detail: 'adx' },
      tradeOps: [],
      tradeOpsUnavailable: true,
    });
    fireEvent.click(screen.getByText(/Por que ainda não virou operação\?/i));
    screen.getByText(/BLOQUEADA/i);
    expect(screen.queryByText(/ENTRADA LIBERADA/i)).toBeNull();
  });

  it('operação ativa CONFIRMADA continua BLOQUEADA mesmo com tradeOpsUnavailable=true (dado real presente, não é o caso incerto)', () => {
    renderChecklist({
      signal: baseSignal,
      tradeOps: [{ asset_id: 'asset1', status: 'SIGNAL_CONFIRMED' }],
      tradeOpsUnavailable: true,
    });
    fireEvent.click(screen.getByText(/Por que ainda não virou operação\?/i));
    screen.getByText(/BLOQUEADA/i);
    expect(screen.queryByText(/NÃO VERIFICADO/i)).toBeNull();
  });
});

describe('SignalChecklist — só signalEventId (Verification.jsx), busca sob demanda', () => {
  it('não busca antes de expandir, busca só ao expandir', async () => {
    signalGetMock.mockResolvedValueOnce({ ...baseSignal, last_rejection_reason: 'trend_reversed', last_rejection_detail: 'now_down' });
    renderChecklist({ signalEventId: 'sig1', tradeOps: [] });
    expect(signalGetMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(/Por que ainda não virou operação\?/i));
    expect(signalGetMock).toHaveBeenCalledWith('sig1');
    await waitFor(() => screen.getByText(/Tendência virou p\/ baixo/i));
  });

  it('erro ao buscar o sinal original mostra mensagem graciosa, não quebra', async () => {
    signalGetMock.mockRejectedValueOnce(new Error('boom'));
    renderChecklist({ signalEventId: 'sig-inexistente', tradeOps: [] });
    fireEvent.click(screen.getByText(/Por que ainda não virou operação\?/i));
    await waitFor(() => screen.getByText(/Não foi possível carregar o aviso original agora/i));
  });
});
