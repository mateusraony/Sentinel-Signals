// @vitest-environment jsdom
//
// Achado M-12 do Raio-X de UI/UX (Média Prioridade): Settings.jsx e
// PineScript.jsx editam os mesmos parâmetros (rng_per, minScore, ATR
// mult, TP1R etc.) sem nenhum aviso cruzado visível — só um comentário
// de código mencionava a duplicidade. Este teste prova o link novo no
// aviso já existente ("Alterações são aplicadas instantaneamente...").
// Componente não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';
import Settings from './Settings.jsx';

const CONFIG = {
  minScore: 75, tp1R: 1.5, tp1QtyPercent: 50, trailAtrMult: 1.5, atrLen: 14,
  rng_per: 20, rng_qty: 3.5, skip15mConfirmationEnabled: false, disableTp2CapEnabled: false,
};

vi.mock('@/lib/pineParser', () => ({
  getPineConfig: async () => CONFIG,
  getLocalPineConfig: () => CONFIG,
}));

vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      MonitoredAsset: { list: vi.fn(async () => []) },
      StrategyConfig: { set: vi.fn(async () => undefined) },
    },
  },
}));

// O slider do Radix (@radix-ui/react-use-size) exige ResizeObserver em
// runtime — jsdom não implementa, mesmo polyfill já usado em Dashboard.test.jsx.
beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(() => cleanup());

describe('Settings — aviso de alterações instantâneas linka pro Pine Script (achado M-12)', () => {
  it('REGRESSÃO: o aviso tem um link pra /pine, além do já existente pro Backtest', async () => {
    renderPage(<Settings />);

    const pineLink = await screen.findByRole('link', { name: 'Pine Script' });
    expect(pineLink.getAttribute('href')).toBe('/pine');

    const backtestLink = screen.getByRole('link', { name: 'Backtest' });
    expect(backtestLink.getAttribute('href')).toBe('/backtest');
  });
});
