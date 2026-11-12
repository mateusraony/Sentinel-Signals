/**
 * @vitest-environment jsdom
 *
 * Repouso do painel (docs/known-risks.md item 301). Usa o React Query DE VERDADE: a prova que importa é que o intervalo de atualização das telas
 * PARA em repouso (o banco não é consultado entre as atualizações lentas de 30 min), que a tela NÃO congela (atualiza a cada 30 min) e que a primeira
 * atividade refaz as consultas na hora.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery, focusManager } from '@tanstack/react-query';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { useIdleRest } from './useIdleRest';
import { isResting, stopIdleRest, keepLive } from '@/lib/idleRest';

const MIN = 60_000;

function montar({ intervalo = MIN } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: Infinity } } });
  const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const buscar = vi.fn().mockResolvedValue('ok');
  const tela = renderHook(() => {
    const estado = useIdleRest();
    useQuery({ queryKey: ['dado'], queryFn: buscar, refetchInterval: intervalo });
    return estado;
  }, { wrapper });
  return { client, buscar, tela };
}

const atividade = () => act(() => { window.dispatchEvent(new Event('mousemove')); });

describe('useIdleRest — o intervalo das telas para em repouso, a tela não congela e volta ao acordar', () => {
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

  it('em repouso: o intervalo de 60 s PARA; só a atualização lenta (a cada 30 min) consulta', async () => {
    const { buscar, tela } = montar();
    await vi.advanceTimersByTimeAsync(21 * MIN); // entra em repouso aos 20 min
    expect(tela.result.current.resting).toBe(true);
    const base = buscar.mock.calls.length;
    await vi.advanceTimersByTimeAsync(28 * MIN); // t = 49 min (29 min em repouso): ainda nenhuma atualização
    expect(buscar.mock.calls.length).toBe(base);
    await vi.advanceTimersByTimeAsync(2 * MIN); // t = 51 min (31 min em repouso): UMA atualização
    expect(buscar.mock.calls.length).toBe(base + 1);
  });

  it('a tela não congela: em 3 h de repouso ela atualiza ~6 vezes (a cada 30 min), nunca 180', async () => {
    const { buscar, tela } = montar();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    const base = buscar.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180 * MIN);
    expect(tela.result.current.resting).toBe(true);
    const feitas = buscar.mock.calls.length - base;
    expect(feitas).toBeGreaterThanOrEqual(5);
    expect(feitas).toBeLessThanOrEqual(7);
  });

  it('aba escondida em repouso NÃO atualiza (ninguém olha; ao voltar o foco refaz na hora)', async () => {
    const { buscar } = montar();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    const base = buscar.mock.calls.length;
    const espia = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(95 * MIN);
    expect(buscar.mock.calls.length).toBe(base);
    espia.mockRestore();
  });

  it('a primeira atividade acorda, atualiza as telas NA HORA e o intervalo volta', async () => {
    const { buscar, tela } = montar();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    const congelado = buscar.mock.calls.length;
    atividade();
    await vi.advanceTimersByTimeAsync(50);
    expect(tela.result.current.resting).toBe(false);
    expect(buscar.mock.calls.length).toBeGreaterThan(congelado); // refez na hora (voltou o foco)
    const depois = buscar.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3 * MIN + 100);
    expect(buscar.mock.calls.length - depois).toBeGreaterThanOrEqual(3); // e o intervalo normal voltou
  });

  it('ao acordar a atualização lenta PARA (não sobra temporizador de 30 min rodando)', async () => {
    const { buscar } = montar();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    atividade();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    // com o painel ativo de novo (e atividade a cada 5 min, para não voltar ao repouso) o ritmo é o de 60 s, não somado ao de 30 min
    const base = buscar.mock.calls.length;
    for (let i = 0; i < 6; i += 1) { atividade(); await vi.advanceTimersByTimeAsync(5 * MIN); }
    const feitas = buscar.mock.calls.length - base;
    expect(feitas).toBeGreaterThanOrEqual(29);
    expect(feitas).toBeLessThanOrEqual(32); // 30 min ativos a 60 s = ~30; a atualização lenta não soma
  });

  it('ativo, a atualização lenta NÃO roda (uma tela sem intervalo próprio não é consultada de novo só pelo tempo)', async () => {
    const { buscar } = montar({ intervalo: false });
    await vi.advanceTimersByTimeAsync(10);
    const base = buscar.mock.calls.length;
    for (let i = 0; i < 20; i += 1) { atividade(); await vi.advanceTimersByTimeAsync(5 * MIN); } // 100 min ativo, sempre mexendo
    expect(buscar.mock.calls.length).toBe(base);
  });

  it('depois de acordar, o temporizador da atualização lenta é DESARMADO (nenhuma consulta extra aos 30 min)', async () => {
    const { buscar, tela } = montar({ intervalo: false });
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(tela.result.current.resting).toBe(true);
    atividade();
    await vi.advanceTimersByTimeAsync(50); // refaz na hora ao voltar o foco
    const base = buscar.mock.calls.length;
    for (let i = 0; i < 20; i += 1) { atividade(); await vi.advanceTimersByTimeAsync(5 * MIN); }
    expect(buscar.mock.calls.length).toBe(base);
  });

  it('o valor devolvido é { resting, liveUntil } e acompanha o repouso', async () => {
    const { tela } = montar();
    expect(tela.result.current).toEqual({ resting: false, liveUntil: null });
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(tela.result.current.resting).toBe(true);
    expect(isResting()).toBe(true); // o que o useAutoScan e o monitor do logger leem
    atividade();
    expect(tela.result.current.resting).toBe(false);
    expect(isResting()).toBe(false);
  });

  it('"Manter ao vivo": não entra em repouso, o intervalo de 60 s segue, e o horário final aparece', async () => {
    const { buscar, tela } = montar();
    act(() => keepLive());
    expect(tela.result.current.liveUntil).toBe(Date.now() + 60 * MIN);
    await vi.advanceTimersByTimeAsync(40 * MIN);
    expect(tela.result.current.resting).toBe(false);
    expect(buscar.mock.calls.length).toBeGreaterThanOrEqual(38); // continua a ~60 s
  });

  it('"Manter ao vivo" em repouso acorda e devolve o foco ao React Query', async () => {
    const { tela } = montar();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(focusManager.isFocused()).toBe(false);
    act(() => keepLive());
    expect(tela.result.current.resting).toBe(false);
    expect(focusManager.isFocused()).toBe(true);
  });

  it('rolagem SOZINHA (scroll anchoring, sem roda/toque/tecla) NÃO acorda o painel', async () => {
    const { tela } = montar();
    const caixa = document.createElement('div');
    document.body.appendChild(caixa);
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(tela.result.current.resting).toBe(true);
    act(() => { caixa.dispatchEvent(new Event('scroll', { bubbles: false })); window.dispatchEvent(new Event('scroll')); });
    expect(tela.result.current.resting).toBe(true);
    act(() => { caixa.dispatchEvent(new Event('wheel', { bubbles: false })); }); // roda do mouse num elemento interno: acorda (captura)
    expect(tela.result.current.resting).toBe(false);
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
    const { tela, buscar } = montar();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(focusManager.isFocused()).toBe(false);
    tela.unmount();
    expect(focusManager.isFocused()).toBe(true);
    expect(isResting()).toBe(false);
    expect(() => window.dispatchEvent(new Event('mousemove'))).not.toThrow();
    const base = buscar.mock.calls.length;
    await vi.advanceTimersByTimeAsync(90 * MIN);
    expect(buscar.mock.calls.length).toBe(base); // nem o temporizador de 30 min sobrou
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
