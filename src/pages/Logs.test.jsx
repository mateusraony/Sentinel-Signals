// @vitest-environment jsdom
//
// Refinamentos (seção E do Raio-X de UI/UX): campo de busca mais estreito
// que o placeholder e timestamp em contraste baixo — mesma classe de achado
// já corrigida em Alerts.jsx nesta mesma rodada. Página não tinha teste
// dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from './__fixtures__/renderPage.jsx';
import Logs from './Logs.jsx';

const systemLogListMock = vi.fn();
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      SystemLog: {
        list: (...args) => systemLogListMock(...args),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    },
  },
}));

afterEach(cleanup);

function renderLogs() {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <Logs />
    </QueryClientProvider>,
  );
}

describe('Logs — campo de busca não corta o placeholder (Refinamentos)', () => {
  it('REGRESSÃO: input não usa mais w-40, agora w-44', async () => {
    systemLogListMock.mockResolvedValue([]);
    renderLogs();
    const search = await screen.findByPlaceholderText('Buscar na mensagem...');
    expect(search.className).not.toMatch(/\bw-40\b/);
    expect(search.className).toMatch(/\bw-44\b/);
  });
});

describe('Logs — timestamp de cada linha tem contraste maior (Refinamentos)', () => {
  it('REGRESSÃO: opacidade do timestamp sobe de 0.2 para 0.45', async () => {
    systemLogListMock.mockResolvedValue([
      { id: 'l1', level: 'error', module: 'scanner', message: 'BTCUSDT falhou', created_date: '2026-09-26T10:00:00.000Z' },
    ]);
    renderLogs();
    const timestamp = await screen.findByText(/^\d{2}:\d{2}:\d{2}$/);
    expect(timestamp.style.color).toBe('rgba(255, 255, 255, 0.45)');
  });
});

// Achado do Codex review no PR #439 (Alerts.jsx tinha a mesma classe de bug
// — copiada 1:1 desta linha; corrigido nos dois ao mesmo tempo): 0.25 dava
// ~2.3:1 de contraste sobre o fundo escuro, abaixo do 4.5:1 exigido pra
// texto pequeno — e é o único controle visível pra revelar o payload.
describe('Logs — "ver payload →" tem contraste suficiente (achado do Codex, PR #439)', () => {
  it('REGRESSÃO: opacidade do summary sobe de 0.25 para 0.45', async () => {
    systemLogListMock.mockResolvedValue([
      { id: 'l1', level: 'error', module: 'scanner', message: 'BTCUSDT falhou', created_date: '2026-09-26T10:00:00.000Z', details: { foo: 'bar' } },
    ]);
    renderLogs();
    const summary = await screen.findByText('ver payload →');
    expect(summary.style.color).toBe('rgba(255, 255, 255, 0.45)');
  });
});
