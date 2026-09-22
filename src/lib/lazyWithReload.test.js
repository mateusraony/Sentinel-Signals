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

  it('não recarrega de novo se já tentou nesta aba (evita loop de reload)', async () => {
    sessionStorage.setItem('sentinel_chunk_reload_attempted', '1');
    const reloadSpy = vi.fn();
    vi.stubGlobal('location', { reload: reloadSpy });
    const factory = vi.fn().mockRejectedValue(new TypeError('Failed to fetch dynamically imported module: x.js'));

    await expect(loadWithReload(factory)).rejects.toThrow('Failed to fetch dynamically imported module');
    expect(reloadSpy).not.toHaveBeenCalled();
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
