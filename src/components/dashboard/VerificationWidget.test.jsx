// @vitest-environment jsdom
//
// Achado A-6 do Raio-X de UI/UX (2ª sub-rodada, Grupo 1): os botões
// ícone-só "Marcar como revisado (OK)"/"Pular" usavam `title=` nativo.
// Migrados pro Tooltip do Radix + `aria-label` (sem o aria-label, os
// botões perderiam o nome acessível por completo ao perder o title=).
// Este componente não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import VerificationWidget from './VerificationWidget.jsx';

const listMock = vi.fn();
vi.mock('@/api/entities', () => ({
  backend: { entities: { VerificationTask: { list: (...args) => listMock(...args) } } },
}));

afterEach(cleanup);

function renderWidget() {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>
          <VerificationWidget />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const TASK = {
  id: 'v1', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h',
  signal_type: 'BUY', status: 'pending', created_date: new Date().toISOString(),
};

describe('VerificationWidget — botões de ação usam Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: "Marcar como revisado"/"Pular" não têm title= nativo, mantêm nome acessível', async () => {
    listMock.mockResolvedValue([TASK]);
    renderWidget();

    const reviewButton = await screen.findByRole('button', { name: 'Marcar como revisado (OK)' });
    const skipButton = screen.getByRole('button', { name: 'Pular' });
    expect(reviewButton.getAttribute('title')).toBeNull();
    expect(skipButton.getAttribute('title')).toBeNull();
  });
});
