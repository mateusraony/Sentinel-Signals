// @vitest-environment jsdom
//
// Relatório mensal refeito (23/11/2026): estrutura nova + leitura do mês em português. Estes testes cobrem o que o usuário vê e os ESTADOS
// ESCONDIDOS/RAROS (carregando, falha, mês vazio com operações abertas, filtros da tabela, "mostrar todas", mês anterior sem dado).
import React from 'react';
import moment from 'moment';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, within, waitFor, fireEvent } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';
import MonthlyReport from './MonthlyReport.jsx';

const filterMock = vi.fn(async () => []);
vi.mock('@/api/entities', () => ({
  backend: { entities: { TradeOperation: { filter: (...args) => filterMock(...args) } } },
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

afterEach(() => {
  cleanup();
  filterMock.mockReset();
  filterMock.mockImplementation(async () => []);
});

const CUR = moment().format('YYYY-MM');
const day = (h) => moment().startOf('month').add(1, 'day').add(h, 'hours').toISOString();
const mk = (id, symbol, exit, status = 'TP2_HIT', extra = {}) => ({
  id, asset_id: id, symbol, side: 'BUY', status, entry_price: 100, initial_stop: 90, current_stop: 90,
  tp1: 110, tp2: 120, exit_price: exit, created_date: day(0), closed_at: day(5), ...extra,
});
// Mock que responde por MÊS (o gte da consulta diz qual é).
const byMonth = (map) => async (filters) => {
  const key = moment(filters.created_date.gte).format('YYYY-MM');
  return map[key] ?? [];
};
const prevKey = moment().subtract(1, 'month').format('YYYY-MM');

describe('Relatório mensal — leitura do mês', () => {
  it('mês positivo com amostra pequena: diz que não prova vantagem', async () => {
    filterMock.mockImplementation(async () => [mk('1', 'BTCUSDT', 112), mk('2', 'ETHUSDT', 90, 'STOP_HIT'), mk('3', 'SOLUSDT', 112)]);
    renderPage(<MonthlyReport />);
    const status = await screen.findByRole('status', { name: 'Leitura do mês' });
    await within(status).findByText(/^Mês positivo: \+/);
    expect(within(status).getByText(/Amostra pequena: 3 operações contadas/)).toBeTruthy();
    expect(within(status).getByText(/mês ainda está em andamento/)).toBeTruthy();
  });

  it('mês em andamento é dito no cabeçalho; mês passado não', async () => {
    filterMock.mockImplementation(async () => [mk('1', 'BTCUSDT', 112)]);
    renderPage(<MonthlyReport />);
    await screen.findByText('mês em andamento', { exact: false });
    fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }));
    await waitFor(() => expect(screen.queryByText(/· mês em andamento/)).toBeNull());
  });

  it('CARREGANDO: leitura diz "Lendo…" e os números mostram "—", nunca 0', async () => {
    filterMock.mockImplementation(() => new Promise(() => {}));
    renderPage(<MonthlyReport />);
    const status = await screen.findByRole('status', { name: 'Leitura do mês' });
    expect(within(status).getByText('Lendo as operações do mês…')).toBeTruthy();
    const card = screen.getByText('Operações').closest('.glass-card');
    expect(within(card).getByText('—')).toBeTruthy();
    expect(within(card).queryByText('0')).toBeNull();
    expect(screen.queryByText(/Nenhuma operação fechada/)).toBeNull();
  });

  it('FALHA ao carregar: não afirma "nenhuma operação"; mostra "—" e botão de tentar de novo', async () => {
    filterMock.mockImplementation(async () => { throw new Error('rede'); });
    renderPage(<MonthlyReport />);
    await screen.findByText('Não foi possível ler as operações deste mês');
    expect(screen.queryByText(/Nenhuma operação fechada/)).toBeNull();
    const card = screen.getByText('Operações').closest('.glass-card');
    expect(within(card).getByText('—')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Tentar de novo/ })).toBeTruthy();
    // o PDF e o Copiar ficam desligados sem dado
    expect(screen.getByRole('button', { name: /Exportar PDF/ }).disabled).toBe(true);
  });

  it('mês sem operação fechada, mas com abertas: explica que as abertas não entram', async () => {
    filterMock.mockImplementation(async () => [mk('1', 'BTCUSDT', null, 'SIGNAL_CONFIRMED', { exit_price: null, closed_at: null }), mk('2', 'ETHUSDT', null, 'RUNNER_ACTIVE', { exit_price: null, closed_at: null })]);
    renderPage(<MonthlyReport />);
    await screen.findByText(/2 operações abertas neste mês ainda não fecharam/);
    expect(screen.getByText(/Nenhuma operação fechada em/)).toBeTruthy();
  });

  it('mês carregado e vazio: sem cartões de número (não há o que mostrar) e "Operações" não aparece como 0 solto', async () => {
    filterMock.mockImplementation(async () => []);
    renderPage(<MonthlyReport />);
    await screen.findByText(/Nenhuma operação fechada em/);
    expect(screen.queryByText('Profit Factor')).toBeNull();
    expect(screen.queryByText('P&L acumulado')).toBeNull();
  });

  it('nomes de mês em português (o moment do projeto não tem locale): cabeçalho minúsculo, lista capitalizada', async () => {
    filterMock.mockImplementation(async () => [mk('1', 'BTCUSDT', 112)]);
    renderPage(<MonthlyReport />);
    const expected = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    await screen.findByText(`abertas em ${expected}`);
    const select = screen.getByRole('combobox');
    expect(select.options[0].textContent).toBe(expected.charAt(0).toUpperCase() + expected.slice(1));
    expect(select.options[0].textContent).toMatch(/ de \d{4}$/);
  });

  it('nota de operações abertas aparece junto da leitura quando há fechadas E abertas', async () => {
    filterMock.mockImplementation(async () => [mk('1', 'BTCUSDT', 112), mk('2', 'ETHUSDT', null, 'RUNNER_ACTIVE', { exit_price: null, closed_at: null })]);
    renderPage(<MonthlyReport />);
    await screen.findByText(/1 operação aberta neste mês ainda não fechou e não entra/);
  });
});

