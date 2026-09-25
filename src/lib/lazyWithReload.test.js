// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadWithReload } from './lazyWithReload.js';

describe('loadWithReload', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('sucesso: devolve o módulo normalmente, sem tocar sessionStorage nem recarregar', async () => {
    const reloadSpy = vi.fn();
    vi.stubGlobal('location', { reload: reloadSpy });
    const factory = vi.fn().mockResolvedValue({ default: 'Página' });

    const result = await loadWithReload(factory);

    expect(result).toEqual({ default: 'Página' });
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('sentinel_chunk_reload_attempted')).toBeNull();
  });

  // REGRESSÃO real (docs/known-risks.md item 184 addendum): uma aba aberta
  // desde antes de um deploy tenta buscar um chunk que não existe mais no
  // servidor e, sem isto, ficava presa nesse erro pra sempre — nunca
  // recarregava sozinha.
  it('REGRESSÃO: erro de chunk (deploy novo) recarrega a página uma vez em vez de propagar o erro', async () => {
    const reloadSpy = vi.fn();
    vi.stubGlobal('location', { reload: reloadSpy });
    const factory = vi.fn().mockRejectedValue(
      new TypeError('Failed to fetch dynamically imported module: https://sentinel-signals.onrender.com/assets/Alerts-4Xx17WQA.js'),
    );

    // A promise devolvida nunca resolve (o reload real navegaria para longe
    // antes disso) — só precisamos confirmar que o reload foi disparado.
    loadWithReload(factory);
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem('sentinel_chunk_reload_attempted')).toBe('1');
  });

  it('não recarrega de novo se a MESMA falha persiste sem sucesso no meio (evita loop de reload)', async () => {
    sessionStorage.setItem('sentinel_chunk_reload_attempted', '1');
    const reloadSpy = vi.fn();
    vi.stubGlobal('location', { reload: reloadSpy });
    const factory = vi.fn().mockRejectedValue(new TypeError('Failed to fetch dynamically imported module: x.js'));

    await expect(loadWithReload(factory)).rejects.toThrow('Failed to fetch dynamically imported module');
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  // REGRESSÃO real (docs/known-risks.md, auditoria de 2026-09-25): a flag
  // ficava marcada pra sempre nesta aba depois do 1º reload bem-sucedido —
  // um 2º deploy, dias depois, na mesma aba (item 184 addendum), produzia um
  // 2º chunk-error genuíno de uma página DIFERENTE que não se autocurava
  // mais, caindo direto no ErrorBoundary em vez de recarregar. Um sucesso no
  // meio (prova de que a aba já está rodando o deploy atual) precisa devolver
  // o orçamento de 1 reload para o PRÓXIMO incidente distinto.
  it('REGRESSÃO: um sucesso no meio devolve o orçamento de reload pra um incidente FUTURO distinto', async () => {
    const reloadSpy = vi.fn();
    vi.stubGlobal('location', { reload: reloadSpy });

    // 1º incidente: falha, recarrega, marca a flag.
    const firstFactory = vi.fn().mockRejectedValue(
      new TypeError('Failed to fetch dynamically imported module: Alerts-old.js'),
    );
    loadWithReload(firstFactory);
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem('sentinel_chunk_reload_attempted')).toBe('1');

    // Pós-reload (mount novo): outra página carrega com sucesso — prova que o
    // deploy atual está saudável, deve limpar a flag.
    const successFactory = vi.fn().mockResolvedValue({ default: 'Dashboard' });
    await loadWithReload(successFactory);
    expect(sessionStorage.getItem('sentinel_chunk_reload_attempted')).toBeNull();

    // 2º incidente, dias depois, página DIFERENTE: sem o fix, a flag ainda
    // estaria '1' e isto propagaria pro ErrorBoundary sem recarregar de novo.
    const secondFactory = vi.fn().mockRejectedValue(
      new TypeError('Failed to fetch dynamically imported module: Settings-new.js'),
    );
    loadWithReload(secondFactory);
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(2));
    expect(sessionStorage.getItem('sentinel_chunk_reload_attempted')).toBe('1');
  });

  it('erro que NÃO é de chunk (ex.: offline) propaga normalmente, sem recarregar', async () => {
    const reloadSpy = vi.fn();
    vi.stubGlobal('location', { reload: reloadSpy });
    const factory = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(loadWithReload(factory)).rejects.toThrow('Failed to fetch');
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('sentinel_chunk_reload_attempted')).toBeNull();
  });
});
