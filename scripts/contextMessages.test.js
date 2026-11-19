// Item 285, addendum 12 — as mensagens do Telegram do Contexto. O que se prova: texto neutro (nada de previsão,
// probabilidade, compra ou venda), HTML escapado, hora de Brasília a partir de UTC, "a confirmar" sem contagem nem alerta,
// categorias desligadas por padrão e `teste` sempre permitida.
import { describe, it, expect } from 'vitest';
import {
  CATEGORIES, NEUTRAL_NOTE, parseCategories, isCategoryEnabled, readEvents, escapeHtml,
  buildTestMessage, buildAgendaMessage, nextAlertableEvent, buildPreEventMessage, buildPreEventBriefing, buildReactionBlock, formatPct, buildResultMessage, AUTOMATIC_ONLY, DEFAULT_CATEGORIES, buildDaySummary,
} from './contextMessages.mjs';
import { eventsOfDay } from './contextAlert.mjs';

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
    expect(CATEGORIES).toEqual(['teste', 'agenda', 'pre-evento']); // `resultado` e `resumo` só existem no envio automático (AUTOMATIC_ONLY)
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
    expect([...parseCategories('agenda; xyz zzz')]).toEqual(['agenda']);
    expect([...parseCategories('agenda; resumo')]).toEqual(['agenda', 'resumo']); // `resumo` (addendum 35) é categoria válida
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

  it('FOMC: "Anterior" diz que não há fonte oficial automática; CPI/PPI/Payroll sem número dizem que o BLS não respondeu; PCE, que a BEA não respondeu', () => {
    expect(buildPreEventBriefing({ ...CPI, kind: 'FOMC', values: undefined }, AT)).toContain('sem fonte oficial automática');
    for (const kind of ['CPI', 'PPI', 'NFP']) expect(buildPreEventBriefing({ ...CPI, kind, values: undefined }, AT)).toContain('indisponível agora (o BLS não respondeu');
    expect(buildPreEventBriefing({ ...CPI, kind: 'PCE', values: undefined }, AT)).toContain('indisponível agora (a BEA não respondeu');
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

// Fase 4b-3 (addendum 28): o aviso de resultado.
describe('buildResultMessage: o resultado e o BTC desde a divulgação', () => {
  const COM = readEvents([{ ...ev('CPI-2026-12-10', 'CPI', '2026-12-10T13:30:00.000Z'), reference: '2026-11', values: { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,2% m/m · +3,1% a/a', revised: '+0,4% m/m', source: 'BLS' } }])[0];
  const AFTER = Date.parse('2026-12-10T14:10:00.000Z');
  const moves = { 5: -0.1, 30: 0.25, 60: null };
  const typical = { n: 3, medAbs60: 0.4 };
  const texto = buildResultMessage(COM, AFTER, { moves, typical });

  it('traz o Atual de cada medida com o Anterior e "acima/abaixo do anterior" como fato sobre os dois números', () => {
    expect(texto).toContain('<b>CPI — saiu o resultado</b>');
    expect(texto).toContain('No mês: <b>+0,2%</b> (anterior +0,3%) — abaixo do anterior');
    expect(texto).toContain('Em 12 meses: <b>+3,1%</b> (anterior +3,0%) — acima do anterior');
    expect(texto).toContain('mês anterior revisado para +0,4%');
    expect(texto).toContain('Fonte dos números: BLS.');
  });

  it('o BTC desde a divulgação: cada prazo com seu valor ou "ainda não passou"; e o tamanho típico das últimas divulgações', () => {
    expect(texto).toContain('<b>BTC desde a divulgação:</b> 5 min −0,10% · 30 min +0,25% · 60 min ainda não passou');
    expect(texto).toContain('Nas últimas 3 divulgações de CPI, o tamanho mediano do movimento em 1 h foi 0,40%.');
  });

  it('não chama de surpresa: diz que sem a projeção do mercado isso não dá para dizer', () => {
    expect(texto).toContain('Sem a projeção do mercado (dado pago) não dá para dizer se o número foi surpresa.');
    expect(texto.trimEnd().endsWith(NEUTRAL_NOTE)).toBe(true);
  });

  it('BLS sem o número, PCE/FOMC e fonte de preços fora do ar: cada um diz a sua verdade', () => {
    const semNumero = buildResultMessage({ ...COM, values: undefined }, AFTER, { moves, typical: null });
    expect(semNumero).toContain('O número oficial do BLS ainda não chegou ao sistema');
    expect(semNumero).not.toContain('Fonte dos números');
    expect(semNumero).not.toContain('Nas últimas');
    const pce = buildResultMessage({ ...COM, kind: 'PCE', values: undefined }, AFTER, { moves, typical: null });
    expect(pce).toContain('O número oficial da BEA ainda não chegou ao sistema.');
    const fomc = buildResultMessage({ ...COM, kind: 'FOMC', values: undefined }, AFTER, { moves, typical: null });
    expect(fomc).toContain('Este tipo não tem número oficial coletado automaticamente');
    const semPreco = buildResultMessage(COM, AFTER, { moves: null, typical: null });
    expect(semPreco).toContain('BTC desde a divulgação:</b> indisponível agora');
  });

  it('1 divulgação anterior só: singular', () => {
    expect(buildResultMessage(COM, AFTER, { moves, typical: { n: 1, medAbs60: 0.2 } })).toContain('Na última divulgação de CPI');
  });

  it('TEXTO NEUTRO em todas as variações (sem probabilidade, compra, venda, recomendação, "vai subir/cair")', () => {
    const variacoes = [
      texto,
      buildResultMessage({ ...COM, values: undefined }, AFTER, { moves: null }),
      buildResultMessage({ ...COM, kind: 'FOMC', values: undefined }, AFTER),
      buildResultMessage(COM, AFTER, { moves: { 5: null, 30: null, 60: null }, typical }),
    ];
    for (const m of variacoes) {
      expect(m).not.toMatch(PROIBIDO);
      expect(m.length).toBeLessThan(1800);
    }
  });

  it('o que vem de arquivo público é escapado', () => {
    const m = buildResultMessage({ ...COM, values: { ...COM.values, actual: '<i>&x</i> m/m' } }, AFTER, { moves });
    expect(m).not.toContain('<i>');
  });
});

describe('categoria "resultado"', () => {
  it('só existe no envio automático (não está no botão manual) e vem ligada por padrão junto com o aviso de antes', () => {
    expect(AUTOMATIC_ONLY).toEqual(['resultado', 'resumo']);
    expect(isCategoryEnabled('resumo', '')).toBe(true); // resumo do dia (addendum 35): ligado por padrão
    expect(isCategoryEnabled('resumo', 'pre-evento,resultado')).toBe(false);
    expect(isCategoryEnabled('resumo', 'resumo')).toBe(true);
    expect(isCategoryEnabled('resumo', 'nenhuma')).toBe(false);
    expect(CATEGORIES).not.toContain('resultado');
    expect([...DEFAULT_CATEGORIES].sort()).toEqual(['pre-evento', 'resultado', 'resumo']);
    expect(isCategoryEnabled('resultado', '')).toBe(true);
    expect(isCategoryEnabled('resultado', 'pre-evento')).toBe(false); // lista: só o listado
    expect(isCategoryEnabled('resultado', 'resultado')).toBe(true);
    expect(isCategoryEnabled('resultado', 'nenhuma')).toBe(false);
  });
});

// Fase 4b-4 (addendum 30): a projeção que o usuário registrou.
describe('com a projeção registrada pelo usuário', () => {
  const CPI2 = readEvents([{ ...ev('CPI-2026-12-10', 'CPI', '2026-12-10T13:30:00.000Z'), reference: '2026-11', values: { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,2% m/m · +3,1% a/a', source: 'BLS' } }])[0];
  const AT2 = Date.parse('2026-12-10T14:10:00.000Z');
  const moves = { 5: -0.1, 30: 0.25, 60: null };

  it('aviso de antes: mostra a projeção como DO USUÁRIO (não do mercado) e troca o "indisponível"', () => {
    const m = buildPreEventBriefing(CPI2, AT2 - 90 * 60000, { consensus: { projection: '+0,3% m/m · +3,1% a/a', previous: null } });
    expect(m).toContain('<b>Projeção (informada por você):</b> +0,3% m/m · +3,1% a/a — não é o consenso oficial do mercado.');
    expect(m).not.toContain('Projeção do mercado (consenso):</b> indisponível');
    expect(m).not.toMatch(PROIBIDO);
  });
  it('aviso de antes sem projeção: continua dizendo "indisponível" e ensina onde registrar', () => {
    const m = buildPreEventBriefing(CPI2, AT2 - 90 * 60000, { consensus: null });
    expect(m).toContain('Projeção do mercado (consenso):</b> indisponível');
    expect(m).toContain('Registrar projeção do Contexto');
  });
  it('"Anterior": o do BLS vence; sem ele, o que o usuário registrou (PCE/FOMC); sem nenhum, a explicação', () => {
    expect(buildPreEventBriefing(CPI2, AT2, { consensus: { previous: '+9,9% m/m' } })).toContain('Anterior (BLS):</b> +0,3% m/m');
    const pce = { ...CPI2, kind: 'PCE', values: undefined };
    expect(buildPreEventBriefing(pce, AT2, { consensus: { previous: '+0,3% m/m' } })).toContain('<b>Anterior (informado por você):</b> +0,3% m/m');
    expect(buildPreEventBriefing(pce, AT2, { consensus: null })).toContain('indisponível agora (a BEA não respondeu');
    // Com os números da BEA (addendum 33), o oficial vence o digitado.
    const pceBea = { ...pce, values: { previous: '+0,5% m/m · +2,8% a/a', core_previous: '+0,3% m/m · +2,9% a/a', source: 'BEA' } };
    const m = buildPreEventBriefing(pceBea, AT2, { consensus: { previous: '+0,3% m/m' } });
    expect(m).toContain('<b>Anterior (BEA):</b> PCE cheio +0,5% m/m · +2,8% a/a · núcleo (sem alimentos e energia) +0,3% m/m · +2,9% a/a');
    expect(m).not.toContain('informado por você):</b> +0,3% m/m');
    const fomc = { ...CPI2, kind: 'FOMC', values: undefined };
    expect(buildPreEventBriefing(fomc, AT2, { consensus: null })).toContain('sem fonte oficial automática');
  });
  it('resultado: acima/abaixo/igual à projeção, medida por medida, e o rodapé diz que a projeção é a do usuário', () => {
    const m = buildResultMessage(CPI2, AT2, { moves, consensus: { projection: '+0,3% m/m · +3,1% a/a' } });
    expect(m).toContain('No mês: <b>+0,2%</b> (anterior +0,3%) — abaixo do anterior · abaixo da projeção (+0,3%)');
    expect(m).toContain('Em 12 meses: <b>+3,1%</b> (anterior +3,0%) — acima do anterior · igual à projeção (+3,1%)');
    expect(m).toContain('A projeção é a que você registrou (não é o consenso oficial do mercado)');
    expect(m).not.toContain('não dá para dizer se o número foi surpresa');
    expect(m).not.toMatch(PROIBIDO);
  });
  it('resultado: projeção só do mês compara só o mês; sem projeção volta ao texto de antes', () => {
    const soMes = buildResultMessage(CPI2, AT2, { moves, consensus: { projection: '+0,1% m/m' } });
    expect(soMes).toContain('acima da projeção (+0,1%)');
    expect(soMes).not.toContain('igual à projeção');
    const sem = buildResultMessage(CPI2, AT2, { moves, consensus: null });
    expect(sem).not.toContain('da projeção');
    expect(sem).toContain('Sem a projeção do mercado (dado pago) não dá para dizer se o número foi surpresa.');
  });
  it('resultado sem número oficial (BLS ainda sem o dado, PCE/FOMC): lembra a projeção do usuário sem inventar comparação', () => {
    const semBls = buildResultMessage({ ...CPI2, values: undefined }, AT2, { moves, consensus: { projection: '+0,3% m/m' } });
    expect(semBls).toContain('Sua projeção era: +0,3% m/m.');
    expect(semBls).not.toContain('acima da projeção');
    expect(semBls).toContain('Sem a projeção do mercado'); // nada foi comparado: o rodapé antigo continua
    const fomc = buildResultMessage({ ...CPI2, kind: 'FOMC', values: undefined }, AT2, { moves, consensus: { projection: '3,75%' } });
    expect(fomc).toContain('Sua projeção era: 3,75% — confira o resultado no site do órgão.');
  });
  it('FOMC: a projeção é a taxa; com o anterior registrado, diz o que ela implica (corte/alta/manter) como conta sobre os dois números', () => {
    const fomc = { ...CPI2, kind: 'FOMC', values: undefined };
    expect(buildPreEventBriefing(fomc, AT2, { consensus: { projection: '3,75%', previous: '4,00%' } }))
      .toContain('<b>Projeção (informada por você):</b> 3,75% — corte de 0,25 p.p. (de 4,00% para 3,75%) — não é o consenso oficial do mercado.');
    expect(buildPreEventBriefing(fomc, AT2, { consensus: { projection: '4,00%', previous: '4,00%' } })).toContain('3,75%'.replace('3,75%', '4,00% — manter em 4,00%'));
    const semAnterior = buildPreEventBriefing(fomc, AT2, { consensus: { projection: '3,75%' } });
    expect(semAnterior).toContain('<b>Projeção (informada por você):</b> 3,75% — não é o consenso oficial do mercado.');
    expect(semAnterior).not.toMatch(PROIBIDO);
  });

  it('o que o usuário digitou é escapado', () => {
    expect(buildPreEventBriefing(CPI2, AT2, { consensus: { projection: '<b>&x</b>' } })).toContain('&lt;b&gt;&amp;x&lt;/b&gt;');
  });
});

// Addendum 33: o PCE com os números oficiais da BEA — o cheio e o núcleo lado a lado, sem comparar com a projeção (o TradingView tem duas linhas).
describe('PCE com os números da BEA (cheio e núcleo)', () => {
  const PCE = readEvents([{ ...ev('PCE-2026-11-25', 'PCE', '2026-11-25T13:30:00.000Z'), reference: '2026-10', values: {
    previous: '+0,5% m/m · +2,8% a/a', actual: '+0,3% m/m · +2,8% a/a', revised: '+0,4% m/m · +2,8% a/a',
    core_previous: '+0,3% m/m · +2,9% a/a', core_actual: '+0,2% m/m · +2,8% a/a', source: 'BEA',
  } }])[0];
  const DEPOIS = Date.parse('2026-11-25T14:10:00.000Z');
  const moves = { 5: 0.1, 30: -0.2, 60: null };

  it('o arquivo público chega ao aviso com o núcleo (o leitor da tela não o descarta)', () => {
    expect(PCE.values.core_previous).toBe('+0,3% m/m · +2,9% a/a');
    expect(PCE.values.core_actual).toBe('+0,2% m/m · +2,8% a/a');
    expect(PCE.values.source).toBe('BEA');
  });

  it('resultado: uma linha por medida do PCE cheio e do núcleo, com o anterior, a revisão e a fonte BEA', () => {
    const m = buildResultMessage(PCE, DEPOIS, { moves });
    expect(m).toContain('PCE cheio — no mês: <b>+0,3%</b> (anterior +0,5%) — abaixo do anterior; mês anterior revisado para +0,4%');
    expect(m).toContain('PCE cheio — em 12 meses: <b>+2,8%</b> (anterior +2,8%) — igual ao anterior');
    expect(m).toContain('Núcleo — no mês: <b>+0,2%</b> (anterior +0,3%) — abaixo do anterior');
    expect(m).toContain('Núcleo — em 12 meses: <b>+2,8%</b> (anterior +2,9%) — abaixo do anterior');
    expect(m).toContain('Fonte dos números: BEA.');
    expect(m).not.toMatch(PROIBIDO);
  });

  it('a projeção digitada NÃO é comparada no PCE (não se sabe de qual linha veio): aparece com o aviso das duas linhas', () => {
    const m = buildResultMessage(PCE, DEPOIS, { moves, consensus: { projection: '+0,3% m/m · +3,1% a/a' } });
    expect(m).not.toContain('da projeção');
    expect(m).toContain('Sua projeção era: +0,3% m/m · +3,1% a/a — o TradingView mostra duas linhas (PCE e Core PCE): ela vale para a linha que você copiou.');
    expect(m).toContain('Sem a projeção do mercado (dado pago) não dá para dizer se o número foi surpresa.');
    const antes = buildPreEventBriefing({ ...PCE, values: { previous: PCE.values.previous, core_previous: PCE.values.core_previous, source: 'BEA' } }, DEPOIS - 2 * 3600000, { consensus: { projection: '+0,3% m/m' } });
    expect(antes).toContain('<b>Projeção (informada por você):</b> +0,3% m/m (o TradingView mostra duas linhas (PCE e Core PCE): ela vale para a linha que você copiou) — não é o consenso oficial do mercado.');
  });

  it('só o PCE cheio (núcleo não veio): a mensagem não inventa o núcleo', () => {
    const so = { ...PCE, values: { previous: '+0,5% m/m', actual: '+0,3% m/m', source: 'BEA' } };
    const m = buildResultMessage(so, DEPOIS, { moves });
    expect(m).toContain('PCE cheio — no mês: <b>+0,3%</b>');
    expect(m).not.toContain('Núcleo');
    const antes = buildPreEventBriefing({ ...so, values: { previous: '+0,5% m/m', source: 'BEA' } }, DEPOIS - 2 * 3600000);
    expect(antes).toContain('PCE cheio +0,5% m/m · núcleo (sem alimentos e energia) indisponível');
  });
});

// Fase 4c (addendum 35): o resumo do dia.
describe('buildDaySummary: o que saiu hoje, o BTC e o que vem a seguir', () => {
  const NOITE = Date.parse('2026-11-20T00:10:00Z'); // 21:10 de Brasília de 19/11
  const cpi = { ...ev('CPI-2026-11-19', 'CPI', '2026-11-19T13:30:00.000Z'), reference: '2026-10', values: { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,2% m/m · +3,1% a/a', source: 'BLS' } };
  const pce = { ...ev('PCE-2026-11-19', 'PCE', '2026-11-19T13:30:00.000Z'), reference: '2026-10', values: {
    previous: '+0,5% m/m · +3,3% a/a', actual: '+0,3% m/m · +3,3% a/a', core_previous: '+0,3% m/m · +3,1% a/a', core_actual: '+0,2% m/m · +3,0% a/a', source: 'BEA' } };
  const fomc = ev('FOMC-2026-11-19', 'FOMC', '2026-11-19T19:00:00.000Z');
  const proximo = ev('PPI-2026-11-25', 'PPI', '2026-11-25T13:30:00.000Z');
  const todos = readEvents([cpi, pce, fomc, proximo]);
  const doDia = eventsOfDay(todos, '2026-11-19', NOITE);
  const moves = new Map([['CPI-2026-11-19', { 5: -0.1, 30: 0.25, 60: 0.4 }], ['PCE-2026-11-19', { 5: 0.05, 30: null, 60: null }]]);
  const texto = buildDaySummary({ day: '2026-11-19', events: doDia, agenda: todos, nowMs: NOITE, moves, btcDay: { pct: 0.85, rangePct: 2.1 } });

  it('cabeçalho com o dia de Brasília e a contagem das divulgações', () => {
    expect(texto).toContain('<b>Resumo do dia — qui, 19/11</b>');
    expect(texto).toContain('Saíram 3 divulgações monitoradas hoje:');
    expect(buildDaySummary({ day: '2026-11-19', events: [doDia[0]], nowMs: NOITE })).toContain('Saiu 1 divulgação monitorada hoje:');
  });
  it('cada divulgação traz os números oficiais (mesmo bloco do aviso de resultado) e o BTC depois dela', () => {
    expect(texto).toContain('No mês: <b>+0,2%</b> (anterior +0,3%) — abaixo do anterior');
    expect(texto).toContain('Fonte dos números: BLS.');
    expect(texto).toContain('🕒 BTC depois: 5 min −0,10% · 30 min +0,25% · 60 min +0,40%');
    // PCE: cheio e núcleo lado a lado, fonte BEA; prazo que ainda não passou diz isso
    expect(texto).toContain('PCE cheio — no mês: <b>+0,3%</b> (anterior +0,5%)');
    expect(texto).toContain('Núcleo — no mês: <b>+0,2%</b> (anterior +0,3%)');
    expect(texto).toContain('Fonte dos números: BEA.');
    expect(texto).toContain('BTC depois: 5 min +0,05% · 30 min ainda não passou · 60 min ainda não passou');
    // FOMC: sem número automático, e sem movimento medido = "indisponível" (não inventa)
    expect(texto).toContain('Este tipo não tem número oficial coletado automaticamente');
    expect(texto).toMatch(/FOMC<\/b>[\s\S]*BTC depois: indisponível agora/);
  });
  it('BTC no dia: variação contra a abertura e amplitude; fonte fora do ar diz "indisponível"', () => {
    expect(texto).toContain('<b>BTC no dia</b> (de 00:00 até agora, Brasília): +0,85% contra a abertura · amplitude de 2,10% entre a mínima e a máxima.');
    expect(buildDaySummary({ day: '2026-11-19', events: doDia, nowMs: NOITE })).toContain('<b>BTC no dia:</b> indisponível agora');
    expect(buildDaySummary({ day: '2026-11-19', events: doDia, nowMs: NOITE, btcDay: { pct: -1.2, rangePct: 0.5 } })).toContain('−1,20% contra a abertura');
  });
  it('o que vem a seguir: só o que ainda não começou, com a data e a situação; sem nada à frente diz isso', () => {
    expect(texto).toContain('<b>O que vem a seguir:</b>');
    expect(texto).toMatch(/• <b>PPI<\/b> — qua 25\/11, 10:30 \(Brasília\) · em 5d 13h · oficial/);
    expect(texto).not.toMatch(/• <b>CPI<\/b>/); // o do dia não volta como "a seguir"
    expect(buildDaySummary({ day: '2026-11-19', events: doDia, agenda: [], nowMs: NOITE })).toContain('nenhum evento na agenda por enquanto');
  });
  it('a projeção digitada pelo usuário segue as mesmas regras do aviso de resultado (CPI compara; PCE não compara)', () => {
    const consensusOf = (e) => (e.kind === 'CPI' ? { projection: '+0,3% m/m · +3,1% a/a' } : e.kind === 'PCE' ? { projection: '+0,3% m/m' } : null);
    const m = buildDaySummary({ day: '2026-11-19', events: doDia, nowMs: NOITE, consensusOf });
    expect(m).toContain('abaixo da projeção (+0,3%)');
    expect(m).not.toMatch(/PCE cheio[^\n]*da projeção/);
    expect(m).toContain('Sua projeção era: +0,3% m/m — o TradingView mostra duas linhas');
  });
  it('TEXTO NEUTRO em todas as variações; cabe folgado no limite do Telegram; escapa HTML', () => {
    const variacoes = [
      texto,
      buildDaySummary({ day: '2026-11-19', events: doDia, nowMs: NOITE }),
      buildDaySummary({ day: '2026-11-19', events: [fomc].map((e) => readEvents([e])[0]), agenda: [], nowMs: NOITE, btcDay: { pct: 3, rangePct: 6 } }),
    ];
    for (const m of variacoes) {
      expect(m).not.toMatch(PROIBIDO);
      expect(m.trimEnd().endsWith(NEUTRAL_NOTE)).toBe(true);
      expect(m.length).toBeLessThan(3000);
    }
    const sujo = readEvents([{ ...cpi, values: { ...cpi.values, actual: '<i>&x</i> m/m' } }]);
    expect(buildDaySummary({ day: '2026-11-19', events: sujo, nowMs: NOITE })).not.toContain('<i>');
  });
});
