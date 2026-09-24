// @vitest-environment jsdom
//
// Achados da varredura sistemática (2026-09-24, docs/known-risks.md item
// 196): três falhas silenciosas nesta página quando queries secundárias
// falham (network/servidor) sem cache nenhum.
//   1. A falha da query de ativos monitorados (`monitored-assets-verification`)
//      zerava `assets`, escondendo o SignalChecklist de TODAS as tarefas
//      (guarda `asset &&` removida) e deixava `resend()` chamar
//      `notifyVerificationTask(signal, undefined)` — que cai no filtro
//      GLOBAL de fonte/tipo em vez do filtro POR ATIVO configurado
//      (src/lib/telegram.js:145/162), silenciosamente.
//   2. A falha da query de operações (`trade-operations-verification`)
//      fazia o SignalChecklist afirmar "ENTRADA LIBERADA" (via
//      hasActiveOp=false por dado zerado, não por ausência real de
//      operação) — mesma classe do achado mais grave da varredura.
// Este teste prova as duas correções: reenvio desativado quando os ativos
// não puderem ser confirmados, e o checklist nunca afirmando liberação
// quando as operações não puderem ser confirmadas.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';
import Verification from './Verification.jsx';

const verificationTaskFilterMock = vi.fn();
const monitoredAssetListMock = vi.fn();
const tradeOperationListMock = vi.fn();
const signalEventGetMock = vi.fn();

vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      VerificationTask: {
        filter: (...args) => verificationTaskFilterMock(...args),
        update: vi.fn(async (id, data) => ({ id, ...data })),
      },
      MonitoredAsset: { list: (...args) => monitoredAssetListMock(...args) },
      TradeOperation: { list: (...args) => tradeOperationListMock(...args) },
      SignalEvent: { get: (...args) => signalEventGetMock(...args) },
    },
  },
}));

vi.mock('@/lib/telegram', () => ({
  notifyVerificationTask: vi.fn(async () => true),
  isTelegramConfigured: () => true,
}));

const TASK = {
  id: 'task1', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h',
  signal_type: 'BUY', status: 'pending', priority: 'high',
  signal_event_id: 'sig1', created_date: new Date().toISOString(),
};

afterEach(() => {
  cleanup();
  verificationTaskFilterMock.mockReset();
  monitoredAssetListMock.mockReset();
  tradeOperationListMock.mockReset();
  signalEventGetMock.mockReset();
});

describe('Verification — reenvio desativado quando ativos monitorados não podem ser confirmados', () => {
  it('desativa o botão Reenviar e avisa, em vez de reenviar com filtro por-ativo perdido silenciosamente', async () => {
    verificationTaskFilterMock.mockResolvedValue([TASK]);
    monitoredAssetListMock.mockRejectedValue(new Error('network'));
    tradeOperationListMock.mockResolvedValue([]);

    renderPage(<Verification />);

    await screen.findByText(/não foi possível carregar os ativos monitorados/i);
    const resendButton = await screen.findByRole('button', { name: /reenviar/i });
    expect(resendButton.disabled).toBe(true);
  });
});

describe('Verification — SignalChecklist nunca afirma ENTRADA LIBERADA quando operações não podem ser confirmadas', () => {
  it('mostra NÃO VERIFICADO em vez de ENTRADA LIBERADA quando a query de operações falha', async () => {
    verificationTaskFilterMock.mockResolvedValue([TASK]);
    monitoredAssetListMock.mockResolvedValue([{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }]);
    tradeOperationListMock.mockRejectedValue(new Error('network'));
    signalEventGetMock.mockResolvedValue({
      id: 'sig1', asset_id: 'a1', symbol: 'BTCUSDT', signal_type: 'BUY', timeframe: '4h',
      created_date: new Date().toISOString(),
    });

    renderPage(<Verification />);

    const toggle = await screen.findByText(/Por que ainda não virou operação\?/i);
    fireEvent.click(toggle);

    await waitFor(() => screen.getByText(/NÃO VERIFICADO/i));
    expect(screen.queryByText(/ENTRADA LIBERADA/i)).toBeNull();
  });
});

// Achado A-11 do Raio-X de UI/UX: o filtro de prioridade tinha 4 opções
// (Todas/Alta/Média/Baixa), mas `VerificationTask.priority` é SEMPRE
// 'high' por desenho (scanner.js só cria a tarefa dentro de
// `if (signal.priority === 'high')`) — "Média"/"Baixa" nunca mudavam o
// resultado, filtro morto. Este teste prova que a UI parou de prometer um
// filtro sem dado correspondente.
describe('Verification — filtro de prioridade só mostra Todas/Alta (achado A-11)', () => {
  it('não renderiza os botões Média/Baixa', async () => {
    verificationTaskFilterMock.mockResolvedValue([TASK]);
    monitoredAssetListMock.mockResolvedValue([{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }]);
    tradeOperationListMock.mockResolvedValue([]);

    renderPage(<Verification />);

    await screen.findByRole('button', { name: 'Alta' });
    expect(screen.queryByRole('button', { name: 'Média' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Baixa' })).toBeNull();
  });
});
