// @vitest-environment jsdom
//
// Achado A-6 do Raio-X de UI/UX (4ª sub-rodada): CandleBoundTag/DetectionLag
// usavam title= nativo — tooltip feio do navegador, não acionável por
// teclado. Migrados pro Tooltip do Radix (TooltipTrigger asChild + span
// tabIndex={0}, já que nenhum dos dois é focável por padrão). Componente
// compartilhado (Trades.jsx via TradeCard.jsx, TradeHistory.jsx) sem teste
// dedicado antes desta rodada.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CandleBoundTag, DetectionLag } from './EventTimeline.jsx';

afterEach(cleanup);

function renderWithTooltip(ui) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('CandleBoundTag — usa Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: "(vela)" não tem title= nativo, vira gatilho focável', () => {
    renderWithTooltip(<CandleBoundTag />);
    const tag = screen.getByText(/\(vela\)/);
    expect(tag.getAttribute('title')).toBeNull();
    expect(tag.getAttribute('tabindex')).toBe('0');
  });
});

describe('DetectionLag — usa Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: "(detectado ... depois)" não tem title= nativo, vira gatilho focável', () => {
    const realTime = '2026-09-01T00:00:00.000Z';
    const detectedAt = '2026-09-01T02:00:00.000Z'; // 2h de gap, acima do LAG_THRESHOLD_MS (20min)
    renderWithTooltip(<DetectionLag realTime={realTime} detectedAt={detectedAt} />);
    const tag = screen.getByText(/detectado 2\.0h depois/);
    expect(tag.getAttribute('title')).toBeNull();
    expect(tag.getAttribute('tabindex')).toBe('0');
  });

  it('gap abaixo do threshold continua não renderizando nada (gate pré-existente, não afetado pela migração)', () => {
    const realTime = '2026-09-01T00:00:00.000Z';
    const detectedAt = '2026-09-01T00:05:00.000Z'; // 5min de gap, abaixo do threshold
    const { container } = renderWithTooltip(<DetectionLag realTime={realTime} detectedAt={detectedAt} />);
    expect(container.textContent).toBe('');
  });
});
