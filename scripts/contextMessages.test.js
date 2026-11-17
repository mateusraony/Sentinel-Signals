// Item 285, addendum 12 — as mensagens do Telegram do Contexto. O que se prova: texto neutro (nada de previsão,
// probabilidade, compra ou venda), HTML escapado, hora de Brasília a partir de UTC, "a confirmar" sem contagem nem alerta,
// categorias desligadas por padrão e `teste` sempre permitida.
import { describe, it, expect } from 'vitest';
import {
  CATEGORIES, NEUTRAL_NOTE, parseCategories, isCategoryEnabled, readEvents, escapeHtml,
  buildTestMessage, buildAgendaMessage, nextAlertableEvent, buildPreEventMessage, buildPreEventBriefing, buildReactionBlock, formatPct,
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
    // Vazio/ausente = o PADRÃO: só `pre-evento` (aviso automático) liga sozinho; `agenda` é do botão manual. `nenhuma` desliga tudo; lista liga só o listado.
    expect(isCategoryEnabled('pre-evento', '')).toBe(true);
    expect(isCategoryEnabled('pre-evento', undefined)).toBe(true);
    expect(isCategoryEnabled('pre-evento', 'nenhuma')).toBe(false);
    expect(isCategoryEnabled('pre-evento', ' NENHUMA ')).toBe(false);
    expect(isCategoryEnabled('pre-evento', 'agenda,nenhuma')).toBe(false);
    expect(isCategoryEnabled('pre-evento', 'pre-evento,nenhuma')).toBe(false); // `nenhuma` vence qualquer lista
    expect(isCategoryEnabled('teste', 'nenhuma')).toBe(true);
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

// Fase 4b (addendum 27): o aviso COMPLETO de antes do evento.
const reaction = (m5, m30, m60) => ({ moves: { 5: m5, 30: m30, 60: m60 }, rangePct: 1 });
const CPI = readEvents([{ ...ev('CPI-2026-12-10', 'CPI', '2026-12-10T13:30:00.000Z'), reference: '2026-11', values: { previous: '+0,3% m/m · +3,0% a/a', source: 'BLS' } }])[0];
const AT = Date.parse('2026-12-10T12:35:00.000Z');
const ROWS = [
  { date: '2026-10-24', reaction: reaction(0.1, 0.3, 0.4) },
  { date: '2026-09-11', reaction: reaction(-0.5, -0.9, -1.2) },
  { date: '2026-08-12', reaction: reaction(0, 0.2, 0) },
];

describe('formatPct: duas casas, vírgula e sinal escrito', () => {
  it('formata positivo, negativo (com o menos verdadeiro), zero e lixo', () => {
    expect(formatPct(0.4)).toBe('+0,40%');
    expect(formatPct(-1.2)).toBe('−1,20%');
    expect(formatPct(0)).toBe('0,00%');
    expect(formatPct(-0.004)).toBe('−0,00%'); // arredonda para zero mas o sinal real do movimento fica visível
    for (const x of [NaN, null, undefined, 'x', Infinity]) expect(formatPct(x)).toBe('—');
  });
});

describe('buildPreEventBriefing: completo, mas só fatos e medições', () => {
  const texto = buildPreEventBriefing(CPI, AT, { reactions: ROWS });

  it('traz o evento, a contagem, a importância, a hora de Brasília e a situação da data', () => {
    expect(texto).toContain('<b>CPI — em 55 min</b>');
    expect(texto).toContain('Inflação ao consumidor · importância alta');
    expect(texto).toContain('qui 10/12, 10:30 (Brasília) · data oficial');
  });

  it('traz o "Anterior" oficial e diz com todas as letras que a projeção (consenso) não existe de graça', () => {
    expect(texto).toContain('<b>Anterior (BLS):</b> +0,3% m/m · +3,0% a/a');
    expect(texto).toContain('<b>Projeção do mercado (consenso):</b> indisponível');
    expect(texto).toContain('o sistema não inventa um número');
  });

  it('mostra as 3 últimas divulgações com o BTC em 1 h (negrito), 5 e 30 min, e o resumo com o número de casos', () => {
    expect(texto).toContain('<b>BTC nas últimas 3 divulgações de CPI</b> (movimento 1 h depois):');
    expect(texto).toContain('• 24/10: <b>+0,40%</b> (5 min +0,10% · 30 min +0,30%)');
    expect(texto).toContain('• 11/09: <b>−1,20%</b> (5 min −0,50% · 30 min −0,90%)');
    expect(texto).toContain('Tamanho mediano do movimento: 0,40% · subiu 1 de 3, caiu 1 de 3.');
    expect(texto).toContain('Só 3 casos: descreve o passado, não prevê o próximo.');
  });

  it('termina dizendo que não há previsão de direção e com o rodapé neutro', () => {
    expect(texto).toContain('Sem previsão de direção (alta ou baixa)');
    expect(texto.trimEnd().endsWith(NEUTRAL_NOTE)).toBe(true);
  });

  it('TEXTO NEUTRO: a mensagem completa não fala de probabilidade, compra, venda, recomendação nem "vai subir/cair" — em nenhuma variação de dados', () => {
    const variacoes = [
      texto,
      buildPreEventBriefing(CPI, AT, { reactions: null }),
      buildPreEventBriefing(CPI, AT, { reactions: [] }),
      buildPreEventBriefing(CPI, AT, { reactions: [{ date: '2026-10-24', reaction: null }] }),
      buildPreEventBriefing({ ...CPI, kind: 'FOMC', values: undefined }, AT, { reactions: [] }),
      buildPreEventBriefing({ ...CPI, kind: 'PCE', values: undefined, status: 'confirmada' }, AT),
    ];
    for (const m of variacoes) {
      expect(m).not.toMatch(PROIBIDO);
      expect(m.length).toBeLessThan(1800); // longe do limite de 4.096 do Telegram
    }
  });

  it('PCE e FOMC: "Anterior" diz que não há fonte oficial automática; CPI/PPI/Payroll sem número dizem "indisponível agora"', () => {
    expect(buildPreEventBriefing({ ...CPI, kind: 'PCE', values: undefined }, AT)).toContain('sem fonte oficial automática');
    expect(buildPreEventBriefing({ ...CPI, kind: 'FOMC', values: undefined }, AT)).toContain('sem fonte oficial automática');
    for (const kind of ['CPI', 'PPI', 'NFP']) expect(buildPreEventBriefing({ ...CPI, kind, values: undefined }, AT)).toContain('indisponível agora (o BLS não respondeu');
  });

  it('importância: alta para CPI, Payroll e FOMC; média para PPI e PCE', () => {
    for (const kind of ['CPI', 'NFP', 'FOMC']) expect(buildPreEventBriefing({ ...CPI, kind }, AT)).toContain('importância alta');
    for (const kind of ['PPI', 'PCE']) expect(buildPreEventBriefing({ ...CPI, kind }, AT)).toContain('importância média');
  });

  it('o que vem de arquivo público é escapado (um "Anterior" com < > & não vira tag)', () => {
    const m = buildPreEventBriefing({ ...CPI, values: { previous: '<b>&x</b>' } }, AT);
    expect(m).toContain('&lt;b&gt;&amp;x&lt;/b&gt;');
  });
});

describe('buildReactionBlock: os três estados do histórico', () => {
  it('fonte de preços sem resposta (null) × tipo sem histórico ([]) × linhas medidas', () => {
    expect(buildReactionBlock('CPI', null)[0]).toContain('indisponível agora');
    expect(buildReactionBlock('CPI', undefined)[0]).toContain('indisponível agora');
    expect(buildReactionBlock('FOMC', [])[0]).toContain('ainda sem histórico automático');
    expect(buildReactionBlock('CPI', ROWS).length).toBeGreaterThan(4);
  });
  it('1 caso só: singular, e a linha sem dado aparece como tal sem entrar na conta', () => {
    const um = buildReactionBlock('CPI', [ROWS[0]]);
    expect(um[0]).toContain('na última divulgação de CPI');
    expect(um.join('\n')).toContain('Só 1 caso:');
    const misto = buildReactionBlock('CPI', [{ date: '2026-10-24', reaction: null }, ROWS[1]]).join('\n');
    expect(misto).toContain('• 24/10: sem dado');
    expect(misto).toContain('subiu 0 de 1, caiu 1 de 1');
  });
  it('todas sem dado: nenhuma linha de resumo (não inventa mediana)', () => {
    const tudo = buildReactionBlock('CPI', [{ date: '2026-10-24', reaction: null }]).join('\n');
    expect(tudo).not.toContain('Tamanho mediano');
  });
});
