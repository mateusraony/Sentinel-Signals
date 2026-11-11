// @vitest-environment jsdom
//
// Achado da varredura pós-Raio-X, Round 3 (2026-09-27): as 2 mensagens de
// erro deste componente ("Falha ao validar símbolo"/"Falha ao adicionar
// ativo") só diziam "tente novamente", sem explicar causa provável — mesmo
// padrão de causa/reassurance já usado em QueryErrorState.jsx. Componente
// não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import AddAssetForm from './AddAssetForm.jsx';

const validateSymbolMock = vi.fn();
vi.mock('@/lib/marketDataProvider', () => ({
  validateSymbol: (...args) => validateSymbolMock(...args),
}));

const createMock = vi.fn();
vi.mock('@/api/entities', () => ({
  backend: { entities: { MonitoredAsset: { create: (...args) => createMock(...args) } } },
}));

afterEach(() => { cleanup(); validateSymbolMock.mockReset(); createMock.mockReset(); });

describe('AddAssetForm — erros explicam causa provável (Round 3 pós-Raio-X)', () => {
  it('REGRESSÃO: falha ao validar símbolo mostra "verifique sua conexão e tente de novo"', async () => {
    validateSymbolMock.mockRejectedValueOnce(new Error('network down'));
    render(<AddAssetForm onSuccess={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('BTCUSDT'), { target: { value: 'BTCUSDT' } });
    fireEvent.click(screen.getByText('Validar'));

    await screen.findByText(/verifique sua conexão e tente de novo/);
  });

  it('REGRESSÃO: falha ao adicionar ativo mostra "verifique sua conexão e tente de novo"', async () => {
    createMock.mockRejectedValueOnce(new Error('network down'));
    render(<AddAssetForm onSuccess={vi.fn()} />);

    // Quick Add já marca validated=true, sem precisar chamar validateSymbol.
    fireEvent.click(screen.getByText('BTC/USDT'));
    fireEvent.click(screen.getByText('Adicionar Ativo'));

    await screen.findByText(/verifique sua conexão e tente de novo/);
  });
});

// Logo do token no cadastro (11/11/2026): o usuário perguntou "se eu adicionar um ativo novo, ele puxa o símbolo?". Resposta no próprio formulário: com logo na pasta o
// logo aparece; sem logo, avisa que o painel vai mostrar a bolinha com a inicial.
describe('AddAssetForm — logo do token', () => {
  async function validar(simbolo) {
    validateSymbolMock.mockResolvedValueOnce(true);
    const r = render(<AddAssetForm onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('BTCUSDT'), { target: { value: simbolo } });
    fireEvent.click(screen.getByText('Validar'));
    await screen.findByText('Símbolo válido na Binance');
    return r;
  }

  it('os botões de "Adicionar rápido" mostram o logo de cada par, sem mudar o nome do botão', () => {
    const { container } = render(<AddAssetForm onSuccess={vi.fn()} />);
    for (const t of ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK']) {
      expect(container.querySelector(`button img[data-token="${t}"]`), t).not.toBeNull();
      expect(screen.getByRole('button', { name: `${t}/USDT` })).toBeTruthy();
    }
  });

  it('REGRESSÃO: token que tem logo (ETH): depois de validar mostra o logo e NÃO fala de "sem logo"', async () => {
    const { container } = await validar('ETHUSDT');
    expect(container.querySelectorAll('img[data-token="ETH"]')).toHaveLength(2); // o botão de adicionar rápido e a prévia depois de validar
    expect(container.textContent).not.toMatch(/sem logo/i);
  });

  it('REGRESSÃO: token novo sem logo (ENA): mostra a bolinha com a inicial e AVISA que ainda não tem logo no painel', async () => {
    const { container } = await validar('enausdt');
    expect(container.querySelector('span[data-token="ENA"]')).not.toBeNull();
    expect(container.querySelector('img[data-token="ENA"]')).toBeNull();
    expect(screen.getByText(/ainda sem logo/i)).toBeTruthy();
  });

  it('antes de validar não mostra nada de logo para o texto digitado (evita a bolinha piscando a cada letra)', () => {
    const { container } = render(<AddAssetForm onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('BTCUSDT'), { target: { value: 'E' } });
    expect(container.querySelector('span[data-token="E"]')).toBeNull();
    expect(container.textContent).not.toMatch(/sem logo/i);
  });
});
