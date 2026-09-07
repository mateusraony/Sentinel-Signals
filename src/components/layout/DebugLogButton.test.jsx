// @vitest-environment jsdom
//
// Rodada 3c (item 169). Mesma classe de ponto cego já fechada para
// TickerBar.jsx/GlobalSearch.jsx na rodada 3b: este componente vive dentro
// de AppLayout.jsx (a casca do app), fora da árvore que
// src/pages/pagesSmoke.test.jsx/renderPage() monta — nunca teve teste
// próprio. A leitura só dispara com o painel aberto (`enabled: open`), então
// o teste precisa clicar no botão flutuante antes de esperar a query.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import DebugLogButton from './DebugLogButton.jsx';

const systemLogListMock = vi.fn();
vi.mock('@/api/rtdbEntities', () => ({
  rtdbEntities: { SystemLog: { list: (...args) => systemLogListMock(...args) } },
}));

const systemLogDeleteMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/api/entities', () => ({
  backend: { entities: { SystemLog: { delete: (...args) => systemLogDeleteMock(...args) } } },
}));

afterEach(cleanup);

function renderButton() {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <DebugLogButton />
    </QueryClientProvider>,
  );
}

describe('DebugLogButton — SystemLog lido via rtdbEntities (rodada 3c, item 169)', () => {
  it('a query fica desabilitada até o painel abrir — nenhuma leitura antes do clique', async () => {
    systemLogListMock.mockResolvedValue([]);
    renderButton();
    expect(systemLogListMock).not.toHaveBeenCalled();
  });

  it('ao abrir o painel, chama rtdbEntities.SystemLog.list("-created_date", 50) — prova que a wiring está de fato ligada', async () => {
    systemLogListMock.mockResolvedValue([]);
    renderButton();
    fireEvent.click(screen.getByTitle('Debug Log'));
    await vi.waitFor(() => expect(systemLogListMock).toHaveBeenCalledWith('-created_date', 50));
  });

  it('renderiza os logs devolvidos pelo RTDB sem explodir', async () => {
    systemLogListMock.mockResolvedValue([
      { id: 'l1', level: 'error', module: 'scanner', message: 'BTCUSDT falhou', created_date: new Date().toISOString() },
    ]);
    renderButton();
    fireEvent.click(screen.getByTitle('Debug Log'));
    await screen.findByText('BTCUSDT falhou');
  });

  it('deletar um log continua indo por backend.entities (mutação nunca passa por rtdbEntities)', async () => {
    systemLogListMock.mockResolvedValue([
      { id: 'l1', level: 'error', module: 'scanner', message: 'BTCUSDT falhou', created_date: new Date().toISOString() },
    ]);
    renderButton();
    fireEvent.click(screen.getByTitle('Debug Log'));
    const trashButton = await screen.findByText('BTCUSDT falhou').then((el) => el.closest('.group').querySelector('button:last-child'));
    fireEvent.click(trashButton);
    await vi.waitFor(() => expect(systemLogDeleteMock).toHaveBeenCalledWith('l1'));
  });
});
