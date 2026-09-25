// @vitest-environment jsdom
//
// Achado A-6 do Raio-X de UI/UX (6ª sub-rodada): o badge "Score .../100 ·
// Sinal Confirmado" usava title= nativo. Migrado pro Tooltip do Radix
// (TooltipTrigger asChild + tabIndex={0} novo, já que o <div> não é
// focável por padrão). Componente sem teste dedicado antes desta rodada.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import SignalToast from './SignalToast.jsx';

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
