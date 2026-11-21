// @vitest-environment jsdom
//
// Resumo do Dashboard (21/11/2026): blocos de tamanhos diferentes que dizem QUAIS ativos, não só quantos.
// A regra mais importante: os NÚMEROS vêm das contagens de sempre (por id de ativo), passadas de fora — os
// nomes são só para exibir. Um sinal de um ativo fora da lista não pode mudar a contagem (achado do item 256).
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import SummaryTiles from './SummaryTiles.jsx';

afterEach(cleanup);

const renderTiles = (props = {}) =>
  render(<TooltipProvider><SummaryTiles buy={0} sell={0} assetsOk={[]} {...props} /></TooltipProvider>);

const num = (id) => screen.getByTestId(id);

describe('SummaryTiles — números e nomes', () => {
  it('mostra as contagens recebidas e os nomes dos ativos (sem o USDT)', async () => {
    renderTiles({
      opsCount: 2, ops: [{ id: 'o1', symbol: 'BTCUSDT', side: 'BUY', status: 'RUNNER_ACTIVE' }, { id: 'o2', symbol: 'ETHUSDT', side: 'SELL', status: 'SIGNAL_CONFIRMED' }],
      highPriorityCount: 1, highPriority: ['BTCUSDT'], waitingCount: 2, waiting: ['SOLUSDT', 'LINKUSDT'],
      buy: 3, sell: 1, assetsOk: [true, true, true],
    });
    // o número anima ~0,7 s até o valor final — espera cada um
    await waitFor(() => expect(num('resumo-ops').textContent).toBe('2'));
    await waitFor(() => expect(num('resumo-alta').textContent).toBe('1'));
    await waitFor(() => expect(num('resumo-aguardando').textContent).toBe('2'));
    await waitFor(() => expect(num('resumo-monitorados').textContent).toBe('3'));
    // BTC aparece nos dois blocos em que entra: operações ativas e alta prioridade
    expect(screen.getAllByText('BTC').length).toBe(2);
    expect(screen.getByText(/Compra · runner ativo/)).toBeTruthy();
    expect(screen.getByText(/Venda · ativa/)).toBeTruthy();
    expect(screen.getByText('SOL, LINK')).toBeTruthy();
  });

  it('REGRESSÃO (item 256): a contagem NÃO depende dos nomes — contagem 1 sem nome conhecido continua 1', async () => {
    renderTiles({ highPriorityCount: 1, highPriority: [], waitingCount: 3, waiting: [] });
    await waitFor(() => expect(num('resumo-alta').textContent).toBe('1'));
    await waitFor(() => expect(num('resumo-aguardando').textContent).toBe('3'));
    // sem nome para mostrar, diz quantos são em vez de ficar em branco
    expect(screen.getByText('1 ativo(s)')).toBeTruthy();
    expect(screen.getByText('3 ativo(s)')).toBeTruthy();
  });

  it('"Alta prioridade" fica na cor de atenção só quando há algum; com 0 fica neutro (achado M-16)', async () => {
    const { unmount } = renderTiles({ highPriorityCount: 0 });
    await waitFor(() => expect(num('resumo-alta').textContent).toBe('0'));
    expect(num('resumo-alta').style.color).not.toBe('rgb(221, 154, 74)');
    expect(screen.getByText('Nenhuma agora')).toBeTruthy();
    unmount();
    renderTiles({ highPriorityCount: 2, highPriority: ['BTCUSDT', 'ETHUSDT'] });
    await waitFor(() => expect(num('resumo-alta').style.color).toBe('rgb(221, 154, 74)'));
  });

  it('sem operações abertas diz isso em vez de ficar vazio', () => {
    renderTiles({ opsCount: 0, ops: [] });
    expect(screen.getByText('Nenhuma operação aberta.')).toBeTruthy();
  });
});

describe('SummaryTiles — falha de leitura (fail-closed, itens 193–196)', () => {
  it('com erro, o número vira "—" (nunca um falso 0) e a dica explica', async () => {
    renderTiles({ opsCount: 0, highPriorityCount: 0, waitingCount: 0, errors: { ops: true, signals: true } });
    expect(num('resumo-ops').textContent).toBe('—');
    expect(num('resumo-alta').textContent).toBe('—');
    expect(num('resumo-aguardando').textContent).toBe('—');
  });

  it('erro de ativos deixa "Monitorados" em "—" e não afeta os outros', async () => {
    renderTiles({ opsCount: 1, ops: [{ id: 'o1', symbol: 'BTCUSDT', side: 'BUY', status: 'SIGNAL_CONFIRMED' }], errors: { assets: true } });
    expect(num('resumo-monitorados').textContent).toBe('—');
    await waitFor(() => expect(num('resumo-ops').textContent).toBe('1'));
  });
});

describe('SummaryTiles — sinais e saúde dos dados', () => {
  it('a barra de sinais é proporcional (3 compras e 1 venda = 75% / 25%)', () => {
    renderTiles({ buy: 3, sell: 1 });
    const bar = screen.getByLabelText('3 de compra e 1 de venda');
    const [compra, venda] = bar.children;
    expect(parseFloat(compra.style.width)).toBeCloseTo(75, 5);
    expect(parseFloat(venda.style.width)).toBeCloseTo(25, 5);
  });

  it('sem sinais a barra fica vazia (sem divisão por zero)', () => {
    renderTiles({ buy: 0, sell: 0 });
    const bar = screen.getByLabelText('0 de compra e 0 de venda');
    expect(bar.children.length).toBe(0);
  });

  it('"Monitorados" mostra um ponto por ativo e "em dia" só quando todos estão em dia', () => {
    const { unmount } = renderTiles({ assetsOk: [true, true] });
    expect(screen.getByLabelText('2 de 2 com dados em dia')).toBeTruthy();
    expect(screen.getByText('em dia')).toBeTruthy();
    unmount();
    renderTiles({ assetsOk: [true, false, true] });
    expect(screen.getByLabelText('2 de 3 com dados em dia')).toBeTruthy();
    expect(screen.getByText('2 em dia')).toBeTruthy();
  });
});
