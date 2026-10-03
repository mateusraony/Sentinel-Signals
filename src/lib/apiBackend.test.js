// docs/known-risks.md item 177 — o token de ID do Firebase pode chegar
// expirado numa chamada (aba em segundo plano/notebook em suspensão atrasa o
// refresh proativo do SDK), visto em produção como "Invalid or expired
// token." em várias passadas de useAutoScan.js na mesma janela. callBackend
// agora tenta de novo UMA vez com refresh forçado quando o servidor responde
// 401, sem mascarar uma falha de autenticação real (401 persistente ainda
// propaga o erro).
//
// BASE_URL (apiBackend.js) é capturado no CARREGAMENTO do módulo — setar
// import.meta.env.VITE_BACKEND_URL num beforeEach não alcançaria um módulo
// já importado. Por isso, mesmo padrão de adminEntitiesBackfillCache.test.js:
// vi.resetModules() + import dinâmico dentro de cada teste, depois de setar
// o env.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getIdTokenMock, getOwnerKeyMock } = vi.hoisted(() => ({
  getIdTokenMock: vi.fn(),
  getOwnerKeyMock: vi.fn(),
}));

vi.mock('@/lib/firebaseClient', () => ({
  auth: { currentUser: { getIdToken: getIdTokenMock } },
}));

// requireOwner (server/requireOwner.js, achado P0 do sentinel-security-
// review) — callBackend precisa mandar a chave em TODA chamada.
vi.mock('@/lib/ownerKey', () => ({
  getOwnerKey: getOwnerKeyMock,
}));

beforeEach(() => {
  vi.resetModules();
  import.meta.env.VITE_BACKEND_URL = 'https://api.example.com';
  getIdTokenMock.mockReset();
  getOwnerKeyMock.mockReset().mockReturnValue('chave-do-dono');
  global.fetch = vi.fn();
});

describe('callBackend', () => {
  it('token expirado (401) é retentado UMA vez com refresh forçado, e a 2a tentativa passa', async () => {
    getIdTokenMock
      .mockResolvedValueOnce('token-velho')
      .mockResolvedValueOnce('token-novo');
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'Invalid or expired token.' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'a1' }) });

    const { callBackend } = await import('./apiBackend');
    const result = await callBackend('/api/entities/MonitoredAsset');

    expect(result).toEqual({ id: 'a1' });
    expect(getIdTokenMock).toHaveBeenNthCalledWith(1, false);
    expect(getIdTokenMock).toHaveBeenNthCalledWith(2, true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('401 persistente mesmo após o refresh continua propagando o erro (não mascara falha de auth real)', async () => {
    getIdTokenMock.mockResolvedValue('token-qualquer');
    global.fetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'Invalid or expired token.' }) });

    const { callBackend } = await import('./apiBackend');
    await expect(callBackend('/api/entities/MonitoredAsset')).rejects.toThrow('Invalid or expired token.');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('sucesso na 1a tentativa não dispara refresh nem 2a chamada', async () => {
    getIdTokenMock.mockResolvedValueOnce('token-bom');
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'a1' }) });

    const { callBackend } = await import('./apiBackend');
    const result = await callBackend('/api/entities/MonitoredAsset');

    expect(result).toEqual({ id: 'a1' });
    expect(getIdTokenMock).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // docs/known-risks.md — "Failed to fetch" visto em produção contra este
  // backend (lock/StrategyConfig), não só contra a Binance. GET agora passa
  // por fetchWithRetry (src/lib/httpRetry.js, mesmo módulo da Binance) —
  // sobrevive a um blip de rede transitório sem precisar do 401-retry.
  it('GET sobrevive a um "Failed to fetch" transitório via retry de rede (fetchWithRetry)', async () => {
    vi.useFakeTimers();
    try {
      getIdTokenMock.mockResolvedValueOnce('token-bom');
      global.fetch
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'a1' }) });

      const { callBackend } = await import('./apiBackend');
      const promise = callBackend('/api/entities/MonitoredAsset');
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result).toEqual({ id: 'a1' });
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(getIdTokenMock).toHaveBeenCalledTimes(1); // não é retry de 401 — mesmo token, sem refresh
    } finally {
      vi.useRealTimers();
    }
  });

  it('GET esgota o retry de rede e propaga o erro de rede (não mascara falha persistente)', async () => {
    vi.useFakeTimers();
    try {
      getIdTokenMock.mockResolvedValue('token-bom');
      global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

      const { callBackend } = await import('./apiBackend');
      const promise = callBackend('/api/entities/MonitoredAsset');
      const assertion = expect(promise).rejects.toThrow('Failed to fetch');
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      expect(global.fetch).toHaveBeenCalledTimes(4); // 1 tentativa inicial + 3 retries (GET_RETRY_OPTIONS.maxRetries)
    } finally {
      vi.useRealTimers();
    }
  });

  it('POST (mutante) não usa o retry de rede — uma falha de rede propaga na hora', async () => {
    getIdTokenMock.mockResolvedValueOnce('token-bom');
    global.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const { callBackend } = await import('./apiBackend');
    await expect(callBackend('/api/trade-ops/create-if-none-active', { assetId: 'a1' })).rejects.toThrow('Failed to fetch');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('toda chamada inclui o header X-Owner-Key (requireOwner no server)', async () => {
    getIdTokenMock.mockResolvedValueOnce('token-bom');
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'a1' }) });

    const { callBackend } = await import('./apiBackend');
    await callBackend('/api/entities/MonitoredAsset');

    const [, requestInit] = global.fetch.mock.calls[0];
    expect(requestInit.headers['X-Owner-Key']).toBe('chave-do-dono');
  });
});
