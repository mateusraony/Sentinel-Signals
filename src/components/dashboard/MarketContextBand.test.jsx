// @vitest-environment jsdom
// Contexto de Mercado — Fase 3 (visual redesenhado em 04/11/2026): a faixa de eventos renderizada. Prova o cartão do
// próximo evento (contagem regressiva, importância, situação da data), a linha do tempo por dia de Brasília (Hoje /
// Amanhã / em N dias), os 4 estados (atualizado, desatualizado, indisponível, desligado), o texto neutro (nada de
// "probabilidade"/"vai subir"), a data "a confirmar" sem contagem regressiva e que nunca vira "próximo evento", a chave de
// ocultar persistindo, o "Ver todos" e que a rede nunca é chamada de verdade nos testes.
// O relógio é fixo (só `Date`, os temporizadores seguem reais): os rótulos de dia dependem de "agora".
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderPage } from '@/pages/__fixtures__/renderPage.jsx';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/marketContextSource', () => ({ fetchMarketContext: fetchMock }));

import MarketContextBand from './MarketContextBand.jsx';

const NOW = Date.parse('2026-11-04T19:00:00.000Z'); // quarta-feira, 16:00 em Brasília
const iso = (ms) => new Date(ms).toISOString();
const inH = (h) => iso(NOW + h * 3600000);
const ev = (id, kind, startsAtUtc, status = 'oficial') => ({ id, kind, status, startsAtUtc, startMs: Date.parse(startsAtUtc) });
const dados = (events, checkedAtMs = NOW - 2 * 3600000) => fetchMock.mockResolvedValue({ checkedAtMs, events });
const REGIAO = { name: 'Agenda de eventos dos EUA' };

