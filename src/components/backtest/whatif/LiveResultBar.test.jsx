// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import LiveResultBar from './LiveResultBar.jsx';
import { compareSummaries } from '@/lib/whatIf';

afterEach(() => cleanup());
const sum = (o) => ({ expectancyR: 0.1, winRate: 50, profitFactor: 1.2, maxDrawdownPct: 3, counted: 30, ciHalfWidth: 0.3, ...o });

describe('LiveResultBar — resultado ao vivo grudado no topo', () => {
  it('sem comparação (ainda não há resultado) não desenha nada', () => {
    const { container } = render(<LiveResultBar cmp={null} isDefault stale={false} auto changedCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('no padrão: mostra os 5 números e "padrão" (sem setas)', () => {
    const cmp = compareSummaries(sum(), sum());
    render(<LiveResultBar cmp={cmp} isDefault stale={false} auto changedCount={0} />);
    const bar = screen.getByRole('region', { name: 'Resultado ao vivo' });
    expect(within(bar).getByText('no padrão')).toBeTruthy();
    for (const l of ['Expectância', 'Acerto', 'PF', 'Drawdown', 'Operações']) expect(within(bar).getByText(l)).toBeTruthy();
    expect(within(bar).getAllByText('padrão')).toHaveLength(5);
    expect(bar.textContent).not.toMatch(/▲|▼/);
  });

  it('mexido: mostra a diferença com seta e diz se cabe na margem de erro', () => {
    const cmp = compareSummaries(sum({ expectancyR: 0.15, winRate: 55 }), sum());
    render(<LiveResultBar cmp={cmp} isDefault={false} stale={false} auto changedCount={2} />);
    const bar = screen.getByRole('region', { name: 'Resultado ao vivo' });
    expect(within(bar).getByText('2 parâmetros diferentes do padrão')).toBeTruthy();
    expect(bar.textContent).toMatch(/▲ \+0\.05R/);
    expect(bar.textContent).toMatch(/cabe na margem de erro/);
  });

  it('diferença maior que o ruído avisa para confirmar em outro período', () => {
    const cmp = compareSummaries(sum({ expectancyR: 0.9 }), sum());
    render(<LiveResultBar cmp={cmp} isDefault={false} stale={false} auto changedCount={1} />);
    expect(screen.getByRole('region', { name: 'Resultado ao vivo' }).textContent).toMatch(/passa da margem de erro — confirme em outro período/);
  });

  it('desatualizado: automático diz "recalculando…"; manual diz para clicar em Executar', () => {
    const cmp = compareSummaries(sum({ expectancyR: 0.15 }), sum());
    const { rerender } = render(<LiveResultBar cmp={cmp} isDefault={false} stale auto changedCount={1} />);
    expect(screen.getByRole('status').textContent).toMatch(/recalculando…/);
    rerender(<LiveResultBar cmp={cmp} isDefault={false} stale auto={false} changedCount={1} />);
    expect(screen.getByRole('status').textContent).toMatch(/desatualizado: clique em Executar/);
  });

  it('fica grudada logo abaixo da barra do painel (top-14, sticky) e acima do resto', () => {
    const cmp = compareSummaries(sum(), sum());
    render(<LiveResultBar cmp={cmp} isDefault stale={false} auto changedCount={0} />);
    const cls = screen.getByRole('region', { name: 'Resultado ao vivo' }).className;
    expect(cls).toMatch(/\bsticky\b/);
    expect(cls).toMatch(/top-14/);
  });
});