describe('Relatório mensal — operações fechadas sem resultado medível (achado do Codex, PR #619)', () => {
  const legado = (id) => ({ id, asset_id: id, symbol: 'BTCUSDT', side: 'BUY', status: 'CLOSED', entry_price: 100, created_date: day(0), closed_at: day(2) });

  it('não mostra +0.00% / 0% de acerto: leitura diz que não dá para medir e os cartões ficam em "—"', async () => {
    filterMock.mockImplementation(async () => [legado('a'), legado('b')]);
    const { container } = renderPage(<MonthlyReport />);
    const status = await screen.findByRole('status', { name: 'Leitura do mês' });
    await within(status).findByText('2 operações fechadas, mas nenhuma com resultado que dê para medir');
    const card = screen.getByText('P&L acumulado').closest('.glass-card');
    expect(within(card).getByText('—')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\+0\.00%/);
    // a tabela das operações continua visível (o usuário vê o que existe)
    expect(screen.getByRole('region', { name: 'Operações do mês' })).toBeTruthy();
    // e nenhum bloco de agregados
    expect(screen.queryByRole('region', { name: 'De onde veio o resultado' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Como terminaram' })).toBeNull();
  });

  it('mês anterior sem resultado medível: sem comparação (não marca "melhorou")', async () => {
    filterMock.mockImplementation(byMonth({ [CUR]: [mk('1', 'BTCUSDT', 112)], [prevKey]: [legado('p')] }));
    renderPage(<MonthlyReport />);
    await screen.findByText(/não teve operação fechada com resultado medível, então não há com o que comparar/);
    expect(screen.queryAllByLabelText('melhorou')).toHaveLength(0);
  });
});

describe('Relatório mensal — mês × mês anterior', () => {
  it('mostra a comparação quando os dois meses têm operação fechada', async () => {
    filterMock.mockImplementation(byMonth({ [CUR]: [mk('1', 'BTCUSDT', 112)], [prevKey]: [mk('2', 'ETHUSDT', 90, 'STOP_HIT')] }));
    renderPage(<MonthlyReport />);
    const sec = await screen.findByRole('region', { name: 'Este mês e o anterior' });
    await within(sec).findByText('Resultado do mês');
    expect(within(sec).getByText('Pior trecho')).toBeTruthy();
    expect(within(sec).getAllByLabelText('melhorou').length).toBeGreaterThan(0);
  });

  it('mês anterior vazio: diz que não há com o que comparar', async () => {
    filterMock.mockImplementation(byMonth({ [CUR]: [mk('1', 'BTCUSDT', 112)] }));
    renderPage(<MonthlyReport />);
    await screen.findByText(/não teve operação fechada com resultado medível, então não há com o que comparar/);
  });

  it('falha SÓ no mês anterior: o resto da tela segue e a comparação some com aviso', async () => {
    filterMock.mockImplementation(async (filters) => {
      if (moment(filters.created_date.gte).format('YYYY-MM') === prevKey) throw new Error('rede');
      return [mk('1', 'BTCUSDT', 112)];
    });
    renderPage(<MonthlyReport />);
    await screen.findByText(/Não foi possível ler o mês anterior/);
    expect(screen.getByRole('status', { name: 'Leitura do mês' }).textContent).toMatch(/Mês positivo/);
  });
});

describe('Relatório mensal — navegação de mês', () => {
  it('"Próximo mês" fica desligado no mês atual e "Mês anterior" muda a consulta', async () => {
    filterMock.mockImplementation(async () => [mk('1', 'BTCUSDT', 112)]);
    renderPage(<MonthlyReport />);
    await screen.findByRole('status', { name: 'Leitura do mês' });
    expect(screen.getByRole('button', { name: 'Próximo mês' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Próximo mês' }).disabled).toBe(false));
    const months = filterMock.mock.calls.map(c => moment(c[0].created_date.gte).format('YYYY-MM'));
    expect(months).toContain(prevKey);
    expect(months).toContain(moment().subtract(2, 'month').format('YYYY-MM')); // o anterior do mês escolhido
  });

  it('no último mês da lista (12 meses atrás) "Mês anterior" desliga', async () => {
    renderPage(<MonthlyReport />);
    const select = await screen.findByRole('combobox');
    const last = [...select.options].pop().value;
    fireEvent.change(select, { target: { value: last } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mês anterior' }).disabled).toBe(true));
  });
});

describe('Relatório mensal — tabela de operações (partes escondidas)', () => {
  const many = Array.from({ length: 20 }, (_, i) => mk(`w${i}`, 'BTCUSDT', 112, 'TP2_HIT', { created_date: day(i), closed_at: day(i + 1) }));
  const mixed = [...many, mk('l1', 'ETHUSDT', 90, 'STOP_HIT'), mk('l2', 'SOLUSDT', 90, 'STOP_HIT')];

  it('mostra 15 linhas e "Mostrar todas" revela o resto', async () => {
    filterMock.mockImplementation(async () => mixed);
    renderPage(<MonthlyReport />);
    const sec = await screen.findByRole('region', { name: 'Operações do mês' });
    await within(sec).findByRole('button', { name: /Mostrar todas as 22 operações/ });
    expect(within(sec).getAllByRole('row').length).toBe(1 + 15); // cabeçalho + 15
    fireEvent.click(within(sec).getByRole('button', { name: /Mostrar todas as 22 operações/ }));
    expect(within(sec).getAllByRole('row').length).toBe(1 + 22);
    expect(within(sec).getByRole('button', { name: /Mostrar só as 15 primeiras/ })).toBeTruthy();
  });

  it('filtro por resultado mostra só perdas, com contagens nos botões', async () => {
    filterMock.mockImplementation(async () => mixed);
    renderPage(<MonthlyReport />);
    const sec = await screen.findByRole('region', { name: 'Operações do mês' });
    await within(sec).findByRole('button', { name: 'Perdas (2)' });
    expect(within(sec).getByRole('button', { name: 'Ganhos (20)' })).toBeTruthy();
    fireEvent.click(within(sec).getByRole('button', { name: 'Perdas (2)' }));
    expect(within(sec).getAllByRole('row').length).toBe(1 + 2);
    expect(within(sec).queryByRole('button', { name: /Mostrar todas/ })).toBeNull();
  });

  it('filtro sem nenhuma operação daquele tipo diz isso (não deixa a tabela muda)', async () => {
    filterMock.mockImplementation(async () => [mk('1', 'BTCUSDT', 112)]);
    renderPage(<MonthlyReport />);
    const sec = await screen.findByRole('region', { name: 'Operações do mês' });
    await within(sec).findByRole('button', { name: 'Empates (0)' });
    fireEvent.click(within(sec).getByRole('button', { name: 'Empates (0)' }));
    expect(within(sec).getByText('Nenhuma operação deste tipo no mês.')).toBeTruthy();
  });

  it('operação encerrada por Time Stop mostra o motivo, não só "Encerrado"', async () => {
    filterMock.mockImplementation(async () => [mk('1', 'BTCUSDT', 101, 'CLOSED', { closed_reason: 'TIME_STOP' })]);
    const { container } = renderPage(<MonthlyReport />);
    await screen.findByText('⏱ Time stop');
    expect([...container.querySelectorAll('td')].some(td => td.textContent === '⏱ Time stop')).toBe(true);
  });
});

describe('Relatório mensal — de onde veio o resultado', () => {
  it('soma por ativo e por lado; "mostrar todos" só aparece com mais de 6 ativos', async () => {
    const ops = ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT', 'EUSDT', 'FUSDT', 'GUSDT', 'HUSDT'].map((s, i) => mk(`o${i}`, s, 112));
    filterMock.mockImplementation(async () => [...ops, mk('s1', 'AUSDT', 90, 'STOP_HIT', { side: 'SELL', initial_stop: 110, current_stop: 110 })]);
    renderPage(<MonthlyReport />);
    const sec = await screen.findByRole('region', { name: 'De onde veio o resultado' });
    await within(sec).findByRole('button', { name: 'Mostrar todos os 8 ativos' });
    expect(within(sec).getByText('Compras (BUY)')).toBeTruthy();
    expect(within(sec).getByText('Vendas (SELL)')).toBeTruthy();
    fireEvent.click(within(sec).getByRole('button', { name: 'Mostrar todos os 8 ativos' }));
    expect(within(sec).getByRole('button', { name: /Mostrar só os 6 primeiros/ })).toBeTruthy();
    expect(within(sec).getByText('H')).toBeTruthy();
  });
});

describe('Relatório mensal — "Como ler" e cartões', () => {
  it('"Como ler este relatório" existe recolhido e explica mês de abertura e custos', async () => {
    filterMock.mockImplementation(async () => [mk('1', 'BTCUSDT', 112)]);
    const { container } = renderPage(<MonthlyReport />);
    await screen.findByRole('status', { name: 'Leitura do mês' });
    const details = container.querySelector('details');
    expect(details.open).toBe(false);
    expect(details.textContent).toMatch(/O mês é o da abertura da operação/);
    expect(details.textContent).toMatch(/taxa de 0,05% na entrada/);
    expect(details.textContent).toMatch(/Tudo é virtual/);
  });

  it('cartão "Média por operação" traz a margem de erro', async () => {
    filterMock.mockImplementation(async () => [mk('1', 'BTCUSDT', 112), mk('2', 'ETHUSDT', 90, 'STOP_HIT'), mk('3', 'SOLUSDT', 112)]);
    renderPage(<MonthlyReport />);
    await waitFor(() => {
      const card = screen.getByText('Média por operação').closest('.glass-card');
      expect(card.textContent).toMatch(/margem de erro/);
    });
  });
});
