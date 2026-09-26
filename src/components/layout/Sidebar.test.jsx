// @vitest-environment jsdom
//
// Achado A-5 do Raio-X de UI/UX (docs/claude/ui-audit-criticos.md): os 12
// links do DesktopSidebar (ícone-só) não tinham nome acessível — o único
// texto (`item.label`) ficava dentro de um tooltip `opacity-0`, invisível
// pra leitor de tela. Este teste prova o fix: mesmo padrão já usado em
// MobileBottomNav (`aria-label`/`aria-current`), aplicado ao DesktopSidebar.
//
// Achado M-10 (docs/known-risks.md item 236/237): a barra mobile tinha os
// mesmos 12 itens numa barra de 64px sem padding — ~32,5px de alvo de
// toque em telas de ~390px. Só 5 continuam como link direto na barra
// (CORE_LABELS); os outros 7 foram pro menu "Mais" (MORE_LABELS), então
// os testes de A-5 acima só cobrem os 5 CORE agora — os 7 MORE têm
// describe próprio abaixo.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';

vi.mock('@/api/entities', () => ({
  backend: { entities: { SystemLog: { deleteMany: async () => {} } } },
}));

// Achado do Codex review no PR #436: MobileBottomNav passou a chamar
// `window.matchMedia` (pra fechar o sheet "Mais" ao cruzar o breakpoint
// desktop) — jsdom não implementa matchMedia por padrão, então todo teste
// deste arquivo precisa do mock, não só o que testa esse comportamento
// específico. `mediaQueryList` fica acessível pros testes que precisam
// simular a mudança de breakpoint.
let mediaQueryList;
beforeEach(() => {
  mediaQueryList = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  window.matchMedia = vi.fn(() => mediaQueryList);
});
afterEach(() => cleanup());

const CORE_LABELS = ['Dashboard', 'Trades', 'Ativos', 'Alertas', 'Histórico'];
const MORE_LABELS = ['Verificação', 'Logs', 'Pine Script', 'Backtest', 'Ajustes', 'Revisor', 'Relatório'];

