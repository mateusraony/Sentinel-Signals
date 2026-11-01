// Item 285, addendum 12 — as mensagens do Telegram do Contexto. O que se prova: texto neutro (nada de previsão,
// probabilidade, compra ou venda), HTML escapado, hora de Brasília a partir de UTC, "a confirmar" sem contagem nem alerta,
// categorias desligadas por padrão e `teste` sempre permitida.
import { describe, it, expect } from 'vitest';
import {
  CATEGORIES, NEUTRAL_NOTE, parseCategories, isCategoryEnabled, readEvents, escapeHtml,
  buildTestMessage, buildAgendaMessage, nextAlertableEvent, buildPreEventMessage,
} from './contextMessages.mjs';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ev = (id, kind, startsAtUtc, status = 'oficial') => ({ id, kind, reference: '2026-10', startsAtUtc, status, firstSeenAt: startsAtUtc, lastChangedAt: startsAtUtc });
const EVENTS = readEvents([
  ev('NFP-2026-11-06', 'NFP', '2026-11-06T13:30:00.000Z'),
  ev('CPI-2026-11-10', 'CPI', '2026-11-10T13:30:00.000Z', 'confirmada'),
  ev('PPI-2026-11-13', 'PPI', '2026-11-13T13:30:00.000Z', 'a_confirmar'),
  ev('FOMC-2026-12-09', 'FOMC', '2026-12-09T19:00:00.000Z'),
]);
const PROIBIDO = /probabilidade|vai subir|vai cair|deve subir|deve cair|compre|venda|\bcompra\b|recomend|garant/i;

describe('categorias', () => {
  it('padrão tudo desligado; "teste" sempre permitida; nome fora da lista é ignorado', () => {
    expect(CATEGORIES).toEqual(['teste', 'agenda', 'pre-evento']);
    expect(isCategoryEnabled('agenda', '')).toBe(false);
    expect(isCategoryEnabled('agenda', undefined)).toBe(false);
    expect(isCategoryEnabled('teste', '')).toBe(true);
    expect(isCategoryEnabled('agenda', 'agenda')).toBe(true);
    expect(isCategoryEnabled('pre-evento', ' Agenda , PRE-EVENTO ')).toBe(true);
    expect(isCategoryEnabled('pre-evento', 'agenda')).toBe(false);
    expect([...parseCategories('agenda; xyz resumo')]).toEqual(['agenda']);
  });
});

describe('mensagens', () => {
  it('teste: diz que o caminho funciona e a hora de Brasília', () => {
    const m = buildTestMessage(NOW);
    expect(m).toMatch(/Teste do aviso do Contexto/);
    expect(m).toContain('qui 05/11, 09:00 (Brasília)');
    expect(m).toContain(NEUTRAL_NOTE);
  });

  it('agenda: lista os eventos futuros em ordem, com hora de Brasília, contagem e situação', () => {
    const m = buildAgendaMessage(EVENTS, NOW);
    const linhas = m.split('\n').filter((l) => l.startsWith('• '));
    expect(linhas).toHaveLength(4);
    expect(linhas[0]).toContain('<b>Payroll</b>');
    expect(linhas[0]).toContain('sex 06/11, 10:30 (Brasília)');
    expect(linhas[0]).toContain('em 1d 1h');
    expect(linhas[0]).toContain('oficial');
    expect(linhas[1]).toContain('confirmada');
    expect(linhas[3]).toContain('qua 09/12, 16:00 (Brasília)'); // FOMC 14:00 de Nova York
    expect(m).toContain(NEUTRAL_NOTE);
  });

  it('agenda: data "a confirmar" aparece sem contagem regressiva', () => {
    const linha = buildAgendaMessage(EVENTS, NOW).split('\n').find((l) => l.includes('PPI'));
    expect(linha).toContain('data a confirmar');
    expect(linha).not.toMatch(/ · em \d/);
  });

  it('agenda: respeita o limite e a lista vazia tem mensagem própria', () => {
    expect(buildAgendaMessage(EVENTS, NOW, 2).split('\n').filter((l) => l.startsWith('• '))).toHaveLength(2);
    expect(buildAgendaMessage([], NOW)).toContain('Nenhum evento à frente na agenda.');
  });

  it('pre-evento: só o evento e a hora, sem lista de operações', () => {
    const next = nextAlertableEvent(EVENTS, NOW);
    expect(next.id).toBe('NFP-2026-11-06');
    const m = buildPreEventMessage(next, NOW);
    expect(m).toContain('<b>Payroll — em 1d 1h</b>');
    expect(m).toContain('sex 06/11, 10:30 (Brasília)');
    expect(m).toContain('Situação da data: oficial.');
    expect(m).not.toMatch(/opera[çc][ãa]o|stop|alvo|posi[çc][ãa]o/i); // nada que dependa do banco
  });

  it('próximo evento com data firme ignora "a confirmar" e o que já começou', () => {
    const so = readEvents([ev('A', 'PPI', '2026-11-13T13:30:00.000Z', 'a_confirmar'), ev('B', 'CPI', '2026-11-05T11:50:00.000Z')]);
    expect(nextAlertableEvent(so, NOW)).toBeNull();
    expect(nextAlertableEvent([], NOW)).toBeNull();
  });

  it('TODAS as mensagens têm texto neutro (nada de previsão, probabilidade, compra ou venda)', () => {
    const todas = [buildTestMessage(NOW), buildAgendaMessage(EVENTS, NOW), buildPreEventMessage(nextAlertableEvent(EVENTS, NOW), NOW)];
    for (const m of todas) {
      expect(m).not.toMatch(PROIBIDO);
      expect(m.length).toBeLessThan(1500); // bem abaixo do limite do Telegram
    }
  });

  it('HTML escapado: um texto com < > & não vira tag', () => {
    expect(escapeHtml('<b>&x</b>')).toBe('&lt;b&gt;&amp;x&lt;/b&gt;');
    expect(escapeHtml(null)).toBe('');
  });

  it('o corpo que não é lista lança (o CLI mostra "não consegui ler a agenda")', () => {
    expect(() => readEvents({ x: 1 })).toThrow();
  });
});
