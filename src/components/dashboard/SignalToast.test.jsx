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
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import SignalToast from './SignalToast.jsx';

function mockMatchMedia(matches) {
  window.matchMedia = (query) => ({
    matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

beforeEach(() => mockMatchMedia(false));
afterEach(cleanup);

function renderToast(signals) {
  return render(
    <TooltipProvider>
      <SignalToast signals={signals} />
    </TooltipProvider>,
  );
}

const FRESH_SIGNAL = {
  id: 'sig1', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
  source: 'range_filter', created_date: new Date().toISOString(),
  context: { score: 90 },
};

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
