// @vitest-environment jsdom
//
// Alertas — carga que FALHA (21/11/2026). Conferindo os estados raros da tela refeita apareceu que, com a lista fora do ar, o cabeçalho afirmava
// "0 alertas" e as contagens diziam "0" — afirmação falsa (não é "zero", é "não sei"). Agora mostram "—" e "alertas indisponíveis".
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';
import Alerts from './Alerts.jsx';

vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      SignalEvent: { list: async () => { throw new Error('falha simulada'); }, update: vi.fn() },
    },
  },
}));

afterEach(cleanup);

describe('Alerts — carga falhou (contagens não afirmam "0")', () => {
  it('mostra a mensagem de erro, "—" nas contagens e "alertas indisponíveis" no cabeçalho', async () => {
    renderPage(<Alerts />);
    await screen.findByText('Não foi possível carregar os alertas agora.');
    expect(screen.getByText('alertas indisponíveis')).toBeTruthy();
    const linha = screen.getByText('Alta Prioridade').parentElement.parentElement;
    expect(linha.textContent).not.toMatch(/\b0\b/);
    expect(linha.textContent).toContain('—');
    expect(screen.queryByText('0 alertas')).toBeNull();
  });
});
