/**
 * @vitest-environment jsdom
 *
 * Barra "Atualizado às … · ao vivo" (docs/known-risks.md item 301): SEMPRE visível, diz quando a tela atualizou e em que modo o painel está; o botão
 * "Manter ao vivo" segura o painel acordado por tempo limitado.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import LiveStatusBar from './LiveStatusBar';
import { stopIdleRest } from '@/lib/idleRest';

const MIN = 60_000;

function montar(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })) {
  const tela = render(<QueryClientProvider client={client}><LiveStatusBar /></QueryClientProvider>);
  return { client, ...tela };
}
const barra = () => document.querySelector('[data-live-status]');
const horaDe = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

describe('LiveStatusBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T16:00:00Z'));
    focusManager.setFocused(undefined);
  });
  afterEach(() => {
    cleanup();
    stopIdleRest();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('SEMPRE aparece, também no estado normal (ao vivo)', () => {
    montar();
    expect(barra()).not.toBeNull();
    expect(barra().getAttribute('data-mode')).toBe('active');
    expect(barra().textContent).toMatch(/ao vivo/);
  });

  it('sem dado ainda: "Aguardando dados" (não inventa horário)', () => {
    montar();
    expect(barra().textContent).toMatch(/Aguardando dados/);
  });

  it('mostra o horário real da última atualização, com segundos', async () => {
    const { client } = montar();
    await act(async () => { await client.fetchQuery({ queryKey: ['x'], queryFn: async () => 1 }); });
    expect(barra().querySelector('[data-last-update]').textContent).toBe(`Atualizado às ${horaDe(Date.now())}`);
  });

  it('o horário acompanha a próxima atualização', async () => {
    const { client } = montar();
    await act(async () => { await client.fetchQuery({ queryKey: ['x'], queryFn: async () => 1 }); });
    const primeira = barra().querySelector('[data-last-update]').textContent;
    await act(async () => { await vi.advanceTimersByTimeAsync(7 * MIN); });
    await act(async () => { await client.refetchQueries({ queryKey: ['x'] }); });
    expect(barra().querySelector('[data-last-update]').textContent).not.toBe(primeira);
    expect(barra().querySelector('[data-last-update]').textContent).toBe(`Atualizado às ${horaDe(Date.now())}`);
  });

  it('em repouso o horário CONTINUA visível (é o "último horário") e o texto diz que atualiza a cada 30 min, sem dizer "parado"', async () => {
    const { client } = montar();
    await act(async () => { await client.fetchQuery({ queryKey: ['x'], queryFn: async () => 1 }); });
    const horario = barra().querySelector('[data-last-update]').textContent;
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * MIN); });
    expect(barra().getAttribute('data-mode')).toBe('rest');
    expect(barra().querySelector('[data-last-update]').textContent).toBe(horario); // o último horário NÃO some nem muda em repouso
    expect(barra().textContent).toMatch(/em repouso/);
    expect(barra().textContent).toMatch(/30 min/);
    expect(barra().textContent).not.toMatch(/parad|congelad|pausad/i);
  });

  it('em repouso, atividade volta ao modo normal na hora', async () => {
    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * MIN); });
    act(() => { window.dispatchEvent(new Event('mousemove')); });
    expect(barra().getAttribute('data-mode')).toBe('active');
  });

  it('"Manter ao vivo": vira modo ao vivo com o horário final e some o botão', async () => {
    montar();
    fireEvent.click(screen.getByRole('button', { name: /Manter ao vivo/i }));
    expect(barra().getAttribute('data-mode')).toBe('live');
    expect(barra().textContent).toMatch(/ao vivo até \d{2}:\d{2}/);
    expect(screen.queryByRole('button', { name: /Manter ao vivo/i })).toBeNull();
  });

  it('ao vivo o painel NÃO entra em repouso com 30 min sem mexer, e depois do prazo (60 min) entra', async () => {
    montar();
    fireEvent.click(screen.getByRole('button', { name: /Manter ao vivo/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * MIN); });
    expect(barra().getAttribute('data-mode')).toBe('live');
    await act(async () => { await vi.advanceTimersByTimeAsync(31 * MIN); });
    expect(barra().getAttribute('data-mode')).toBe('rest');
    expect(screen.getByRole('button', { name: /Manter ao vivo/i })).toBeTruthy(); // volta o botão
  });

  it('em repouso o botão "Manter ao vivo" existe e leva ao modo ao vivo', async () => {
    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * MIN); });
    fireEvent.click(screen.getByRole('button', { name: /Manter ao vivo/i }));
    expect(barra().getAttribute('data-mode')).toBe('live');
  });

  it('o botão é um <button type="button"> com nome acessível e explica a duração', () => {
    montar();
    const b = screen.getByRole('button', { name: /Manter ao vivo/i });
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('type')).toBe('button');
    expect(b.getAttribute('title')).toMatch(/60 min/);
    expect(b.getAttribute('aria-label')).toBe('Manter ao vivo'); // o rótulo curto do celular ("Ao vivo") não muda o nome acessível
  });

  it('o ícone é decorativo e não há emoji no DOM', async () => {
    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * MIN); });
    const svg = barra().querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(barra().textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('não é região viva (anunciaria o horário a cada atualização)', () => {
    montar();
    expect(barra().getAttribute('role')).toBeNull();
    expect(barra().getAttribute('aria-live')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ALTURA FIXA e sem quebra de linha: trocar de modo só troca o texto (senão o scroll anchoring acorda o painel)', () => {
    montar();
    const c = barra().className;
    expect(c).toMatch(/\bh-8\b/);
    expect(c).toMatch(/\bwhitespace-nowrap\b/);
    expect(c).toMatch(/\boverflow-hidden\b/);
    expect(c).not.toMatch(/\b(min-h-|h-auto|flex-wrap)\b/);
  });

  it('a barra fica grudada abaixo do TopBar (sticky top-14), para o horário estar sempre à vista', () => {
    montar();
    expect(barra().className).toMatch(/\bsticky\b/);
    expect(barra().className).toMatch(/\btop-14\b/);
  });
});

describe('trava: a barra está montada no layout do painel', () => {
  it('AppLayout renderiza <LiveStatusBar /> logo depois do <TopBar /> (sem isso o repouso não começa nunca)', () => {
    const layout = readFileSync(join(process.cwd(), 'src/components/layout/AppLayout.jsx'), 'utf8');
    expect(layout).toMatch(/import LiveStatusBar from '\.\/LiveStatusBar'/);
    expect(layout).toMatch(/<TopBar \/>\s*<LiveStatusBar \/>/);
    expect(layout).not.toMatch(/IdleRestBanner/);
  });
});
