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
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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

// isTelegramConfigured precisa ser controlável por teste (achado A-6, o
// botão "Reenviar" mostra um 3º texto de tooltip quando o Telegram não
// está configurado) — vi.hoisted, mesmo padrão já usado noutras rodadas.
const { isTelegramConfiguredMock } = vi.hoisted(() => ({ isTelegramConfiguredMock: vi.fn() }));
vi.mock('@/lib/telegram', () => ({
  notifyVerificationTask: vi.fn(async () => true),
  isTelegramConfigured: isTelegramConfiguredMock,
}));

beforeEach(() => {
  isTelegramConfiguredMock.mockReset();
  isTelegramConfiguredMock.mockReturnValue(true);
});

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

// Achado A-6 do Raio-X de UI/UX (2ª sub-rodada, Grupo 1): os botões
// ícone-só "Marcar como revisado (OK)"/"Pular" usavam `title=` nativo.
// Migrados pro Tooltip do Radix + `aria-label` (sem o aria-label, o botão
// perderia o nome acessível por completo ao perder o title=).
describe('Verification — botões de ação usam Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: "Marcar como revisado"/"Pular" não têm title= nativo, mantêm nome acessível', async () => {
    verificationTaskFilterMock.mockResolvedValue([TASK]);
    monitoredAssetListMock.mockResolvedValue([{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }]);
    tradeOperationListMock.mockResolvedValue([]);

    renderPage(<Verification />);

    const reviewButton = await screen.findByRole('button', { name: 'Marcar como revisado (OK)' });
    const skipButton = screen.getByRole('button', { name: 'Pular' });
    expect(reviewButton.getAttribute('title')).toBeNull();
    expect(skipButton.getAttribute('title')).toBeNull();
  });
});

// Achado A-6 do Raio-X de UI/UX (8ª sub-rodada, Grupo 4): o botão
// "Reenviar" tinha `title=` condicional (3 textos possíveis, conforme o
// motivo do `disabled`) — mesmo padrão já resolvido em Backtest.jsx
// ("Aplicar ao Scanner"): Tooltip sempre presente; quando desabilitado,
// o botão ganha um wrapper `<span tabIndex={0}>` (eventos de mouse não
// chegam a um `<button disabled>` nativo, então o Tooltip nunca
// dispararia sem ele).
describe('Verification — botão "Reenviar" usa Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: desabilitado por ativos indisponíveis, não tem title= nativo, ganha wrapper focável', async () => {
    verificationTaskFilterMock.mockResolvedValue([TASK]);
    monitoredAssetListMock.mockRejectedValue(new Error('network'));
    tradeOperationListMock.mockResolvedValue([]);

    renderPage(<Verification />);

    const resendButton = await screen.findByRole('button', { name: /reenviar/i });
    expect(resendButton.disabled).toBe(true);
    expect(resendButton.getAttribute('title')).toBeNull();
    expect(resendButton.closest('span[tabindex="0"]')).not.toBeNull();
  });

  it('REGRESSÃO: desabilitado por Telegram não configurado, não tem title= nativo, ganha wrapper focável', async () => {
    isTelegramConfiguredMock.mockReturnValue(false);
    verificationTaskFilterMock.mockResolvedValue([TASK]);
    monitoredAssetListMock.mockResolvedValue([{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }]);
    tradeOperationListMock.mockResolvedValue([]);

    renderPage(<Verification />);

    const resendButton = await screen.findByRole('button', { name: /reenviar/i });
    expect(resendButton.disabled).toBe(true);
    expect(resendButton.getAttribute('title')).toBeNull();
    expect(resendButton.closest('span[tabindex="0"]')).not.toBeNull();
  });

  it('REGRESSÃO: habilitado, não tem title= nativo (Tooltip sem wrapper extra)', async () => {
    verificationTaskFilterMock.mockResolvedValue([TASK]);
    monitoredAssetListMock.mockResolvedValue([{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }]);
    tradeOperationListMock.mockResolvedValue([]);

    renderPage(<Verification />);

    const resendButton = await screen.findByRole('button', { name: /reenviar/i });
    expect(resendButton.disabled).toBe(false);
    expect(resendButton.getAttribute('title')).toBeNull();
  });
});

// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 2ª sub-rodada): o campo "Anotações sobre esta revisão..." e o filtro
// "Buscar símbolo..." usavam `outline-none` sem substituto visível de foco —
// mesmo achado/fix de TriggerBacktestPanel.jsx (1ª sub-rodada).
describe('Verification — campos têm foco visível (achado A-7)', () => {
  it('REGRESSÃO: "Anotações sobre esta revisão..." tem focus-visible:ring', async () => {
    verificationTaskFilterMock.mockResolvedValue([TASK]);
    monitoredAssetListMock.mockResolvedValue([{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }]);
    tradeOperationListMock.mockResolvedValue([]);

    renderPage(<Verification />);

    const notes = await screen.findByPlaceholderText('Anotações sobre esta revisão...');
    expect(notes.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });

  it('REGRESSÃO: filtro "Buscar símbolo..." tem focus-visible:ring', async () => {
    verificationTaskFilterMock.mockResolvedValue([TASK]);
    monitoredAssetListMock.mockResolvedValue([{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }]);
    tradeOperationListMock.mockResolvedValue([]);

    renderPage(<Verification />);

    const search = await screen.findByPlaceholderText('Buscar símbolo...');
    expect(search.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });
});

// Achado M-8 do Raio-X de UI/UX (Média Prioridade): RSI/MACD Hist/EMA
// Curta/EMA Longa no ContextGrid apareciam todos com a mesma cor fixa
// (text-foreground/80), sem indicar sobrecompra/sobrevenda/tendência —
// diferente do padrão já usado no detalhe do ativo (AssetDetailPanel.jsx).
describe('Verification — RSI/MACD/EMA com cor de zona no ContextGrid (achado M-8)', () => {
  const GREEN = 'rgb(0, 255, 128)';
  const RED = 'rgb(255, 20, 120)';

  // Contexto sempre completo (RSI/MACD/EMA juntos, como no dado real) —
  // só o campo sob teste muda de valor entre os casos; assim o rótulo
  // usado pra aguardar o render ("RSI") sempre está presente.
  async function renderWithContext(overrides) {
    const signal_context = { rsi: 50, macd_histogram: 0, ema_short: 100, ema_long: 100, ...overrides };
    verificationTaskFilterMock.mockResolvedValue([{ ...TASK, signal_context }]);
    monitoredAssetListMock.mockResolvedValue([{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }]);
    tradeOperationListMock.mockResolvedValue([]);
    renderPage(<Verification />);
    return screen.findByText('RSI');
  }

  it('REGRESSÃO: RSI overbought (>=70) fica vermelho', async () => {
    await renderWithContext({ rsi: 75 });
    const value = screen.getByText('75.0');
    expect(value.style.color).toBe(RED);
  });

  it('REGRESSÃO: RSI oversold (<=30) fica verde', async () => {
    await renderWithContext({ rsi: 25 });
    const value = screen.getByText('25.0');
    expect(value.style.color).toBe(GREEN);
  });

  it('REGRESSÃO: MACD Hist positivo fica verde, negativo fica vermelho', async () => {
    await renderWithContext({ macd_histogram: 0.5 });
    expect(screen.getByText('0.5000').style.color).toBe(GREEN);
  });

  it('REGRESSÃO: EMA Curta > EMA Longa (bullish) fica verde nas 2 células', async () => {
    await renderWithContext({ ema_short: 105, ema_long: 100 });
    expect(screen.getByText('105.0000').style.color).toBe(GREEN);
    expect(screen.getByText('100.0000').style.color).toBe(GREEN);
  });

  it('EMA Curta < EMA Longa (bearish) fica vermelho nas 2 células', async () => {
    await renderWithContext({ ema_short: 95, ema_long: 100 });
    expect(screen.getByText('95.0000').style.color).toBe(RED);
    expect(screen.getByText('100.0000').style.color).toBe(RED);
  });
});
