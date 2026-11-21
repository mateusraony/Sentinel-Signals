// @vitest-environment jsdom
//
// Comparar ativos (21/11/2026): a comparação abre como GAVETA lateral por cima da página (mesmo padrão do painel do
// ativo), em vez de um bloco no meio do Dashboard que obrigava a rolar até o fim. A lógica de comparação é a de sempre
// (ComparePanel); aqui se prova a gaveta: abre/fecha, escolha dos dois ativos, estados vazios e quais sinais/operações
// entram na conta (só Range Filter e só operação ativa).
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import CompareDrawer from './CompareDrawer.jsx';

vi.mock('@/lib/marketDataProvider', () => ({ fetch24hStats: async () => null }));
afterEach(cleanup);

const BTC = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' };
const ETH = { id: 'a2', symbol: 'ETHUSDT', display_name: 'ETH/USDT' };
const SOL = { id: 'a3', symbol: 'SOLUSDT', display_name: 'SOL/USDT' };
const state = (asset_id, extra = {}) => ({ asset_id, timeframe: '1h', rf_direction: 1, rsi_value: 55, rsi_zone: 'neutral', macd_histogram: 0.5, trend_ema: 'bullish', last_close: 100, ...extra });
const rfSignal = (asset_id, extra = {}) => ({ id: `s-${asset_id}`, asset_id, source: 'range_filter', signal_type: 'BUY', ...extra });

function renderDrawer(props = {}) {
  const handlers = { onClose: vi.fn(), onChangeA: vi.fn(), onChangeB: vi.fn() };
  const view = render(
    <QueryClientProvider client={makeTestQueryClient()}>
      <TooltipProvider>
        <CompareDrawer open assets={[BTC, ETH, SOL]} aId="a1" bId="a2" states={[state('a1'), state('a2')]} {...handlers} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, ...handlers };
}

describe('CompareDrawer — abre como gaveta, fecha com Esc', () => {
  it('fechada não monta nada na página', () => {
    renderDrawer({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('aberta mostra o título, a descrição e os dois seletores já preenchidos', () => {
    renderDrawer();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Comparar ativos')).toBeTruthy();
    expect(within(dialog).getByText(/Lado a lado: tendência, indicadores e oportunidade/)).toBeTruthy();
    expect(within(dialog).getByLabelText('Ativo A').value).toBe('a1');
    expect(within(dialog).getByLabelText('Ativo B').value).toBe('a2');
  });

  it('Esc fecha (chama onClose)', () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CompareDrawer — escolha dos ativos', () => {
  it('trocar um seletor avisa com o id escolhido, sem mexer no outro', () => {
    const { onChangeA, onChangeB } = renderDrawer();
    fireEvent.change(screen.getByLabelText('Ativo A'), { target: { value: 'a3' } });
    expect(onChangeA).toHaveBeenCalledWith('a3');
    expect(onChangeB).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Ativo B'), { target: { value: 'a1' } });
    expect(onChangeB).toHaveBeenCalledWith('a1');
  });

  it('com os dois ativos escolhidos mostra a comparação (uma coluna por ativo)', () => {
    renderDrawer();
    expect(screen.getByText('Oportunidade 0 × 0', { exact: false })).toBeTruthy();
    expect(screen.getAllByText('BTC/USDT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ETH/USDT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Indicadores')).toHaveLength(2);
  });

  it('sem os dois escolhidos pede para escolher, em vez de ficar vazia', () => {
    renderDrawer({ aId: 'a1', bId: null });
    expect(screen.getByText('Escolha os dois ativos para ver a comparação.')).toBeTruthy();
    expect(screen.queryByText('Indicadores')).toBeNull();
  });

  it('com menos de 2 ativos monitorados explica o que falta (e não mostra seletores)', () => {
    renderDrawer({ assets: [BTC], aId: null, bId: null });
    expect(screen.getByText('Monitore pelo menos 2 ativos para poder comparar.')).toBeTruthy();
    expect(screen.queryByLabelText('Ativo A')).toBeNull();
  });
});

describe('CompareDrawer — o que entra na conta', () => {
  it('quem tem sinal do Range Filter ganha o veredito "Melhor oportunidade agora"', () => {
    renderDrawer({ signals: [rfSignal('a2')] });
    const verdict = screen.getByText('Melhor oportunidade agora').parentElement;
    expect(within(verdict).getByText('ETH/USDT')).toBeTruthy();
    expect(screen.getAllByText('Melhor')).toHaveLength(1); // só a coluna do ETH ganha o selo
  });

  it('sinal de OUTRA fonte (macd/ema) não conta — vira empate', () => {
    renderDrawer({ signals: [rfSignal('a2', { source: 'macd' })] });
    expect(screen.getByText('Empate nas regras atuais')).toBeTruthy();
  });

  it('operação ATIVA reduz a oportunidade; operação já encerrada não conta', () => {
    const ativa = { id: 'o1', asset_id: 'a1', status: 'RUNNER_ACTIVE', side: 'BUY' };
    const { unmount } = renderDrawer({ signals: [rfSignal('a1'), rfSignal('a2')], ops: [ativa] });
    // A está em operação (−15) e B está livre (+10 "pronto para entrada"): B vence
    expect(within(screen.getByText('Melhor oportunidade agora').parentElement).getByText('ETH/USDT')).toBeTruthy();
    unmount();
    const encerrada = { ...ativa, status: 'STOP_HIT' };
    renderDrawer({ signals: [rfSignal('a1'), rfSignal('a2')], ops: [encerrada] });
    expect(screen.getByText('Empate nas regras atuais')).toBeTruthy();
  });
});
