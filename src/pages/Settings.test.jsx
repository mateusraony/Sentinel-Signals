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
import { screen, cleanup, fireEvent } from '@testing-library/react';
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

const strategyConfigSetMock = vi.fn(async () => undefined);
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      MonitoredAsset: { list: vi.fn(async () => []) },
      StrategyConfig: { set: (...args) => strategyConfigSetMock(...args) },
    },
  },
}));

const logErrorMock = vi.fn();
vi.mock('@/lib/logger', () => ({
  logInfo: vi.fn(),
  logError: (...args) => logErrorMock(...args),
}));

// O slider do Radix (@radix-ui/react-use-size) exige ResizeObserver em
// runtime — jsdom não implementa, mesmo polyfill já usado em Dashboard.test.jsx.
beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(() => { cleanup(); strategyConfigSetMock.mockClear(); logErrorMock.mockClear(); });

describe('Settings — aviso de alterações instantâneas linka pro Pine Script (achado M-12)', () => {
  it('REGRESSÃO: o aviso tem um link pra /pine, além do já existente pro Backtest', async () => {
    renderPage(<Settings />);

    const pineLink = await screen.findByRole('link', { name: 'Pine Script' });
    expect(pineLink.getAttribute('href')).toBe('/pine');

    const backtestLink = screen.getByRole('link', { name: 'Backtest' });
    expect(backtestLink.getAttribute('href')).toBe('/backtest');
  });
});

// Refinamentos (seção E do Raio-X): "Configuração Ativa" repetia, pill a
// pill, o mesmo valor já visível ao lado do slider correspondente mais
// acima na mesma tela — removida por ser redundante, sem substituto.
describe('Settings — seção "Configuração Ativa" removida (Refinamentos)', () => {
  it('REGRESSÃO: não existe mais a seção de pills redundante com os sliders', async () => {
    renderPage(<Settings />);

    await screen.findByRole('link', { name: 'Pine Script' });
    expect(screen.queryByText('Configuração Ativa (lida pelo scanner):')).toBeNull();
  });
});

// Achado da varredura pós-Raio-X, Round 3 (2026-09-27): o erro de salvar
// desaparecia em 3s sem dizer por quê nem o que fazer, e sem nenhum log
// (arquivo não importava logError). Fix: causa provável + reassurance
// (mesmo padrão de QueryErrorState.jsx) + logError.
describe('Settings — erro ao salvar explica causa provável e é logado (Round 3 pós-Raio-X)', () => {
  it('REGRESSÃO: mostra "verifique sua conexão" e chama logError quando o save falha', async () => {
    strategyConfigSetMock.mockRejectedValueOnce(new Error('network down'));
    renderPage(<Settings />);

    fireEvent.click(await screen.findByText('Restaurar'));
    fireEvent.click(screen.getByText('Salvar & Sincronizar'));

    await screen.findByText(/verifique sua conexão e tente de novo/);
    expect(logErrorMock).toHaveBeenCalledWith('Settings', 'Falha ao salvar ajustes finos', { error: 'network down' });
  });
});

// 22/11/2026 — Ajustes refeito (estrutura, não só cor): ações e estado no topo, uma só nota, "padrão X" em cada controle,
// flags de fidelidade em 2 colunas. A lógica de salvar (só as chaves tocadas) NÃO mudou — o teste antigo de erro segue valendo.
describe('Settings — estrutura nova (22/11/2026)', () => {
  it('o topo mostra o estado das alterações e as ações (Restaurar e Salvar) juntas', async () => {
    renderPage(<Settings />);
    const estado = await screen.findByText('sem alterações pendentes');
    expect(estado.parentElement).toBe(screen.getByText('Restaurar').closest('button').parentElement);
    expect(screen.getByText('Salvar & Sincronizar').closest('button').parentElement).toBe(estado.parentElement);
  });

  it('mexer num controle vira "1 alteração não salva", e o controle mostra o padrão marcado como diferente', async () => {
    renderPage(<Settings />);
    await screen.findByText('sem alterações pendentes');
    expect(screen.getAllByText(/^padrão /).length).toBeGreaterThan(0);
    const slider = screen.getAllByRole('slider')[5]; // Score Mínimo (6º: rng_per, rng_qty, ATR, TP1 em R, % TP1, Score)
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(await screen.findByText('1 alteração não salva')).toBeTruthy();
    expect(screen.getByText(/^● padrão 75$/)).toBeTruthy();
  });

  it('a nota "aplicado no próximo scan" aparece uma vez só (antes eram 3: subtítulo, selo e faixa amarela)', async () => {
    renderPage(<Settings />);
    await screen.findByText('sem alterações pendentes');
    expect(screen.getAllByText(/aplicad[oa]s? instantaneamente/i)).toHaveLength(1);
  });

  it('as 2 flags de fidelidade ao TradingView ficam sob um título próprio, em 2 colunas', async () => {
    renderPage(<Settings />);
    await screen.findByText('sem alterações pendentes');
    const titulo = screen.getByRole('heading', { name: 'Fidelidade ao TradingView' });
    const grade = titulo.parentElement.nextElementSibling;
    expect(grade.className).toMatch(/md:grid-cols-2/);
    expect(grade.querySelectorAll('[role="switch"]')).toHaveLength(2);
  });
});
