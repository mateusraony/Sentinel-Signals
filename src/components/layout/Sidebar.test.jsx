// @vitest-environment jsdom
//
// Achado A-5 do Raio-X de UI/UX (docs/claude/ui-audit-criticos.md): os 12
// links do DesktopSidebar (ícone-só) não tinham nome acessível — o único
// texto (`item.label`) ficava dentro de um tooltip `opacity-0`, invisível
// pra leitor de tela. Este teste prova o fix: mesmo padrão já usado em
// MobileBottomNav (`aria-label`/`aria-current`), aplicado ao DesktopSidebar.
import React from 'react';
import { describe, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';

vi.mock('@/api/entities', () => ({
  backend: { entities: { SystemLog: { deleteMany: async () => {} } } },
}));

afterEach(() => cleanup());

describe('Sidebar — DesktopSidebar tem nome acessível nos 12 links (achado A-5)', () => {
  it('cada link tem aria-label com o rótulo (mesmo nunca visível como texto)', () => {
    render(
      <MemoryRouter initialEntries={['/trades']}>
        <Sidebar />
      </MemoryRouter>,
    );
    // Cada label aparece 2x no DOM (DesktopSidebar aria-label + MobileBottomNav
    // aria-label) — getAllByRole confirma que o nome acessível existe.
    for (const label of ['Dashboard', 'Trades', 'Histórico', 'Verificação', 'Ativos', 'Alertas', 'Logs', 'Pine Script', 'Backtest', 'Ajustes', 'Revisor', 'Relatório']) {
      const matches = screen.getAllByRole('link', { name: label });
      if (matches.length < 2) throw new Error(`esperava 2 links com nome acessível "${label}" (desktop+mobile), achei ${matches.length}`);
    }
  });

  it('o link da rota ativa tem aria-current="page" no desktop E no mobile (2 instâncias)', () => {
    render(
      <MemoryRouter initialEntries={['/trades']}>
        <Sidebar />
      </MemoryRouter>,
    );
    // MobileBottomNav já tinha aria-current antes deste fix — exigir 2
    // (não só >=1) é o que prova que o DesktopSidebar também ganhou o
    // atributo, não só reencontra o que o mobile já garantia.
    const active = screen.getAllByRole('link', { name: 'Trades', current: 'page' });
    if (active.length !== 2) throw new Error(`esperava 2 links "Trades" com aria-current="page" (desktop+mobile), achei ${active.length}`);
  });
});
