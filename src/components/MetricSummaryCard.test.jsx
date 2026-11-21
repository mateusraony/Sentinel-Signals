// @vitest-environment jsdom
//
// MetricSummaryCard — modo `flat` (21/11/2026): cartão plano da aba Trades (sem ícone, sem brilho no canto, rótulo em frase
// normal). O modo padrão (Backtest, Relatório Mensal) NÃO muda: continua com ícone e brilho. Estes testes provam os dois lados.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Target } from 'lucide-react';
import { MetricSummaryCard } from './MetricSummaryCard.jsx';

afterEach(cleanup);

const renderCard = (props) => render(
  <TooltipProvider>
    <MetricSummaryCard icon={Target} label="Taxa de Acerto" value="51.1%" sublabel="24W · 1BE · 22L" color="#5db586" glowColor="rgba(93,181,134,0.4)" {...props} />
  </TooltipProvider>,
);

describe('MetricSummaryCard — modo plano (aba Trades)', () => {
  it('mostra rótulo, valor e legenda, sem ícone e sem o brilho no canto', () => {
    const { container } = renderCard({ flat: true });
    expect(screen.getByText('Taxa de Acerto')).toBeTruthy();
    expect(screen.getByText('51.1%')).toBeTruthy();
    expect(screen.getByText('24W · 1BE · 22L')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.innerHTML).not.toMatch(/radial-gradient/);
  });

  it('rótulo em frase normal (nada de maiúsculas espaçadas) e número em peso médio', () => {
    const { container } = renderCard({ flat: true });
    expect(screen.getByText('Taxa de Acerto').className).not.toMatch(/uppercase|tracking-/);
    expect(container.innerHTML).toMatch(/font-medium/);
    expect(container.innerHTML).not.toMatch(/font-bold/);
  });

  it('a cor do número vem da prop `color`', () => {
    renderCard({ flat: true, color: '#e06a5b' });
    expect(screen.getByText('51.1%').style.color).toBe('rgb(224, 106, 91)');
  });

  it('className do chamador chega ao cartão (larguras diferentes no resumo)', () => {
    const { container } = renderCard({ flat: true, className: 'lg:col-span-4' });
    expect(container.firstChild.className).toMatch(/lg:col-span-4/);
  });

  it('com dica, o rótulo é focável por teclado e sublinhado (mesmo comportamento de sempre)', () => {
    renderCard({ flat: true, tooltip: 'explica o termo' });
    const trigger = screen.getByText('Taxa de Acerto').closest('button');
    expect(trigger?.className).toMatch(/cursor-help/);
  });

  it('sem legenda não desenha o espaço dela', () => {
    renderCard({ flat: true, sublabel: undefined });
    expect(screen.queryByText('24W · 1BE · 22L')).toBeNull();
  });
});

describe('MetricSummaryCard — modo padrão NÃO mudou (Backtest e Relatório Mensal)', () => {
  it('continua com o ícone e o brilho decorativo no canto', () => {
    const { container } = renderCard({});
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.innerHTML).toMatch(/radial-gradient/);
    expect(screen.getByText('Taxa de Acerto').className).toMatch(/uppercase/);
  });
});
