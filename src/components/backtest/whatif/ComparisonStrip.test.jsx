// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ComparisonStrip from './ComparisonStrip';
import { compareSummaries } from '@/lib/whatIf';

afterEach(() => cleanup());
const S = (over = {}) => ({ expectancyR: 0.12, winRate: 50, profitFactor: 1.4, maxDrawdownPct: 6, counted: 20, ciHalfWidth: 0.25, ...over });

describe('ComparisonStrip', () => {
  it('parâmetros iguais ao padrão: só diz isso, sem setas', () => {
    render(<ComparisonStrip cmp={compareSummaries(S(), S())} isDefault stale={false} />);
    expect(screen.getByText(/Os parâmetros são os do padrão/)).toBeTruthy();
    expect(screen.queryByText(/▲|▼/)).toBeNull();
  });
  it('mexeu mas NENHUMA operação mudou: diz "resultado idêntico", não "diferença cabe na margem de erro"', () => {
    render(<ComparisonStrip cmp={compareSummaries(S(), S())} isDefault={false} stale={false} />);
    expect(screen.getByText(/não mudou nenhuma operação nesta janela: o resultado é idêntico/)).toBeTruthy();
    expect(screen.queryByText(/margem de erro/)).toBeNull();
  });
  it('mexeu e mudou: setas coloridas e a leitura da margem de erro (dentro do ruído × além do ruído)', () => {
    const inNoise = compareSummaries(S({ expectancyR: 0.15 }), S());
    render(<ComparisonStrip cmp={inNoise} isDefault={false} stale={false} />);
    expect(screen.getByText(/cabe na margem de erro \(±0\.25R\)/)).toBeTruthy();
    expect(screen.getAllByText(/▲|▼/).length).toBeGreaterThan(0);
    cleanup();
    render(<ComparisonStrip cmp={compareSummaries(S({ expectancyR: 0.9 }), S())} isDefault={false} stale={false} />);
    expect(screen.getByText(/maior que a margem de erro/)).toBeTruthy();
  });
  it('drawdown zero aparece como "0.0%", nunca "-0.0%"', () => {
    render(<ComparisonStrip cmp={compareSummaries(S({ maxDrawdownPct: 0 }), S({ maxDrawdownPct: 0 }))} isDefault stale={false} />);
    expect(screen.getAllByText('0.0%').length).toBeGreaterThan(0);
    expect(screen.queryByText('-0.0%')).toBeNull();
  });
  it('amostra pequena demais para medir o ruído: avisa, não afirma', () => {
    render(<ComparisonStrip cmp={compareSummaries(S({ expectancyR: 0.5, ciHalfWidth: null }), S({ ciHalfWidth: null }))} isDefault={false} stale={false} />);
    expect(screen.getByText(/Poucas operações para medir a margem de erro/)).toBeTruthy();
  });
});
