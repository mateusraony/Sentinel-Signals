// @vitest-environment jsdom
//
// Achado do Codex no PR #514: com o banco sem cota, o `/api/me` falha ANTES do layout existir.
// O `code` do erro precisa chegar em `authError` para o App explicar a causa (authErrorView.js).
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

import { AuthProvider, useAuth } from './AuthContext.jsx';

function Probe() {
  const { authError, isLoadingAuth } = useAuth();
  return <div data-testid="probe">{isLoadingAuth ? 'loading' : JSON.stringify(authError)}</div>;
}

beforeEach(() => { callBackendMock.mockReset(); authStateCallbacks.length = 0; vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function signIn() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(authStateCallbacks.length).toBe(1));
  await authStateCallbacks[0]({ uid: 'u1', email: null });
}

describe('AuthContext — erro ao carregar o perfil', () => {
  it('propaga o code db_quota para authError (o App explica a causa)', async () => {
    callBackendMock.mockRejectedValue(Object.assign(new Error('Banco de dados sem cota.'), { status: 503, code: 'db_quota' }));
    await signIn();
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toContain('"code":"db_quota"'));
  });

  it('erro comum continua sem code (tela genérica de sempre)', async () => {
    callBackendMock.mockRejectedValue(new Error('Failed to fetch'));
    await signIn();
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toContain('Failed to fetch'));
    expect(screen.getByTestId('probe').textContent).not.toContain('db_quota');
  });
});
