// @vitest-environment jsdom
//
// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 5ª sub-rodada): era um modal caseiro (2 <div> fixos) sem
// role="dialog"/aria-modal, sem focus-trap nem Escape. Migrado pro Dialog do
// Radix (mesmo componente já usado em Trades.jsx, achado A-12) — o corpo
// (instruções + campos + filtros avançados) ganhou um wrapper
// max-h-[70vh]/overflow-y-auto interno (mesmo padrão de
// AssetConfigPanel.jsx), já que com os filtros avançados abertos o conteúdo
// facilmente passa da altura da viewport e o DialogContent do Radix não
// trata isso sozinho. Componente não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import TelegramSettings from './TelegramSettings.jsx';

// telegram.js importa @/lib/firebaseClient de forma transitiva (usado só
// pelas funções notify*/setTelegramFilters, não exercitadas aqui) — sem o
// mock, initializeAuth quebra em ambiente de teste por falta de config real.
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderModal(props) {
  return render(<TelegramSettings open onClose={vi.fn()} {...props} />);
}

describe('TelegramSettings — modal acessível via Radix Dialog (achado A-7)', () => {
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

  it('REGRESSÃO: "Filtros Avançados" expandido ainda deixa o corpo dentro de um wrapper rolável', async () => {
    renderModal();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByText(/Filtros Avançados de Notificação/));
    await screen.findByText(/TIMEFRAMES A MONITORAR/);
    const scrollArea = screen.getByText(/TIMEFRAMES A MONITORAR/).closest('.overflow-y-auto');
    expect(scrollArea).not.toBeNull();
  });
});
