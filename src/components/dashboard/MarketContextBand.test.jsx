// @vitest-environment jsdom
// Contexto de Mercado — Fase 3: a faixa de eventos renderizada. Prova os 4 estados (atualizado, desatualizado,
// indisponível, desligado), o texto neutro (nada de "probabilidade"/"vai subir"), a data "a confirmar" sem
// contagem regressiva, a chave de ocultar persistindo, e que a rede nunca é chamada de verdade nos testes.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderPage } from '@/pages/__fixtures__/renderPage.jsx';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/marketContextSource', () => ({ fetchMarketContext: fetchMock }));

import MarketContextBand from './MarketContextBand.jsx';

const NOW = Date.now();
const inH = (h) => new Date(NOW + h * 3600000).toISOString();
const ev = (id, kind, startsAtUtc, status = 'oficial') => ({ id, kind, status, startsAtUtc, startMs: Date.parse(startsAtUtc) });

const mem = new Map();
beforeEach(() => {
  mem.clear();
  vi.stubGlobal('localStorage', { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Promise(() => {}));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('MarketContextBand', () => {
  it('atualizado: lista os próximos eventos com hora de Brasília, contagem regressiva e situação', async () => {
    fetchMock.mockResolvedValue({
      checkedAtMs: NOW - 2 * 3600000,
      events: [ev('CPI-x', 'CPI', inH(30)), ev('FOMC-x', 'FOMC', inH(24 * 9), 'confirmada')],
    });
    renderPage(<MarketContextBand />);
    await screen.findByText('CPI');
    expect(screen.getByRole('region', { name: 'Agenda de eventos dos EUA' })).toBeTruthy();
    expect(screen.getByText('FOMC')).toBeTruthy();
    expect(screen.getByText(/em 1d 6h|em 1d 5h/)).toBeTruthy(); // 30 h à frente (± arredondamento do minuto)
    expect(screen.getByText('(oficial)')).toBeTruthy();
    expect(screen.getByText('(confirmada)')).toBeTruthy();
    expect(screen.getAllByText(/\(Brasília\)/).length).toBe(2);
    expect(screen.queryByText(/desatualizada/)).toBeNull();
  });

  it('texto neutro: só informação, nunca previsão ou probabilidade', async () => {
    fetchMock.mockResolvedValue({ checkedAtMs: NOW, events: [ev('a', 'CPI', inH(5))] });
    const { container } = renderPage(<MarketContextBand />);
    await screen.findByText('CPI');
    expect(screen.getByText(/Só informação — não altera sinais nem operações/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/probabilidade|vai subir|vai cair|compra|venda/i);
  });

  it('data a confirmar aparece apagada, sem contagem regressiva', async () => {
    fetchMock.mockResolvedValue({ checkedAtMs: NOW, events: [ev('a', 'NFP', inH(48), 'a_confirmar')] });
    renderPage(<MarketContextBand />);
    await screen.findByText('Payroll');
    expect(screen.getByText('(data a confirmar)')).toBeTruthy();
    expect(screen.queryByText(/^em \d/)).toBeNull();
  });

  it('evento que acabou de sair (≤ 30 min) mostra "acabou de sair"', async () => {
    fetchMock.mockResolvedValue({ checkedAtMs: NOW, events: [ev('a', 'CPI', new Date(NOW - 10 * 60000).toISOString())] });
    renderPage(<MarketContextBand />);
    await screen.findByText('acabou de sair');
  });

  it('desatualizado: avisa a idade da última checagem e pede para conferir a data', async () => {
    fetchMock.mockResolvedValue({ checkedAtMs: NOW - 50 * 3600000, events: [ev('a', 'CPI', inH(10))] });
    renderPage(<MarketContextBand />);
    await screen.findByText(/Última checagem há 50 h/);
    expect(screen.getByText(/pode estar desatualizada/)).toBeTruthy();
    expect(screen.getByText('CPI')).toBeTruthy(); // continua mostrando os eventos
  });

  it('indisponível (rede/branch inexistente): uma linha calma, sem erro, dizendo que nada é afetado', async () => {
    fetchMock.mockRejectedValue(new Error('HTTP 404'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage(<MarketContextBand />);
    await screen.findByText(/Agenda indisponível no momento/);
    expect(screen.getByText(/Isso não afeta sinais nem operações/)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('sem eventos à frente: mensagem própria', async () => {
    fetchMock.mockResolvedValue({ checkedAtMs: NOW, events: [ev('a', 'CPI', inH(-48))] });
    renderPage(<MarketContextBand />);
    await screen.findByText('Nenhum evento à frente na agenda.');
  });

  it('erro de renderização da faixa NÃO derruba o resto da tela (caixa de erro local, sem log)', async () => {
    // Um evento que estoura quando o componente o lê (simula um bug de renderização na faixa).
    fetchMock.mockResolvedValue({ checkedAtMs: NOW, events: [{ id: 'x', get startMs() { throw new Error('boom'); } }] });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {}); // o React registra o erro capturado
    const calar = (e) => e.preventDefault(); // o jsdom também reimprime o erro como "não capturado"
    window.addEventListener('error', calar);
    try {
      renderPage(<div><MarketContextBand /><p>irmão continua na tela</p></div>);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.getByText('irmão continua na tela')).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'Agenda de eventos dos EUA' })).toBeNull();
    } finally {
      window.removeEventListener('error', calar);
      spy.mockRestore();
    }
  });

  it('ocultar: some, lembra a escolha e não faz requisição; mostrar volta', async () => {
    fetchMock.mockResolvedValue({ checkedAtMs: NOW, events: [ev('a', 'CPI', inH(5))] });
    const { unmount } = renderPage(<MarketContextBand />);
    await screen.findByText('CPI');
    fireEvent.click(screen.getByRole('button', { name: 'Ocultar agenda de eventos' }));
    expect(screen.queryByText('CPI')).toBeNull();
    expect(screen.getByRole('button', { name: /Mostrar agenda de eventos dos EUA/ })).toBeTruthy();
    expect(mem.get('sentinel_market_context_band_off')).toBe('1');

    // Nova montagem (outra visita ao painel): continua oculta e NÃO busca nada.
    unmount();
    fetchMock.mockClear();
    renderPage(<MarketContextBand />);
    expect(screen.getByRole('button', { name: /Mostrar agenda de eventos dos EUA/ })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Mostrar agenda de eventos dos EUA/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(mem.has('sentinel_market_context_band_off')).toBe(false);
  });
});
