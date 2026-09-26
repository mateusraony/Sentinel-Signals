// @vitest-environment jsdom
//
// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 2ª sub-rodada): o filtro "Buscar símbolo..." usava `outline-none` sem
// substituto visível de foco — mesmo achado/fix já aplicado em
// TriggerBacktestPanel.jsx (1ª sub-rodada). Página não tinha teste
// dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';
import Alerts from './Alerts.jsx';

// `populated` precisa ser trocável por describe (o teste de A-7 abaixo
// precisa de 1 sinal real pra ter uma linha clicável pra focar) — mesmo
// padrão `vi.hoisted` + import dinâmico já usado em pagesSmoke.test.jsx.
const estadoBackend = vi.hoisted(() => ({ populated: false }));
vi.mock('@/api/entities', async () => {
  const { makeFakeBackendModule } = await import('./__fixtures__/renderPage.jsx');
  return { get backend() { return makeFakeBackendModule({ populated: estadoBackend.populated }).backend; } };
});

afterEach(cleanup);

describe('Alerts — filtro "Buscar símbolo..." tem foco visível (achado A-7)', () => {
  it('REGRESSÃO: input tem focus-visible:ring', async () => {
    estadoBackend.populated = false;
    renderPage(<Alerts />);
    const search = await screen.findByPlaceholderText('Buscar símbolo...');
    expect(search.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });
});

// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 3ª sub-rodada): a linha de alerta clicável não tinha `role`,
// `tabIndex` nem `onKeyDown` — mesmo padrão já resolvido em
// RecentAlertsList.jsx na mesma rodada.
//
// Sem `role="button"` de propósito (achado do Codex review no PR #419): a
// linha contém um `<button>` real (dispensar) — `role="button"` no pai
// tornaria os filhos "presentational" pra árvore de acessibilidade,
// escondendo o botão de dispensar como controle próprio. `tabIndex` +
// `onKeyDown` já bastam pra foco/ativação por teclado.
describe('Alerts — linha de alerta é focável e ativável por teclado (achado A-7)', () => {
  it('REGRESSÃO: linha tem tabIndex=0 (sem role="button", por ter um <button> real dentro) e Enter abre o detalhe', async () => {
    estadoBackend.populated = true;
    renderPage(<Alerts />);
    const symbol = await screen.findByText('BTC/USDT');
    const row = symbol.closest('[tabindex]');
    expect(row).toBeTruthy();
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    await screen.findByRole('dialog');
  });
});

// Achado M-17 do Raio-X de UI/UX (glossário de termos técnicos): os botões
// de filtro "Fonte" e o badge de fonte no card do alerta eram siglas/termos
// técnicos "nus" (Range Filter/SMC Structure/RSI/MACD/EMA Cross) — sem
// tooltip explicando o termo. `.closest('.cursor-help')`, não
// `.closest('[tabindex]')`, porque a própria linha do alerta já é
// `tabIndex={0}` (achado A-7 acima) — usar o seletor genérico daria falso
// positivo (achado já documentado em item 229/230 desta sessão).
describe('Alerts — botões de filtro "Fonte" e badge do card têm tooltip explicando o termo (achado M-17)', () => {
  it('REGRESSÃO: botão de filtro "Range Filter" é focável com tooltip; "Todas Fontes" continua sem', () => {
    estadoBackend.populated = false;
    renderPage(<Alerts />);
    const rf = screen.getByText('Range Filter').closest('.cursor-help');
    expect(rf?.getAttribute('tabindex')).toBe('0');
    expect(screen.getByText('Todas Fontes').closest('.cursor-help')).toBeNull();
  });

  it('REGRESSÃO: badge de fonte do card ("Range Filter") é focável com tooltip', async () => {
    estadoBackend.populated = true;
    renderPage(<Alerts />);
    await screen.findByText('BTC/USDT');
    // "Range Filter" aparece 2x: botão de filtro + badge do card — o badge
    // é o que NÃO tem onClick de filtro (mesmo texto visível, instância
    // diferente); confirmamos que AMBAS as instâncias visíveis viraram
    // gatilho focável (o achado cobre os 2 pontos).
    const instancias = screen.getAllByText('Range Filter').map(el => el.closest('.cursor-help'));
    expect(instancias.every(el => el?.getAttribute('tabindex') === '0')).toBe(true);
    expect(instancias.length).toBe(2);
  });
});
