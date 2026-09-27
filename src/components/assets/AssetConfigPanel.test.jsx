// @vitest-environment jsdom
//
// Achado M-17 do Raio-X de UI/UX (docs/known-risks.md item 230): RSI/MACD
// (labels de seção do form) e RF/SMC/MACD/EMA Cross/RSI (badges do
// MultiToggle "Origem do sinal") eram rótulos "nus" — sem tooltip
// explicando o termo. Componente não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient, makeFakeBackendModule } from '@/pages/__fixtures__/renderPage.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import AssetConfigPanel from './AssetConfigPanel.jsx';

vi.mock('@/api/entities', () => makeFakeBackendModule({ populated: false }));

afterEach(() => cleanup());

const ASSET = { id: 'a1', symbol: 'BTCUSDT' };

function renderPanel(props) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AssetConfigPanel asset={ASSET} onSave={vi.fn()} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('AssetConfigPanel — RSI/MACD e badges RF/SMC/MACD/EMA Cross/RSI têm tooltip explicando o termo (achado M-17)', () => {
  it('REGRESSÃO: labels de seção "RSI"/"MACD" são focáveis (têm tooltip); "Timeframes" continua sem', () => {
    renderPanel();
    // "RSI"/"MACD" aparecem 2x (label de seção do form + badge do MultiToggle
    // "Origem do sinal") — a label de seção é a que NÃO é um <button>.
    const rsiLabel = screen.getAllByText('RSI').find(el => el.tagName !== 'BUTTON' && !el.closest('button'));
    const macdLabel = screen.getAllByText('MACD').find(el => el.tagName !== 'BUTTON' && !el.closest('button'));
    expect(rsiLabel?.getAttribute('tabindex')).toBe('0');
    expect(macdLabel?.getAttribute('tabindex')).toBe('0');
    expect(screen.getByText('Timeframes').getAttribute('tabindex')).toBeNull();
  });

  it('REGRESSÃO: badges "Origem do sinal" (RF/SMC/MACD Cross/EMA Cross/RSI) são focáveis; BUY/SELL continuam sem', () => {
    renderPanel();
    for (const label of ['RF', 'SMC', 'EMA Cross']) {
      const btn = screen.getByText(label).closest('button');
      expect(btn?.getAttribute('tabindex')).toBe('0');
    }
    // "MACD" e "RSI" aparecem 2x (label de seção + badge) — pega o badge (é um <button>).
    const macdBadge = screen.getAllByText('MACD').map(el => el.closest('button')).find(Boolean);
    const rsiBadge = screen.getAllByText('RSI').map(el => el.closest('button')).find(Boolean);
    expect(macdBadge?.getAttribute('tabindex')).toBe('0');
    expect(rsiBadge?.getAttribute('tabindex')).toBe('0');
    expect(screen.getByText('🟢 BUY').closest('button')?.getAttribute('tabindex')).toBeNull();
  });
});

// Achado da varredura pós-Raio-X, Round 3 (2026-09-27): erro genérico
// "tente novamente" sem explicar causa provável — mesmo padrão de
// causa/reassurance já usado em QueryErrorState.jsx.
describe('AssetConfigPanel — erro ao salvar explica causa provável (Round 3 pós-Raio-X)', () => {
  afterEach(() => { vi.doUnmock('@/api/entities'); vi.resetModules(); });

  it('REGRESSÃO: mostra "verifique sua conexão e tente de novo" quando o save falha', async () => {
    vi.doMock('@/api/entities', () => ({
      backend: { entities: { MonitoredAsset: { update: vi.fn(async () => { throw new Error('network down'); }) } } },
    }));
    vi.resetModules();
    const { default: AssetConfigPanelFresh } = await import('./AssetConfigPanel.jsx');
    const client = makeTestQueryClient();
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <AssetConfigPanelFresh asset={ASSET} onSave={vi.fn()} />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText('Salvar Configurações'));
    await waitFor(() => expect(screen.getByText(/verifique sua conexão e tente de novo/)).toBeTruthy());
  });
});
