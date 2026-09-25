// @vitest-environment jsdom
//
// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// pendente de numeração — 1ª sub-rodada, escolhida como piloto por ser um
// único arquivo com o mesmo padrão mecânico repetido 6x): os 6 campos deste
// painel (`Rótulo do teste`, `De`, `Até`, `Símbolos`, `Mínimo de operações`,
// `Overrides de pineConfig`) usavam `outline-none` sem nenhum substituto
// visível de foco — `src/index.css` só recolore o outline padrão do
// navegador (`outline-ring/50`), não força `outline-style`, então
// `outline-none` sozinho apaga o único indicador de foco que existiria.
// Corrigido reusando o padrão já em produção em `Assets.jsx`/`Logs.jsx`/
// `Dashboard.jsx`/`PineScript.jsx`: `focus-visible:ring-1
// focus-visible:ring-ring` ao lado do `outline-none` (mantém o reset do
// outline padrão feio do navegador, mas troca por um anel visível
// só-quando-navegando-por-teclado).
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import TriggerBacktestPanel from './TriggerBacktestPanel.jsx';

vi.mock('@/lib/apiBackend', () => ({
  callBackend: vi.fn(async () => ({ status: 'in_progress' })),
}));

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('TriggerBacktestPanel — campos usam focus-visible:ring em vez de outline-none puro (achado A-7)', () => {
  it('REGRESSÃO: "Rótulo do teste" tem foco visível', async () => {
    render(<TriggerBacktestPanel onReportReady={() => {}} />);
    const input = await screen.findByPlaceholderText('ex.: bull-baseline');
    expect(input.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });

  it('REGRESSÃO: "De" e "Até" têm foco visível', async () => {
    const { container } = render(<TriggerBacktestPanel onReportReady={() => {}} />);
    const dateInputs = container.querySelectorAll('input[type="date"]');
    expect(dateInputs).toHaveLength(2);
    dateInputs.forEach((input) => {
      expect(input.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
    });
  });

  it('REGRESSÃO: campos avançados ("Símbolos", "Mínimo de operações", "Overrides de pineConfig") têm foco visível', async () => {
    render(<TriggerBacktestPanel onReportReady={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /avançado/i }));

    const symbols = await screen.findByPlaceholderText('BTCUSDT,ETHUSDT,...');
    expect(symbols.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);

    const minTrades = screen.getByPlaceholderText('30');
    expect(minTrades.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);

    const pineConfig = screen.getByPlaceholderText('{"minScore":80}');
    expect(pineConfig.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });
});
