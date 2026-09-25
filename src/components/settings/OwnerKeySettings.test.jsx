// @vitest-environment jsdom
//
// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 5ª sub-rodada): era um modal caseiro (2 <div> fixos) sem
// role="dialog"/aria-modal, sem focus-trap nem Escape. Migrado pro Dialog do
// Radix (mesmo componente já usado em Trades.jsx, achado A-12). Componente
// não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import OwnerKeySettings from './OwnerKeySettings.jsx';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderModal(props) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <OwnerKeySettings open onClose={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

describe('OwnerKeySettings — modal acessível via Radix Dialog (achado A-7)', () => {
  it('REGRESSÃO: tem role="dialog" (era um <div> fixo sem semântica de modal)', async () => {
    renderModal();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('REGRESSÃO: Escape fecha o modal (focus-trap/Escape vêm de graça do Radix)', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('não renderiza nada quando open=false', () => {
    renderModal({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