const mem = new Map();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  mem.clear();
  vi.stubGlobal('localStorage', { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Promise(() => {}));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('MarketContextBand', () => {
  it('atualizado: cartão do próximo evento com nome claro, hora de Brasília, contagem grande, importância e situação', async () => {
    dados([
      ev('NFP-x', 'NFP', '2026-11-06T13:30:00.000Z'),
      ev('CPI-x', 'CPI', '2026-11-10T13:30:00.000Z'),
      ev('FOMC-x', 'FOMC', '2026-12-09T19:00:00.000Z', 'confirmada'),
    ]);
    renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Próximo evento' });
    expect(screen.getByRole('region', REGIAO)).toBeTruthy();
    expect(within(card).getByText('Emprego dos EUA')).toBeTruthy();
    expect(within(card).getByText('(Payroll)')).toBeTruthy();
    expect(within(card).getByText(/sex 06\/11, 10:30 \(Brasília\)/)).toBeTruthy();
    expect(within(card).getByText('1d 18h')).toBeTruthy(); // 42,5 h à frente, sem o "em "
    expect(within(card).getByText('faltam')).toBeTruthy();
    expect(within(card).getByText('Impacto alto')).toBeTruthy();
    expect(within(card).getByText('Data oficial')).toBeTruthy();
    expect(screen.queryByText(/desatualizada/)).toBeNull();
  });

  it('linha do tempo: os seguintes agrupados por dia, com dia da semana, número do dia e "em N dias"', async () => {
    dados([
      ev('NFP-x', 'NFP', '2026-11-06T13:30:00.000Z'),
      ev('CPI-x', 'CPI', '2026-11-10T13:30:00.000Z'),
      ev('PPI-x', 'PPI', '2026-11-13T13:30:00.000Z'),
      ev('FOMC-x', 'FOMC', '2026-12-09T19:00:00.000Z', 'confirmada'),
    ]);
    renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Próximo evento' });
    expect(screen.getByText('Nos próximos dias')).toBeTruthy();
    expect(screen.getByText('TER')).toBeTruthy();
    expect(screen.getByText('em 6 dias')).toBeTruthy(); // 10/11
    expect(screen.getByText('em 9 dias')).toBeTruthy(); // 13/11
    expect(screen.getByText('Inflação ao consumidor')).toBeTruthy();
    expect(screen.getByText('Inflação ao produtor')).toBeTruthy();
    expect(screen.getByText('Decisão de juros do Fed')).toBeTruthy();
    expect(screen.getByText('Data confirmada')).toBeTruthy();
    // "Data oficial" é o normal: aparece só no cartão do próximo evento; a lista mostra só a exceção.
    expect(screen.getAllByText('Data oficial').length).toBe(1);
    expect(screen.getByText('Impacto médio')).toBeTruthy(); // PPI
    // A hora da linha do tempo é só o relógio de Brasília (a data já está no bloco do dia): CPI/PPI 10:30, FOMC 16:00.
    expect(screen.getAllByText('10:30').length).toBe(2);
    expect(screen.getByText('16:00')).toBeTruthy();
  });

  it('"Hoje" e "Amanhã" aparecem como rótulos dos blocos de dia (virada à meia-noite de Brasília)', async () => {
    dados([
      ev('PPI-hoje', 'PPI', iso(NOW + 3 * 3600000)), // hoje, 19:00 em Brasília
      ev('PCE-hoje', 'PCE', iso(NOW + 4 * 3600000)),
      ev('CPI-amanha', 'CPI', '2026-11-05T13:30:00.000Z'),
    ]);
    renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Próximo evento' }); // PPI em destaque
    expect(screen.getByText('Hoje')).toBeTruthy(); // PCE, mesmo dia de Brasília
    expect(screen.getByText('Amanhã')).toBeTruthy();
    expect(screen.getByText('QUA')).toBeTruthy();
    expect(screen.getByText('QUI')).toBeTruthy();
  });

  it('colunas: uma por dia COM evento, lado a lado, com o tipo da notícia em texto (cor nunca sozinha)', async () => {
    dados([
      ev('NFP-x', 'NFP', '2026-11-06T13:30:00.000Z'),
      ev('CPI-x', 'CPI', '2026-11-10T13:30:00.000Z'),
      ev('PPI-x', 'PPI', '2026-11-13T13:30:00.000Z'),
      ev('PCE-x', 'PCE', '2026-11-25T13:30:00.000Z'),
    ]);
    renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Próximo evento' });
    const colunas = screen.getByRole('region', { name: 'Próximos dias com evento' });
    expect(colunas.tabIndex).toBe(0); // rolável por teclado
    expect(within(colunas).getAllByRole('listitem').length).toBe(3); // CPI, PPI, PCE — o Payroll é o destaque
    expect(within(colunas).getAllByText('Inflação').length).toBe(3);
    expect(within(colunas).queryByText('Emprego')).toBeNull();
    expect(within(card).getByText('Emprego')).toBeTruthy();
    expect(within(colunas).getByText('TER')).toBeTruthy();
    expect(within(colunas).getByText('QUA')).toBeTruthy(); // 25/11
  });

  it('dois eventos no mesmo dia ficam na MESMA coluna (uma só etiqueta de dia)', async () => {
    dados([
      ev('PPI-hoje', 'PPI', iso(NOW + 3 * 3600000)),
      ev('PCE-hoje', 'PCE', iso(NOW + 4 * 3600000)),
      ev('CPI-hoje', 'CPI', iso(NOW + 5 * 3600000)),
    ]);
    renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Próximo evento' });
    const colunas = screen.getByRole('region', { name: 'Próximos dias com evento' });
    expect(within(colunas).getAllByRole('listitem').length).toBe(2);
    expect(within(colunas).getAllByText('Hoje').length).toBe(1);
  });

  it('números oficiais: Anterior e Atual (aguardando) com a fonte — e nunca Projeção', async () => {
    dados([
      { ...ev('NFP-x', 'NFP', '2026-11-06T13:30:00.000Z'), values: { previous: '151 mil', actual: null, source: 'BLS' } },
      { ...ev('CPI-x', 'CPI', '2026-11-10T13:30:00.000Z'), values: { previous: '3,2%', actual: null, source: 'BLS' } },
    ]);
    const { container } = renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Próximo evento' });
    expect(within(card).getByText('Anterior')).toBeTruthy();
    expect(within(card).getByText('151 mil')).toBeTruthy();
    expect(within(card).getByText('Atual')).toBeTruthy();
    expect(within(card).getByText('aguardando')).toBeTruthy();
    expect(within(card).getByText('Fonte: BLS')).toBeTruthy();
    // o evento seguinte (na coluna) também mostra o seu Anterior, em tamanho compacto
    const colunas = screen.getByRole('region', { name: 'Próximos dias com evento' });
    expect(within(colunas).getByText('3,2%')).toBeTruthy();
    expect(within(colunas).getByText('Fonte: BLS')).toBeTruthy();
    // ...mas o "aguardando" não se repete em cada coluna: só o cartão do próximo evento mostra o Atual pendente
    expect(within(colunas).queryByText('aguardando')).toBeNull();
    expect(within(colunas).queryByText('Atual')).toBeNull();
    expect(container.textContent).not.toMatch(/proje/i);
  });

  it('Atual publicado substitui o "aguardando" (o evento que já saiu vira o cartão de Resultado)', async () => {
    dados([{ ...ev('NFP-x', 'NFP', iso(NOW - 5 * 60000)), values: { previous: '151 mil', actual: '175 mil', source: 'BLS' } }]);
    renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Resultado' });
    expect(within(card).getByText('175 mil')).toBeTruthy();
    expect(within(card).queryByText('aguardando')).toBeNull();
    expect(screen.queryByRole('article', { name: 'Próximo evento' })).toBeNull();
  });

  it('sem números no arquivo (o caso de hoje): nenhum espaço vazio nem traço permanente', async () => {
    dados([ev('NFP-x', 'NFP', '2026-11-06T13:30:00.000Z'), ev('CPI-x', 'CPI', '2026-11-10T13:30:00.000Z')]);
    const { container } = renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Próximo evento' });
    expect(screen.queryByText('Anterior')).toBeNull();
    expect(screen.queryByText('Atual')).toBeNull();
    expect(screen.queryByText('aguardando')).toBeNull();
    expect(container.textContent).not.toMatch(/Fonte:/);
  });

  it('em menos de 1 h o cartão avisa "Em menos de 1 h" com a contagem em minutos', async () => {
    dados([ev('a', 'CPI', iso(NOW + 38 * 60000))]);
    renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Próximo evento' });
    expect(within(card).getByText('Em menos de 1 h')).toBeTruthy();
    expect(within(card).getByText('38 min')).toBeTruthy();
  });

  it('texto neutro: só informação, nunca previsão ou probabilidade', async () => {
    dados([ev('a', 'CPI', inH(5)), ev('b', 'NFP', inH(80)), ev('c', 'FOMC', inH(500), 'confirmada')]);
    const { container } = renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Próximo evento' });
    expect(screen.getByText(/Só informação — não altera sinais nem operações/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/probabilidade|vai subir|vai cair|compra|venda/i);
  });

  it('data a confirmar aparece apagada, sem contagem regressiva, e NUNCA vira "próximo evento"', async () => {
    dados([ev('p', 'NFP', inH(48), 'a_confirmar'), ev('c', 'CPI', inH(24 * 5))]);
    renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Próximo evento' });
    expect(within(card).getByText('Inflação ao consumidor')).toBeTruthy(); // o destaque é o de data firme
    const linha = screen.getByText('Emprego dos EUA').closest('li');
    expect(within(linha).getByText('Data a confirmar')).toBeTruthy();
    expect(linha.textContent).not.toMatch(/em \d|acabou de sair/); // nada de contagem regressiva
  });

  it('só datas a confirmar: nenhum cartão de próximo evento, só a lista', async () => {
    dados([ev('p', 'NFP', inH(48), 'a_confirmar'), ev('q', 'CPI', inH(100), 'a_confirmar')]);
    renderPage(<MarketContextBand />);
    await screen.findByText('Emprego dos EUA');
    expect(screen.queryByRole('article', { name: 'Próximo evento' })).toBeNull();
    expect(screen.getAllByText('Data a confirmar').length).toBe(2);
  });

  it('evento que acabou de sair (≤ 30 min) mostra "Acabou de sair" e "agora"', async () => {
    dados([ev('a', 'CPI', iso(NOW - 10 * 60000))]);
    renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Próximo evento' });
    expect(within(card).getByText('Acabou de sair')).toBeTruthy();
    expect(within(card).getByText('agora')).toBeTruthy();
    expect(within(card).queryByText('faltam')).toBeNull();
  });

  it('desatualizado: avisa a idade da última checagem e pede para conferir a data', async () => {
    dados([ev('a', 'CPI', inH(10))], NOW - 50 * 3600000);
    renderPage(<MarketContextBand />);
    await screen.findByText(/Última checagem há 50 h/);
    expect(screen.getByText(/pode estar desatualizada/)).toBeTruthy();
    expect(screen.getByText('Inflação ao consumidor')).toBeTruthy(); // continua mostrando os eventos
  });

  it('indisponível (rede/branch inexistente): uma linha calma, sem erro, dizendo que nada é afetado', async () => {
    fetchMock.mockRejectedValue(new Error('HTTP 404'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage(<MarketContextBand />);
    await screen.findByText(/Agenda indisponível no momento/);
    expect(screen.getByText(/Isso não afeta sinais nem operações/)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('sem eventos à frente: mensagem própria', async () => {
    dados([ev('a', 'CPI', inH(-48))]);
    renderPage(<MarketContextBand />);
    await screen.findByText('Nenhum evento à frente na agenda.');
  });

  it('"Ver todos": mostra 1 em destaque + 5 na linha do tempo e expande o resto; "Mostrar menos" volta', async () => {
    dados(Array.from({ length: 8 }, (_, i) => ev(`E${i}`, ['CPI', 'NFP', 'PPI', 'PCE'][i % 4], inH(30 + i * 30))));
    renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Próximo evento' });
    expect(screen.getAllByRole('listitem').length).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: /Ver todos \(8\)/ }));
    expect(screen.getAllByRole('listitem').length).toBe(7);
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar menos' }));
    expect(screen.getAllByRole('listitem').length).toBe(5);
  });

  it('com poucos eventos não aparece o botão "Ver todos"', async () => {
    dados([ev('a', 'CPI', inH(30)), ev('b', 'NFP', inH(60))]);
    renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Próximo evento' });
    expect(screen.queryByRole('button', { name: /Ver todos/ })).toBeNull();
  });

  it('acessível: horas em <time> com instante UTC e importância com texto (não só pontinhos coloridos)', async () => {
    dados([ev('a', 'CPI', '2026-11-10T13:30:00.000Z'), ev('b', 'PPI', '2026-11-13T13:30:00.000Z')]);
    const { container } = renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Próximo evento' });
    const instantes = [...container.querySelectorAll('time')].map((t) => t.getAttribute('dateTime'));
    expect(instantes).toEqual(['2026-11-10T13:30:00.000Z', '2026-11-13T13:30:00.000Z']);
    expect(screen.getByText('Impacto alto')).toBeTruthy();
    expect(screen.getByText('Impacto médio')).toBeTruthy();
  });

  it('erro de renderização da faixa NÃO derruba o resto da tela (caixa de erro local, sem log)', async () => {
    // Um evento que estoura quando o componente o lê (simula um bug de renderização na faixa).
    fetchMock.mockResolvedValue({ checkedAtMs: NOW, events: [{ id: 'x', get startMs() { throw new Error('boom'); } }] });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {}); // o React registra o erro capturado
    const calar = (e) => e.preventDefault(); // o jsdom também reimprime o erro como "não capturado"
    window.addEventListener('error', calar);
    try {
      renderPage(<div><MarketContextBand /><p>irmão continua na tela</p></div>);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.getByText('irmão continua na tela')).toBeTruthy();
      expect(screen.queryByRole('region', REGIAO)).toBeNull();
    } finally {
      window.removeEventListener('error', calar);
      spy.mockRestore();
    }
  });

  it('ocultar: some, lembra a escolha e não faz requisição; mostrar volta', async () => {
    dados([ev('a', 'CPI', inH(5))]);
    const { unmount } = renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Próximo evento' });
    fireEvent.click(screen.getByRole('button', { name: 'Ocultar agenda de eventos' }));
    expect(screen.queryByRole('article', { name: 'Próximo evento' })).toBeNull();
    expect(screen.getByRole('button', { name: /Mostrar agenda de eventos dos EUA/ })).toBeTruthy();
    expect(mem.get('sentinel_market_context_band_off')).toBe('1');

    // Nova montagem (outra visita ao painel): continua oculta e NÃO busca nada.
    unmount();
    fetchMock.mockClear();
    renderPage(<MarketContextBand />);
    expect(screen.getByRole('button', { name: /Mostrar agenda de eventos dos EUA/ })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Mostrar agenda de eventos dos EUA/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(mem.has('sentinel_market_context_band_off')).toBe(false);
  });
});

// Resultado (addendum 15 do item 285): o evento do BLS que acabou de sair vira um cartão com Anterior × Atual (comparação NEUTRA),
// o texto sai por extenso e a lista "Últimas divulgações" guarda o que já passou. Os números aqui são de EXEMPLO.
describe('MarketContextBand — resultado', () => {
  const HORA = 3600000;
  const CPI_V = { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,5% m/m · +4,0% a/a', source: 'BLS' };
  const saiu = (id, kind, ago, values) => ({ ...ev(id, kind, iso(NOW - ago)), values });

  it('aguardando o número: mostra o Anterior, "aguardando" no Atual e nenhuma comparação; diz quando entra', async () => {
    dados([saiu('NFP-x', 'NFP', 12 * 60000, { previous: '+119 mil', source: 'BLS' })]);
    renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Resultado' });
    expect(within(card).getByText('Emprego dos EUA')).toBeTruthy();
    expect(within(card).getByText(/Saiu hoje às 15:48/)).toBeTruthy(); // 18:48 UTC = 15:48 em Brasília
    expect(within(card).getByText(/há 12 min/)).toBeTruthy();
    expect(within(card).getByText('Aguardando o número')).toBeTruthy();
    const tabela = within(card).getByRole('table');
    expect(within(tabela).getByText('+119 mil')).toBeTruthy();
    expect(within(tabela).getByText('aguardando')).toBeTruthy();
    expect(within(tabela).queryByText(/acima|abaixo|igual/)).toBeNull();
    expect(within(card).queryByText('Resultado oficial')).toBeNull();
    expect(within(card).getByText(/O número entra na próxima coleta \(última checagem há 2 h\)/)).toBeTruthy();
  });

  it('com o número: uma linha por medida por extenso, Anterior × Atual, "Anterior revisado" e a comparação em palavras', async () => {
    dados([saiu('CPI-x', 'CPI', 40 * 60000, { ...CPI_V, revised: '+0,4% m/m · +3,0% a/a' })]);
    renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Resultado' });
    const tabela = within(card).getByRole('table');
    expect(within(card).getByText('Resultado oficial')).toBeTruthy();
    expect(within(tabela).getByRole('columnheader', { name: 'Anterior' })).toBeTruthy();
    expect(within(tabela).getByRole('columnheader', { name: 'Anterior revisado' })).toBeTruthy();
    expect(within(tabela).getByRole('columnheader', { name: 'Atual' })).toBeTruthy();
    const mes = within(tabela).getByRole('row', { name: /No mês/ });
    expect(within(mes).getByText('+0,3%')).toBeTruthy(); // anterior
    expect(within(mes).getByText('+0,4%')).toBeTruthy(); // revisado
    expect(within(mes).getByText('+0,5%')).toBeTruthy(); // atual
    expect(within(mes).getByText('acima')).toBeTruthy();
    const ano = within(tabela).getByRole('row', { name: /Em 12 meses/ });
    expect(within(ano).getByText('+4,0%')).toBeTruthy();
    expect(within(ano).getByText('acima')).toBeTruthy();
    expect(within(ano).getAllByText('—').length).toBe(1); // o 12 meses não foi revisado
    expect(within(card).getByText(/Fonte: BLS\. Compara com o mês anterior, não com a expectativa do mercado/)).toBeTruthy();
  });

  it('abaixo e igual também aparecem em palavras; a seta e a palavra nunca usam cor de bom/ruim (verde/vermelho)', async () => {
    dados([
      saiu('NFP-x', 'NFP', 20 * 60000, { previous: '+119 mil', actual: '+81 mil', source: 'BLS' }),
      saiu('PPI-x', 'PPI', 2 * HORA, { previous: '-0,2% m/m · +2,0% a/a', actual: '-0,2% m/m · +1,5% a/a', source: 'BLS' }),
    ]);
    const { container } = renderPage(<MarketContextBand />);
    const cards = await screen.findAllByRole('article', { name: 'Resultado' });
    expect(cards.length).toBe(2);
    expect(within(cards[0]).getByText('abaixo')).toBeTruthy(); // Payroll: 81 < 119 (o mais recente vem primeiro)
    expect(within(cards[1]).getByText('igual')).toBeTruthy(); // PPI no mês
    expect(within(cards[1]).getByText('abaixo')).toBeTruthy(); // PPI em 12 meses
    for (const t of container.querySelectorAll('table')) {
      expect(t.innerHTML).not.toMatch(/#00ff80|#ff|green|red|emerald|rose/i);
      for (const el of t.querySelectorAll('[style]')) expect(el.getAttribute('style') ?? '').not.toMatch(/color/);
    }
  });

  it('o evento que já saiu NÃO aparece também como "próximo evento" nem nas colunas; o seguinte continua sendo o destaque', async () => {
    dados([saiu('NFP-x', 'NFP', 30 * 60000, { previous: '+119 mil', source: 'BLS' }), ev('CPI-x', 'CPI', '2026-11-10T13:30:00.000Z')]);
    renderPage(<MarketContextBand />);
    const proximo = await screen.findByRole('article', { name: 'Próximo evento' });
    expect(within(proximo).getByText('Inflação ao consumidor')).toBeTruthy();
    expect(screen.getAllByText('Emprego dos EUA').length).toBe(1); // só no cartão de Resultado
    expect(screen.queryByText('Nos próximos dias')).toBeNull();
  });

  it('só o resultado, sem mais nada à frente: não mostra "Nenhum evento à frente"', async () => {
    dados([saiu('NFP-x', 'NFP', 30 * 60000, { previous: '+119 mil', actual: '+81 mil', source: 'BLS' })]);
    renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Resultado' });
    expect(screen.queryByText('Nenhum evento à frente na agenda.')).toBeNull();
    expect(screen.queryByRole('article', { name: 'Próximo evento' })).toBeNull();
  });

  it('o cartão de resultado fica por 24 h; depois disso o evento vai para "Últimas divulgações"', async () => {
    dados([
      saiu('CPI-a', 'CPI', 23 * HORA, CPI_V),
      saiu('PPI-b', 'PPI', 24 * HORA + 60000, { previous: '-0,2% m/m · +2,0% a/a', actual: '+0,5% m/m · +2,0% a/a', source: 'BLS' }),
    ]);
    renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Resultado' });
    expect(within(card).getByText('Inflação ao consumidor')).toBeTruthy();
    expect(within(card).getByText(/Saiu ontem às/)).toBeTruthy(); // 23 h antes de QUA 16:00 = TER 17:00 em Brasília
    const lista = screen.getByRole('region', { name: 'Últimas divulgações' });
    expect(within(lista).getByText('Inflação ao produtor')).toBeTruthy();
    expect(within(lista).queryByText('Inflação ao consumidor')).toBeNull();
  });

  it('Últimas divulgações: dia, nome, "anterior → atual", comparação em palavras e a marca de revisão; cinco de início e "Ver todas"', async () => {
    const velhos = Array.from({ length: 7 }, (_, i) => saiu(`CPI-${i}`, 'CPI', (3 + i * 7) * 24 * HORA, i === 0
      ? { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,5% m/m · +4,0% a/a', revised: '+0,4% m/m · +3,0% a/a', source: 'BLS' }
      : { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,1% m/m · +3,0% a/a', source: 'BLS' }));
    dados(velhos);
    renderPage(<MarketContextBand />);
    const lista = await screen.findByRole('region', { name: 'Últimas divulgações' });
    expect(within(lista).getAllByRole('listitem').length).toBe(5);
    const primeira = within(lista).getAllByRole('listitem')[0]; // a mais recente (3 dias atrás = DOM 01/11)
    expect(within(primeira).getByText('DOM 01/11')).toBeTruthy();
    expect(within(primeira).getByText('Inflação ao consumidor')).toBeTruthy();
    expect(within(primeira).getByText('+0,3%')).toBeTruthy();
    expect(within(primeira).getByText('+0,5%')).toBeTruthy();
    expect(within(primeira).getByText('no mês')).toBeTruthy();
    expect(within(primeira).getByText('acima')).toBeTruthy();
    expect(within(primeira).getByText('anterior revisado')).toBeTruthy();
    expect(within(within(lista).getAllByRole('listitem')[1]).getByText('abaixo')).toBeTruthy();
    expect(within(within(lista).getAllByRole('listitem')[1]).queryByText('anterior revisado')).toBeNull();
    expect(within(lista).getByText('Fonte: BLS. Compara com o mês anterior.')).toBeTruthy();
    fireEvent.click(within(lista).getByRole('button', { name: 'Ver todas (7)' }));
    expect(within(lista).getAllByRole('listitem').length).toBe(7);
    fireEvent.click(within(lista).getByRole('button', { name: 'Mostrar menos' }));
    expect(within(lista).getAllByRole('listitem').length).toBe(5);
  });

  it('sem nenhuma divulgação com número: a lista não existe (nada de seção vazia)', async () => {
    dados([
      saiu('CPI-sem', 'CPI', 5 * 24 * HORA, { previous: '+0,3% m/m', source: 'BLS' }), // saiu mas o Atual nunca entrou
      ev('PPI-x', 'PPI', '2026-11-13T13:30:00.000Z'),
    ]);
    renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Próximo evento' });
    expect(screen.queryByRole('region', { name: 'Últimas divulgações' })).toBeNull();
    expect(screen.queryByText('Últimas divulgações')).toBeNull();
  });

  it('texto por extenso: "no mês" e "em 12 meses" no lugar de "m/m" e "a/a" (também nos eventos que ainda não saíram)', async () => {
    dados([
      { ...ev('CPI-x', 'CPI', '2026-11-10T13:30:00.000Z'), values: { previous: '+0,3% m/m · +3,0% a/a', actual: null, source: 'BLS' } },
      { ...ev('PPI-x', 'PPI', '2026-11-13T13:30:00.000Z'), values: { previous: '-0,2% m/m · +2,0% a/a', actual: null, source: 'BLS' } },
    ]);
    const { container } = renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Próximo evento' });
    expect(within(card).getByText('+0,3%')).toBeTruthy();
    expect(within(card).getByText('no mês')).toBeTruthy();
    expect(within(card).getByText('+3,0%')).toBeTruthy();
    expect(within(card).getByText('em 12 meses')).toBeTruthy();
    const colunas = screen.getByRole('region', { name: 'Próximos dias com evento' });
    expect(within(colunas).getByText('-0,2%')).toBeTruthy();
    expect(container.textContent).not.toMatch(/m\/m|a\/a/);
  });

  it('segue neutro com tudo na tela: nada de previsão, probabilidade, compra/venda nem projeção', async () => {
    dados([
      saiu('CPI-a', 'CPI', 20 * 60000, { ...CPI_V, revised: '+0,4% m/m · +3,0% a/a' }),
      saiu('NFP-b', 'NFP', 5 * 24 * HORA, { previous: '+119 mil', actual: '+81 mil', source: 'BLS' }),
      ev('PPI-x', 'PPI', '2026-11-13T13:30:00.000Z'),
    ]);
    const { container } = renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Resultado' });
    expect(container.textContent).not.toMatch(/probabilidade|vai subir|vai cair|vai cair|compra|venda|proje[cç]|previs[aã]o|bom|ruim/i);
  });

  it('evento que saiu SEM nenhum número segue o fluxo antigo: "Acabou de sair" por 30 min, sem cartão de resultado', async () => {
    dados([ev('CPI-x', 'CPI', iso(NOW - 10 * 60000))]);
    renderPage(<MarketContextBand />);
    const card = await screen.findByRole('article', { name: 'Próximo evento' });
    expect(within(card).getByText('Acabou de sair')).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Resultado' })).toBeNull();
  });

  it('PCE e FOMC nunca viram cartão de resultado (o painel não tem número deles)', async () => {
    dados([saiu('PCE-x', 'PCE', 10 * 60000, { previous: '+0,3% m/m', source: 'BLS' }), ev('FOMC-x', 'FOMC', iso(NOW - 5 * 60000), 'confirmada')]);
    renderPage(<MarketContextBand />);
    await screen.findByRole('article', { name: 'Próximo evento' });
    expect(screen.queryByRole('article', { name: 'Resultado' })).toBeNull();
  });
});
