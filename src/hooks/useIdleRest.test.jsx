/**
 * @vitest-environment jsdom
 *
 * Repouso do painel (docs/known-risks.md item 301). Usa o React Query DE VERDADE: a prova que importa é que o intervalo de atualização das telas
 * PARA em repouso (o banco não é consultado) e que a primeira atividade refaz as consultas na hora.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery, focusManager } from '@tanstack/react-query';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { useIdleRest } from './useIdleRest';
import { isResting, stopIdleRest } from '@/lib/idleRest';

const MIN = 60_000;

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: Infinity } } });
  const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const buscar = vi.fn().mockResolvedValue('ok');
  const tela = renderHook(() => {
    const resting = useIdleRest();
    useQuery({ queryKey: ['dado'], queryFn: buscar, refetchInterval: MIN });
    return resting;
  }, { wrapper });
  return { client, buscar, tela };
}

const atividade = () => act(() => { window.dispatchEvent(new Event('mousemove')); });

describe('useIdleRest — o intervalo das telas para em repouso e volta ao acordar', () => {
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

  it('ativo: a tela atualiza a cada 60 s (comportamento de sempre)', async () => {
    const { buscar } = montar();
    await vi.advanceTimersByTimeAsync(10);
    const inicio = buscar.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3 * MIN + 100);
    expect(buscar.mock.calls.length - inicio).toBeGreaterThanOrEqual(3);
  });

  it('em repouso: NENHUMA atualização automática, por mais que o tempo passe', async () => {
    const { buscar, tela } = montar();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(tela.result.current).toBe(true);
    const congelado = buscar.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(buscar.mock.calls.length).toBe(congelado);
  });

  it('a primeira atividade acorda, atualiza as telas NA HORA e o intervalo volta', async () => {
    const { buscar, tela } = montar();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    const congelado = buscar.mock.calls.length;
    atividade();
    await vi.advanceTimersByTimeAsync(50);
    expect(tela.result.current).toBe(false);
    expect(buscar.mock.calls.length).toBeGreaterThan(congelado); // refez na hora (voltou o foco)
    const depois = buscar.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3 * MIN + 100);
    expect(buscar.mock.calls.length - depois).toBeGreaterThanOrEqual(3); // e o intervalo normal voltou
  });

  it('o valor devolvido acompanha o repouso (a faixa de aviso lê isto)', async () => {
    const { tela } = montar();
    expect(tela.result.current).toBe(false);
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(tela.result.current).toBe(true);
    atividade();
    expect(tela.result.current).toBe(false);
  });

  it('rolagem que NÃO borbulha, num elemento interno, também acorda (ouvinte em captura)', async () => {
    const { tela } = montar();
    const caixa = document.createElement('div');
    document.body.appendChild(caixa);
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(tela.result.current).toBe(true);
    act(() => { caixa.dispatchEvent(new Event('scroll', { bubbles: false })); });
    expect(tela.result.current).toBe(false);
    caixa.remove();
  });

  it('ao acordar o foco volta a seguir o navegador (aba escondida continua "sem foco")', async () => {
    montar();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    atividade();
    const espia = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    expect(focusManager.isFocused()).toBe(false); // não ficou travado em "com foco"
    espia.mockRestore();
    expect(focusManager.isFocused()).toBe(true);
  });

  it('desmontar para tudo: o foco do React Query volta ao normal e nada fica ouvindo', async () => {
    const { tela } = montar();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(focusManager.isFocused()).toBe(false);
    tela.unmount();
    expect(focusManager.isFocused()).toBe(true);
    expect(isResting()).toBe(false);
    expect(() => window.dispatchEvent(new Event('mousemove'))).not.toThrow();
  });

  it('em repouso o React Query considera a aba "sem foco" e ao acordar volta a "com foco"', async () => {
    montar();
    expect(focusManager.isFocused()).toBe(true);
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(focusManager.isFocused()).toBe(false);
    atividade();
    expect(focusManager.isFocused()).toBe(true);
  });
});

// Trava estrutural: `refetchIntervalInBackground: true` faria a tela continuar consultando o banco em repouso/aba escondida, desfazendo o item 301.
describe('trava: nenhuma tela força o polling em segundo plano', () => {
  const RAIZ = join(process.cwd(), 'src');
  const arquivos = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? arquivos(p) : /\.(jsx?|tsx?)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
  const semComentario = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('nenhum arquivo do app liga refetchIntervalInBackground', () => {
    const todos = arquivos(RAIZ);
    expect(todos.length).toBeGreaterThan(100); // não-vacuidade
    const culpados = todos.filter((f) => /refetchIntervalInBackground\s*:\s*true/.test(semComentario(readFileSync(f, 'utf8'))));
    expect(culpados).toEqual([]);
  });
  it('a variante plantada seria acusada', () => {
    expect(/refetchIntervalInBackground\s*:\s*true/.test(semComentario('useQuery({ refetchIntervalInBackground: true })'))).toBe(true);
  });
});
