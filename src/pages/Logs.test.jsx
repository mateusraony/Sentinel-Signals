// @vitest-environment jsdom
//
// Refinamentos (seção E do Raio-X de UI/UX): campo de busca mais estreito
// que o placeholder e timestamp em contraste baixo — mesma classe de achado
// já corrigida em Alerts.jsx nesta mesma rodada. Página não tinha teste
// dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
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
  it('REGRESSÃO: input não usa mais w-40; em 22/11/2026 passou a ocupar a largura disponível (até max-w-xs), mais largo que o w-44 de antes', async () => {
    systemLogListMock.mockResolvedValue([]);
    renderLogs();
    const search = await screen.findByPlaceholderText('Buscar na mensagem...');
    expect(search.className).not.toMatch(/\bw-40\b/);
    expect(search.className).toMatch(/\bw-full\b/);
    expect(search.parentElement.className).toMatch(/sm:max-w-xs/);
  });
});

describe('Logs — timestamp de cada linha tem contraste maior (Refinamentos)', () => {
  it('REGRESSÃO: opacidade do timestamp sobe de 0.2 para 0.45', async () => {
    systemLogListMock.mockResolvedValue([
      { id: 'l1', level: 'error', module: 'scanner', message: 'BTCUSDT falhou', created_date: '2026-09-26T10:00:00.000Z' },
    ]);
    renderLogs();
    const timestamp = await screen.findByText(/^\d{2}:\d{2}:\d{2}$/);
    expect(timestamp.style.color).toBe('rgba(255, 255, 255, 0.62)');
  });
});

// Achado do Codex review no PR #439 (Alerts.jsx tinha a mesma classe de bug
// — copiada 1:1 desta linha; corrigido nos dois ao mesmo tempo): 0.25 dava
// ~2.3:1 de contraste sobre o fundo escuro, abaixo do 4.5:1 exigido pra
// texto pequeno — e é o único controle visível pra revelar o payload.
describe('Logs — "ver detalhes →" tem contraste suficiente (achado do Codex, PR #439)', () => {
  it('REGRESSÃO: opacidade do summary sobe de 0.25 para 0.45', async () => {
    systemLogListMock.mockResolvedValue([
      { id: 'l1', level: 'error', module: 'scanner', message: 'BTCUSDT falhou', created_date: '2026-09-26T10:00:00.000Z', details: { foo: 'bar' } },
    ]);
    renderLogs();
    const summary = await screen.findByText('ver detalhes →');
    expect(summary.style.color).toBe('rgba(255, 255, 255, 0.62)');
  });
});

// item 253 — error_class/scan_id (details) viram tags na linha e a busca
// também casa scan_id, pra isolar todos os logs de uma mesma passada.
describe('Logs — error_class e scan_id (item 253)', () => {
  const logs = [
    { id: 'l1', level: 'error', module: 'scanner', message: 'Falha ao adquirir lock "price-check"', created_date: '2026-10-03T10:00:00.000Z',
      details: { error_class: 'NETWORK', scan_id: 'price-check_1790000000000_abc123' } },
    { id: 'l2', level: 'error', module: 'scanner', message: 'Erro no scan de ETHUSDT: x', created_date: '2026-10-03T10:01:00.000Z',
      details: { error_class: 'TIMEOUT', scan_id: 'full-scan_1790000000999_zzz999' } },
  ];

  it('mostra a classe do erro e o scan_id abreviado como tags', async () => {
    systemLogListMock.mockResolvedValue(logs);
    renderLogs();
    expect(await screen.findByText('NETWORK')).toBeTruthy();
    expect(screen.getByText('TIMEOUT')).toBeTruthy();
    expect(screen.getByText('#abc123')).toBeTruthy();
  });

  it('buscar por scan_id isola só os logs daquela passada', async () => {
    systemLogListMock.mockResolvedValue(logs);
    renderLogs();
    const search = await screen.findByPlaceholderText('Buscar na mensagem...');
    fireEvent.change(search, { target: { value: 'full-scan_1790000000999' } });
    expect(screen.queryByText(/Falha ao adquirir lock/)).toBeNull();
    expect(screen.getByText(/Erro no scan de ETHUSDT/)).toBeTruthy();
  });
});

// 22/11/2026 — Logs refeito (estrutura, não só cor): contagens numa linha, "Nível" em abas ligadas e os registros agrupados por dia, com a hora e o
// nível juntos à esquerda (a hora sozinha não dizia de que dia era o registro). As contagens não afirmam "0" sem ter o dado.
describe('Logs — estrutura nova (22/11/2026)', () => {
  const HOJE = new Date().toISOString();
  const ANTIGO = new Date(Date.now() - 5 * 86400000).toISOString();
  const LOGS = [
    { id: 'a', level: 'error', module: 'scanner', message: 'Erro A', created_date: HOJE },
    { id: 'b', level: 'warn', module: 'scanner', message: 'Aviso B', created_date: HOJE },
    { id: 'c', level: 'info', module: 'telegram', message: 'Info C', created_date: ANTIGO },
  ];

  it('os registros vêm agrupados por dia, cada dia com título e contagem', async () => {
    systemLogListMock.mockResolvedValue(LOGS);
    renderLogs();
    await screen.findByText('Erro A');
    const titulos = screen.getAllByRole('heading', { level: 2 });
    expect(titulos).toHaveLength(2);
    expect(titulos[0].textContent).toBe('Hoje');
    expect(titulos[0].parentElement.textContent).toContain('2 registros');
    expect(titulos[1].parentElement.textContent).toContain('1 registro');
  });

  it('a hora e o nível ficam juntos, à esquerda, antes do texto da mensagem', async () => {
    systemLogListMock.mockResolvedValue(LOGS);
    renderLogs();
    const hora = (await screen.findAllByText(/^\d{2}:\d{2}:\d{2}$/))[0];
    const nivel = within(hora.parentElement).getByText('ERR');
    expect(nivel).toBeTruthy();
    const mensagem = screen.getByText('Erro A');
    expect(Boolean(hora.compareDocumentPosition(mensagem) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('as contagens são uma linha só, sem os 4 cartões com ícone, e batem com os registros', async () => {
    systemLogListMock.mockResolvedValue(LOGS);
    renderLogs();
    await screen.findByText('Erro A');
    const total = screen.getByText('Total');
    expect(within(total.parentElement).getByText('3')).toBeTruthy();
    expect(total.parentElement.parentElement.querySelector('svg')).toBeNull();
    expect(within(screen.getByText('Erros').parentElement).getByText('1')).toBeTruthy();
  });

  it('o filtro de nível é um grupo de abas ligadas e filtra a lista', async () => {
    systemLogListMock.mockResolvedValue(LOGS);
    renderLogs();
    await screen.findByText('Erro A');
    const err = screen.getByRole('button', { name: 'ERR' });
    expect(err.parentElement).toBe(screen.getByRole('button', { name: 'WARN' }).parentElement);
    expect(err.parentElement.className).toMatch(/overflow-hidden/);
    fireEvent.click(err);
    expect(screen.queryByText('Aviso B')).toBeNull();
    expect(screen.getByText('Erro A')).toBeTruthy();
  });

  it('enquanto carrega as contagens mostram "—", não "0"', async () => {
    systemLogListMock.mockImplementation(() => new Promise(() => {}));
    renderLogs();
    const total = await screen.findByText('Total');
    expect(total.parentElement.textContent).toContain('—');
    expect(total.parentElement.parentElement.textContent).not.toMatch(/\b0\b/);
  });
});
