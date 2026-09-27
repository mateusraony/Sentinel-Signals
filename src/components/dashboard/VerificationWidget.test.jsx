// @vitest-environment jsdom
//
// Achado A-6 do Raio-X de UI/UX (2ª sub-rodada, Grupo 1): os botões
// ícone-só "Marcar como revisado (OK)"/"Pular" usavam `title=` nativo.
// Migrados pro Tooltip do Radix + `aria-label` (sem o aria-label, os
// botões perderiam o nome acessível por completo ao perder o title=).
// Este componente não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import VerificationWidget from './VerificationWidget.jsx';

const listMock = vi.fn();
const updateMock = vi.fn(async (id, data) => ({ id, ...data }));
vi.mock('@/api/entities', () => ({
  backend: { entities: { VerificationTask: { list: (...args) => listMock(...args), update: (...args) => updateMock(...args) } } },
}));

afterEach(() => {
  cleanup();
  updateMock.mockReset();
  updateMock.mockImplementation(async (id, data) => ({ id, ...data }));
});

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

// Achado da varredura pós-Raio-X (2026-09-27): os botões OK/Pular não davam
// nenhum feedback visual durante a mutação.
describe('VerificationWidget — botões OK/Pular ficam desabilitados durante a mutação (achado pós-Raio-X)', () => {
  it('REGRESSÃO: "OK" e "Pular" ficam disabled enquanto reviewMutation está pendente', async () => {
    listMock.mockResolvedValue([TASK]);
    let resolveUpdate;
    updateMock.mockImplementation(() => new Promise((res) => { resolveUpdate = res; }));
    renderWidget();

    const reviewButton = await screen.findByRole('button', { name: 'Marcar como revisado (OK)' });
    const skipButton = screen.getByRole('button', { name: 'Pular' });
    expect(reviewButton.disabled).toBe(false);

    fireEvent.click(reviewButton);
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    expect(reviewButton.disabled).toBe(true);
    expect(skipButton.disabled).toBe(true);

    resolveUpdate({});
    await waitFor(() => expect(reviewButton.disabled).toBe(false));
  });
});
