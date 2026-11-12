/**
 * @vitest-environment jsdom
 *
 * Faixa "Painel em repouso" (docs/known-risks.md item 301). Aparece só em repouso, diz em palavras simples o que pausou e como voltar, e some na primeira
 * atividade ou no botão. É o que impede alguém de achar que uma tela parada num segundo monitor continua ao vivo.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import IdleRestBanner from './IdleRestBanner';
import { stopIdleRest } from '@/lib/idleRest';

const MIN = 60_000;

function montar() {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}><IdleRestBanner /></QueryClientProvider>);
}

describe('IdleRestBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    focusManager.setFocused(undefined);
  });
  afterEach(() => {
    cleanup();
    stopIdleRest();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('ativo: não mostra nada', () => {
    const { container } = montar();
    expect(container.childElementCount).toBe(0);
  });

  it('em repouso: avisa com role="status" e diz o que pausou e como voltar', async () => {
    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * MIN); });
    const faixa = screen.getByRole('status');
    expect(faixa.textContent).toMatch(/Painel em repouso/i);
    expect(faixa.textContent).toMatch(/20 min/);
    expect(faixa.textContent).toMatch(/pausar|pausou|pausaram/i);
    expect(faixa.textContent).toMatch(/stop/i);
    expect(faixa.textContent).toMatch(/GitHub/);
    expect(faixa.textContent).toMatch(/mexa o mouse|toque|tecla/i);
    expect(faixa.getAttribute('aria-live')).toBe('polite');
  });

  it('não promete o que não é verdade: não diz que a tela está ao vivo nem fala em banco "sem cota"', async () => {
    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * MIN); });
    const texto = screen.getByRole('status').textContent;
    expect(texto).not.toMatch(/ao vivo e atualizad|sem cota|esgotad/i);
  });

  it('o botão "Retomar agora" acorda e a faixa some', async () => {
    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * MIN); });
    fireEvent.click(screen.getByRole('button', { name: /Retomar agora/i }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('qualquer atividade (mouse) acorda e a faixa some', async () => {
    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * MIN); });
    act(() => { window.dispatchEvent(new Event('mousemove')); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('é uma sobreposição FIXA que não ocupa espaço no fluxo (senão o scroll anchoring acorda o painel sozinho)', async () => {
    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * MIN); });
    const caixa = screen.getByRole('status').closest('[data-idle-rest-overlay]');
    expect(caixa).not.toBeNull();
    expect(caixa.className).toMatch(/\bfixed\b/);
    expect(caixa.className).not.toMatch(/\b(sticky|relative|static)\b/);
    expect(screen.getByRole('status').className).not.toMatch(/\b(sticky|mb-\d+|mt-\d+)\b/); // nada que reserve espaço na página
  });

  it('o botão é alcançável pelo teclado e tem nome acessível', async () => {
    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * MIN); });
    const botao = screen.getByRole('button', { name: /Retomar agora/i });
    expect(botao.tagName).toBe('BUTTON');
    expect(botao.getAttribute('type')).toBe('button');
  });

  it('o ícone é decorativo (sem emoji, sem texto no DOM)', async () => {
    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * MIN); });
    const svg = screen.getByRole('status').querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('status').textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('trava: a faixa está montada no layout do painel', () => {
  it('AppLayout renderiza <IdleRestBanner /> (sem isso o repouso não começa nunca)', () => {
    const layout = readFileSync(join(process.cwd(), 'src/components/layout/AppLayout.jsx'), 'utf8');
    expect(layout).toMatch(/import IdleRestBanner from '\.\/IdleRestBanner'/);
    expect(layout).toMatch(/<IdleRestBanner \/>/);
  });
});
