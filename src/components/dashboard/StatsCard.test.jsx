// @vitest-environment jsdom
//
// Achado A-6 do Raio-X de UI/UX (7ª sub-rodada): o estado de erro
// (prop `error`) usava title= nativo. Migrado pro Tooltip do Radix
// (TooltipTrigger asChild + tabIndex={0} novo, já que o <p> não é
// focável por padrão). Componente sem teste dedicado antes desta rodada.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import StatsCard from './StatsCard.jsx';

afterEach(cleanup);

function renderCard(props) {
  return render(
    <TooltipProvider>
      <StatsCard label="Ativos monitorados" icon={() => null} {...props} />
    </TooltipProvider>,
  );
}

describe('StatsCard — estado de erro usa Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: o "—" de erro não tem title= nativo, vira gatilho focável', () => {
    renderCard({ error: true });
    const badge = screen.getByText('—').closest('[tabindex="0"]');
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('title')).toBeNull();
  });

  it('sem erro, renderiza o número normal sem o wrapper de Tooltip', () => {
    renderCard({ error: false, value: 42 });
    expect(screen.queryByText('—')).toBeNull();
  });
});
