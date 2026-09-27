// @vitest-environment jsdom
//
// Achado da varredura pós-Raio-X, Round 3 (2026-09-27): as 2 mensagens de
// erro deste componente ("Falha ao validar símbolo"/"Falha ao adicionar
// ativo") só diziam "tente novamente", sem explicar causa provável — mesmo
// padrão de causa/reassurance já usado em QueryErrorState.jsx. Componente
// não tinha teste dedicado antes.
import React from 'react';
import { describe, it, vi, afterEach } from 'vitest';
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
