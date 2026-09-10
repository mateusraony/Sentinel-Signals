// @vitest-environment jsdom
//
// Rodada 3c (item 169), atualizado no cutover Postgres/Neon (item 2 do
// runbook): o espelho RTDB foi abandonado (decisão explícita do usuário —
// Postgres não tem teto diário de operações, motivo original do mirror) e
// `rtdbEntities` reverteu para `backend.entities` — leitura e mutação agora
// passam pelo MESMO adaptador (`@/api/entities`), um único mock cobre os
// dois. Mesma classe de ponto cego já fechada para TickerBar.jsx/
// GlobalSearch.jsx na rodada 3b: este componente vive dentro de
// AppLayout.jsx (a casca do app), fora da árvore que
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
const systemLogDeleteMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      SystemLog: {
        list: (...args) => systemLogListMock(...args),
        delete: (...args) => systemLogDeleteMock(...args),
      },
    },
  },
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

describe('DebugLogButton — SystemLog lido via backend.entities (item 169; RTDB abandonado no cutover Postgres)', () => {
  it('a query fica desabilitada até o painel abrir — nenhuma leitura antes do clique', async () => {
    systemLogListMock.mockResolvedValue([]);
    renderButton();
    expect(systemLogListMock).not.toHaveBeenCalled();
  });

  it('ao abrir o painel, chama backend.entities.SystemLog.list("-created_date", 50) — prova que a wiring está de fato ligada', async () => {
    systemLogListMock.mockResolvedValue([]);
    renderButton();
    fireEvent.click(screen.getByTitle('Debug Log'));
    await vi.waitFor(() => expect(systemLogListMock).toHaveBeenCalledWith('-created_date', 50));
  });

  it('renderiza os logs devolvidos pelo backend sem explodir', async () => {
    systemLogListMock.mockResolvedValue([
      { id: 'l1', level: 'error', module: 'scanner', message: 'BTCUSDT falhou', created_date: new Date().toISOString() },
    ]);
    renderButton();
    fireEvent.click(screen.getByTitle('Debug Log'));
    await screen.findByText('BTCUSDT falhou');
  });

  it('deletar um log continua indo por backend.entities', async () => {
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
