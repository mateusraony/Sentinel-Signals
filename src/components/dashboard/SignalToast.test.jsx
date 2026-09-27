// @vitest-environment jsdom
//
// Achado A-6 do Raio-X de UI/UX (6ª sub-rodada): o badge "Score .../100 ·
// Sinal Confirmado" usava title= nativo. Migrado pro Tooltip do Radix
// (TooltipTrigger asChild + tabIndex={0} novo, já que o <div> não é
// focável por padrão). Componente sem teste dedicado antes desta rodada.
//
// Achado M-5 (Média Prioridade): as animações de entrada e da barra de
// progresso não respeitavam prefers-reduced-motion.
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import SignalToast from './SignalToast.jsx';

function mockMatchMedia(matches) {
  window.matchMedia = (query) => ({
    matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

beforeEach(() => mockMatchMedia(false));
afterEach(cleanup);

function renderToast(signals, { assets, onSelectAsset } = {}) {
  return render(
    <TooltipProvider>
      <SignalToast signals={signals} assets={assets} onSelectAsset={onSelectAsset} />
    </TooltipProvider>,
  );
}

const FRESH_SIGNAL = {
  id: 'sig1', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
  source: 'range_filter', created_date: new Date().toISOString(),
  context: { score: 90 }, asset_id: 'a1',
};

const ASSET_A1 = { id: 'a1', display_name: 'BTC/USDT', symbol: 'BTCUSDT' };

describe('SignalToast — badge de score usa Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: badge "Score .../100" não tem title= nativo, vira gatilho focável', async () => {
    renderToast([FRESH_SIGNAL]);
    const badge = await screen.findByText(/Score 90\/100/);
    expect(badge.getAttribute('title')).toBeNull();
    expect(badge.getAttribute('tabindex')).toBe('0');
  });
});

describe('SignalToast — animações respeitam prefers-reduced-motion (achado M-5)', () => {
  it('REGRESSÃO: a entrada do toast tem motion-reduce:animate-none na className', async () => {
    const { container } = renderToast([FRESH_SIGNAL]);
    await screen.findByText(/Score 90\/100/);
    const toast = container.querySelector('.animate-in');
    expect(toast).not.toBeNull();
    expect(toast.className).toMatch(/motion-reduce:animate-none/);
  });

  it('REGRESSÃO: com prefers-reduced-motion ativo, a barra de progresso não anima', async () => {
    mockMatchMedia(true);
    const { container } = renderToast([FRESH_SIGNAL]);
    await screen.findByText(/Score 90\/100/);
    // A barra é o único filho dentro do wrapper "mt-2 h-0.5..."
    const wrapper = container.querySelector('.mt-2.h-0\\.5');
    const progressBar = wrapper.firstElementChild;
    expect(progressBar.style.animation).toBe('none');
  });

  it('sem prefers-reduced-motion, a barra de progresso anima normalmente', async () => {
    const { container } = renderToast([FRESH_SIGNAL]);
    await screen.findByText(/Score 90\/100/);
    const wrapper = container.querySelector('.mt-2.h-0\\.5');
    const progressBar = wrapper.firstElementChild;
    expect(progressBar.style.animation).toMatch(/shrink-progress/);
  });
});

// Round 5 (última da nova varredura pós-Raio-X): SignalToast não tinha
// nenhuma forma de abrir o AssetDrawer do ativo do sinal — mesma lacuna
// que A-1 já corrigiu em RecentAlertsList. Como o card tem um <button>
// real (dispensar), não recebe role="button" (mesmo raciocínio já
// aplicado, revisão do Codex, em Alerts.jsx: um role de widget na linha
// tornaria o botão filho "presentational" pra árvore de acessibilidade).
describe('SignalToast — clique na linha abre o ativo do sinal (Round 5 pós-Raio-X)', () => {
  it('REGRESSÃO: clique no card chama onSelectAsset com o ativo resolvido', async () => {
    const onSelectAsset = vi.fn();
    const { container } = renderToast([FRESH_SIGNAL], { assets: [ASSET_A1], onSelectAsset });
    await screen.findByText('BTC/USDT');
    const card = container.querySelector('.animate-in');
    fireEvent.click(card);
    expect(onSelectAsset).toHaveBeenCalledTimes(1);
    expect(onSelectAsset).toHaveBeenCalledWith(ASSET_A1);
  });

  it('REGRESSÃO: card não é clicável quando asset_id não resolve nenhum ativo carregado', async () => {
    const onSelectAsset = vi.fn();
    const { container } = renderToast([FRESH_SIGNAL], { assets: [], onSelectAsset });
    await screen.findByText(/Score 90\/100/);
    const card = container.querySelector('.animate-in');
    expect(card.getAttribute('tabindex')).toBeNull();
    fireEvent.click(card);
    expect(onSelectAsset).not.toHaveBeenCalled();
  });

  it('REGRESSÃO: clique no botão de dispensar (X) não abre o ativo (stopPropagation) e ainda dispensa o toast', async () => {
    const onSelectAsset = vi.fn();
    const { container } = renderToast([FRESH_SIGNAL], { assets: [ASSET_A1], onSelectAsset });
    await screen.findByText('BTC/USDT');
    const dismissButton = screen.getByRole('button');
    fireEvent.click(dismissButton);
    expect(onSelectAsset).not.toHaveBeenCalled();
    expect(container.querySelector('.animate-in')).toBeNull();
  });

  it('Enter no card focado abre o ativo; Enter borbulhando do botão de dispensar não dispara 2x', async () => {
    const onSelectAsset = vi.fn();
    const { container } = renderToast([FRESH_SIGNAL], { assets: [ASSET_A1], onSelectAsset });
    await screen.findByText('BTC/USDT');
    const card = container.querySelector('.animate-in');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onSelectAsset).toHaveBeenCalledTimes(1);

    const dismissButton = screen.getByRole('button');
    fireEvent.keyDown(dismissButton, { key: 'Enter', bubbles: true });
    expect(onSelectAsset).toHaveBeenCalledTimes(1);
  });
});

describe('SignalToast — posição não sobrepõe o TopBar (Round 5 pós-Raio-X)', () => {
  it('REGRESSÃO: o wrapper fixo usa top-24 (não mais top-4), preservando right-4/z-[9999]', async () => {
    const { container } = renderToast([FRESH_SIGNAL], { assets: [ASSET_A1] });
    await screen.findByText('BTC/USDT');
    const wrapper = container.querySelector('.fixed');
    expect(wrapper.className).toMatch(/\btop-24\b/);
    expect(wrapper.className).not.toMatch(/\btop-4\b/);
    expect(wrapper.className).toMatch(/\bright-4\b/);
    expect(wrapper.className).toMatch(/z-\[9999\]/);
  });
});