describe('Sidebar — DesktopSidebar tem nome acessível nos 12 links (achado A-5)', () => {
  it('cada link CORE tem aria-label com o rótulo, em 2 instâncias (desktop+mobile)', () => {
    render(
      <MemoryRouter initialEntries={['/trades']}>
        <Sidebar />
      </MemoryRouter>,
    );
    // Cada label CORE aparece 2x no DOM (DesktopSidebar aria-label +
    // MobileBottomNav aria-label) — getAllByRole confirma que o nome
    // acessível existe. Os itens que foram pro menu "Mais" (achado M-10)
    // têm cobertura própria abaixo, porque hoje só têm 1 instância
    // (desktop) enquanto o sheet estiver fechado.
    for (const label of CORE_LABELS) {
      const matches = screen.getAllByRole('link', { name: label });
      if (matches.length < 2) throw new Error(`esperava 2 links com nome acessível "${label}" (desktop+mobile), achei ${matches.length}`);
    }
  });

  it('o link CORE da rota ativa tem aria-current="page" no desktop E no mobile (2 instâncias)', () => {
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

// Achado M-10 do Raio-X de UI/UX: os 12 itens numa barra mobile de 64px
// davam ~32,5px de alvo de toque em telas de ~390px. Só os 5 labels CORE
// (acima) continuam como link direto na barra mobile — os outros 7 vão
// pro botão "Mais" (bottom sheet, mesmo padrão Sheet já usado no
// AssetDrawer.jsx), o que dobra o alvo de toque pra ~65px.
describe('Sidebar — menu "Mais" na nav mobile (achado M-10)', () => {
  it('REGRESSÃO: os 7 labels secundários têm só 1 instância (desktop) com o sheet fechado', () => {
    render(
      <MemoryRouter initialEntries={['/trades']}>
        <Sidebar />
      </MemoryRouter>,
    );
    for (const label of MORE_LABELS) {
      const matches = screen.getAllByRole('link', { name: label });
      if (matches.length !== 1) throw new Error(`esperava 1 link (só desktop) com nome acessível "${label}" com o sheet fechado, achei ${matches.length}`);
    }
  });

  it('o botão "Mais" tem nome acessível próprio', () => {
    render(
      <MemoryRouter initialEntries={['/trades']}>
        <Sidebar />
      </MemoryRouter>,
    );
    screen.getByRole('button', { name: 'Mais opções de navegação' });
  });

  it('REGRESSÃO: clicar em "Mais" abre um dialog com os 7 labels secundários como link', () => {
    render(
      <MemoryRouter initialEntries={['/trades']}>
        <Sidebar />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mais opções de navegação' }));
    // O Sheet (Radix Dialog) marca o resto da árvore como aria-hidden
    // enquanto aberto (trap de foco padrão) — por isso a asserção correta
    // é "existe dentro do dialog" via `within`, não contar instâncias no
    // documento inteiro (o link do desktop fica temporariamente inacessível
    // pra leitor de tela, por design, enquanto o sheet estiver aberto).
    const dialog = screen.getByRole('dialog');
    for (const label of MORE_LABELS) {
      within(dialog).getByRole('link', { name: label });
    }
  });

  it('clicar num link secundário dentro do sheet aberto fecha o sheet', () => {
    render(
      <MemoryRouter initialEntries={['/trades']}>
        <Sidebar />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mais opções de navegação' }));
    const dialog = screen.getByRole('dialog');
    const link = within(dialog).getByRole('link', { name: 'Ajustes' });
    fireEvent.click(link);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('REGRESSÃO: rota secundária ativa tem aria-current="page" só no desktop (1 instância) com o sheet fechado', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Sidebar />
      </MemoryRouter>,
    );
    const active = screen.getAllByRole('link', { name: 'Ajustes', current: 'page' });
    if (active.length !== 1) throw new Error(`esperava 1 link "Ajustes" com aria-current="page" (só desktop, sheet fechado), achei ${active.length}`);
  });

  // Achado do Codex review no PR #436: em rota secundária, o desktop
  // sidebar fica `hidden` (invisível/inacessível) em viewport mobile — o
  // botão "Mais" é o único controle de navegação visível representando a
  // seção atual, mas não tinha nenhuma indicação de estado ativo pra
  // leitor de tela (só cor do ícone). Corrigido com aria-current="page" no
  // próprio botão quando um item secundário está ativo.
  it('REGRESSÃO: botão "Mais" tem aria-current="page" quando a rota ativa é secundária', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Sidebar />
      </MemoryRouter>,
    );
    const button = screen.getByRole('button', { name: 'Mais opções de navegação' });
    expect(button.getAttribute('aria-current')).toBe('page');
  });

  it('botão "Mais" NÃO tem aria-current quando a rota ativa é core', () => {
    render(
      <MemoryRouter initialEntries={['/trades']}>
        <Sidebar />
      </MemoryRouter>,
    );
    const button = screen.getByRole('button', { name: 'Mais opções de navegação' });
    expect(button.getAttribute('aria-current')).toBeNull();
  });

  // Achado do Codex review no PR #436: nada fechava o sheet "Mais" se a
  // viewport cruzasse o breakpoint desktop (768px) enquanto ele estava
  // aberto (ex.: rotação de tela) — o overlay full-screen do Radix ficava
  // preso, com a UI desktop inerte atrás dele e sem controles visíveis
  // (só o conteúdo do sheet tinha `md:hidden`, não o overlay). Corrigido
  // fechando o sheet via listener de `matchMedia('(min-width: 768px)')`.
  it('REGRESSÃO: sheet "Mais" fecha automaticamente ao cruzar o breakpoint desktop', () => {
    render(
      <MemoryRouter initialEntries={['/trades']}>
        <Sidebar />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mais opções de navegação' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    expect(mediaQueryList.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    const handleChange = mediaQueryList.addEventListener.mock.calls[0][1];
    mediaQueryList.matches = true;
    act(() => handleChange());

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
