// @vitest-environment jsdom
//
// Item 277 (PR-B): chip de saúde global no lugar do "Dados em tempo real" fixo
// (Dashboard) e do ponto verde pulsando sempre (Sidebar).
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import DataHealthChip from './DataHealthChip.jsx';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const NOW = Date.parse('2026-10-17T12:00:00Z');
const minAgo = (m) => new Date(NOW - m * 60000).toISOString();

describe('DataHealthChip', () => {
  it('mostra último scan e problemas com dados reais', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    render(<DataHealthChip assets={[{ is_active: true, last_scan_at: minAgo(4) }, { is_active: true }]} />);
    expect(screen.getByText('📡 Último scan há 4 min · 1 ativo com problema')).toBeTruthy();
    expect(screen.queryByText(/tempo real/i)).toBeNull();
  });

  it('carregando e erro são fail-closed', () => {
    const { rerender } = render(<DataHealthChip assets={[]} isLoading />);
    expect(screen.getByText('📡 Verificando…')).toBeTruthy();
    rerender(<DataHealthChip assets={[{ is_active: true, last_scan_at: new Date().toISOString() }]} isError />);
    expect(screen.getByText('📡 Saúde indisponível')).toBeTruthy();
  });

  it('o relógio próprio envelhece o texto sem nova prop', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    render(<DataHealthChip assets={[{ is_active: true, last_scan_at: minAgo(1) }]} />);
    expect(screen.getByText('📡 Último scan há 1 min · tudo em dia')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(70 * 60000); });
    // 71 min: o `formatAge` passa a mostrar horas a partir de 60 min.
    expect(screen.getByText('📡 Último scan há 1 h · 1 ativo com problema')).toBeTruthy();
  });

  it('variante "dot": só o ponto, com nome acessível e sem animação', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const { container } = render(<DataHealthChip variant="dot" assets={[{ is_active: true, last_scan_at: minAgo(2) }]} />);
    expect(screen.getByRole('img', { name: '📡 Último scan há 2 min · tudo em dia' })).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/ping|animation/);
  });
});
