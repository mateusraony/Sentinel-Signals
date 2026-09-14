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

const { getIdTokenMock } = vi.hoisted(() => ({ getIdTokenMock: vi.fn() }));

vi.mock('@/lib/firebaseClient', () => ({
  auth: { currentUser: { getIdToken: getIdTokenMock } },
}));

beforeEach(() => {
  vi.resetModules();
  import.meta.env.VITE_BACKEND_URL = 'https://api.example.com';
  getIdTokenMock.mockReset();
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
});
