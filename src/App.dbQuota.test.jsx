// @vitest-environment jsdom
//
// Achado do Codex no PR #514, de ponta a ponta: recarregar a página com o banco sem cota.
// O `/api/me` falha com db_quota ANTES do layout existir; a tela cheia precisa dizer "banco sem
// cota", não o "sem conexão" genérico (e o AppLayout, onde mora o banner, nem chega a montar).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const { callBackendMock, authStateCallbacks } = vi.hoisted(() => ({
  callBackendMock: vi.fn(),
  authStateCallbacks: [],
}));

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth, cb) => { authStateCallbacks.push(cb); return () => {}; },
  signInAnonymously: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('@/lib/firebaseClient', () => ({ auth: {} }));
vi.mock('@/lib/apiBackend', () => ({ callBackend: callBackendMock }));
vi.mock('@/lib/logger', () => ({
  initLogger: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn(),
}));

import App from './App.jsx';

beforeEach(() => { callBackendMock.mockReset(); authStateCallbacks.length = 0; vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function loadAppWithProfileError(error) {
  callBackendMock.mockRejectedValue(error);
  render(<App />);
  await waitFor(() => expect(authStateCallbacks.length).toBe(1));
  await authStateCallbacks[0]({ uid: 'u1', email: null });
}

describe('App — recarregar com o banco sem cota', () => {
  it('db_quota no /api/me mostra "Banco de dados sem cota", não o "sem conexão" genérico', async () => {
    await loadAppWithProfileError(Object.assign(new Error('Banco de dados sem cota.'), { status: 503, code: 'db_quota' }));
    await waitFor(() => expect(screen.getByText('Banco de dados sem cota')).toBeTruthy());
    expect(screen.queryByText('Sem conexão com o servidor')).toBeNull();
    expect(screen.getByText(/computação, transferência ou espaço/)).toBeTruthy();
  });

  it('erro comum no /api/me continua mostrando a tela "Sem conexão com o servidor"', async () => {
    await loadAppWithProfileError(new Error('Failed to fetch'));
    await waitFor(() => expect(screen.getByText('Sem conexão com o servidor')).toBeTruthy());
  });
});
