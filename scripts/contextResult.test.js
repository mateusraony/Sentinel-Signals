// Item 285, addendum 15 — o RESULTADO no events.json do Contexto de Mercado: "Atual" e "Revisado" do BLS, o histórico de 45 dias e o
// modo "janela" do coletor. Rede toda simulada. O que se prova:
//  - antes da hora do evento NUNCA existe "Atual" (mesmo que a série já traga o mês);
//  - depois da hora, o "Atual" entra no 1º instante em que o BLS traz o mês (completo) e, se o BLS corrigiu o mês anterior, o
//    "Revisado" entra junto; daí em diante tudo fica CONGELADO;
//  - evento divulgado COM "Atual" fica 45 dias; sem "Atual", 1 dia; evento que já aconteceu nunca é rebaixado para "a confirmar";
//  - a trava pública só aceita {previous?, actual?, revised?, source:'BLS'} no formato único;
//  - o modo "janela" só trabalha quando há resultado esperando (senão: zero rede, zero escrita) e só o valor exato liga o modo.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FRED_RELEASES, VALUES_KEYS, HISTORY_DAYS, RESULT_WATCH_MS, buildEvents, buildStatus, assertPublicShape, sanitizeValues, needsResultCheck,
} from './contextCollect.mjs';
import { main, resolveMode } from './context-collect.mjs';
import { actualValueText, previousValueText } from './contextBls.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z'); // antes de tudo
const CPI_AT = Date.parse('2026-11-10T13:30:00Z'); // CPI (mede outubro)
const AFTER_CPI = CPI_AT + 30 * 60000;
const FRED = {
  CPI: ['2026-10-14', '2026-11-10', '2026-12-10'],
  NFP: ['2026-10-02', '2026-11-06', '2026-12-04'],
  PPI: ['2026-10-15', '2026-11-13', '2026-12-15'],
  PCE: ['2026-10-29', '2026-11-25', '2026-12-23'],
};
const byId = (events) => Object.fromEntries(events.map((e) => [e.id, e]));
const mapa = (pontos) => new Map(pontos);

// Séries SEM outubro: o BLS ainda não divulgou (setembro é o último mês).
const ANTES = {
  CUSR0000SA0: mapa([['2026-09', 100.3], ['2026-08', 100]]),
  CUUR0000SA0: mapa([['2026-09', 103], ['2025-09', 100], ['2025-10', 100]]),
  WPSFD4: mapa([['2026-09', 149.7], ['2026-08', 150]]),
  WPUFD4: mapa([['2026-09', 150.96], ['2025-09', 148], ['2025-10', 149]]),
  CES0000000001: mapa([['2026-09', 159119], ['2026-08', 159000]]),
};
// Séries COM outubro (o BLS acabou de divulgar).
const DEPOIS = {
  CUSR0000SA0: mapa([...ANTES.CUSR0000SA0, ['2026-10', 100.8]]), // +0,5% m/m (100,8 / 100,3)
  CUUR0000SA0: mapa([...ANTES.CUUR0000SA0, ['2026-10', 104]]), // +4,0% a/a (104 / 100)
  WPSFD4: mapa([...ANTES.WPSFD4, ['2026-10', 150.5]]), // +0,5% m/m (150,5 / 149,7)
  WPUFD4: mapa([...ANTES.WPUFD4, ['2026-10', 152]]), // +2,0% a/a (152 / 149)
  CES0000000001: mapa([...ANTES.CES0000000001, ['2026-10', 159200]]), // +81 mil (159200 - 159119)
};
// O BLS corrigiu setembro junto com a divulgação de outubro: CPI SA 100,3 → 100,4 e Payroll 159119 → 159150.
const DEPOIS_REVISADO = {
  ...DEPOIS,
  CUSR0000SA0: mapa([['2026-09', 100.4], ['2026-08', 100], ['2026-10', 100.8]]),
  CES0000000001: mapa([['2026-09', 159150], ['2026-08', 159000], ['2026-10', 159200]]),
};
// CASO REAL de 10/11/2026 (1º CPI depois do shutdown de 2025; achado ao vivo, addendum 19): as DUAS séries já trazem outubro de 2026, mas a de 12 meses não tem
// o índice de outubro de 2025 (base), então o "em 12 meses" de outubro NÃO dá para calcular. O "Atual" tem de entrar só com o mês, e não esperar para sempre.
const SEM_BASE_DE_12_MESES = {
  ...DEPOIS,
  CUUR0000SA0: mapa([['2026-09', 103], ['2025-09', 100], ['2026-10', 104]]), // sem '2025-10'
  WPUFD4: mapa([['2026-09', 150.96], ['2025-09', 148], ['2026-10', 152]]), // sem '2025-10'
};
const CPI_ANTERIOR = '+0,3% m/m · +3,0% a/a';
const CPI_ATUAL = '+0,5% m/m · +4,0% a/a';
const CPI_ATUAL_SO_MES = '+0,5% m/m';

const publicar = (nowMs, blsSeries, previous = []) => buildEvents({ fredDatesByKind: FRED, nowMs, previous, blsSeries });

describe('números de um mês (actualValueText / previousValueText)', () => {
  it('o "Atual" é o número do PRÓPRIO mês de referência; o "Anterior", o do mês anterior', () => {
    expect(actualValueText('CPI', DEPOIS, '2026-10')).toBe(CPI_ATUAL);
    expect(previousValueText('CPI', DEPOIS, '2026-10')).toBe(CPI_ANTERIOR);
    expect(actualValueText('PPI', DEPOIS, '2026-10')).toBe('+0,5% m/m · +2,0% a/a');
    expect(actualValueText('NFP', DEPOIS, '2026-10')).toBe('+81 mil');
  });

  it('sem o mês na série (o BLS ainda não divulgou) não há "Atual"', () => {
    for (const kind of ['CPI', 'PPI', 'NFP']) expect(actualValueText(kind, ANTES, '2026-10'), kind).toBeNull();
  });

  it('CPI/PPI só valem quando as DUAS séries já trazem o mês: com o mês só na série mensal (a de 12 meses ainda sem ele) espera; Payroll tem um número só e vale', () => {
    const meio = { ...DEPOIS, CUUR0000SA0: ANTES.CUUR0000SA0, WPUFD4: ANTES.WPUFD4 };
    expect(actualValueText('CPI', meio, '2026-10')).toBeNull();
    expect(actualValueText('PPI', meio, '2026-10')).toBeNull();
    expect(actualValueText('NFP', meio, '2026-10')).toBe('+81 mil');
    // o inverso também é metade publicada: a série de 12 meses já tem o mês e a mensal ainda não
    const inverso = { ...DEPOIS, CUSR0000SA0: ANTES.CUSR0000SA0, WPSFD4: ANTES.WPSFD4 };
    expect(actualValueText('CPI', inverso, '2026-10')).toBeNull();
    expect(actualValueText('PPI', inverso, '2026-10')).toBeNull();
  });

  it('REPRODUZ o CPI de 10/11/2026: as duas séries trazem o mês mas falta a base de 12 meses → o "Atual" vale SÓ com o mês (nunca espera para sempre)', () => {
    expect(actualValueText('CPI', SEM_BASE_DE_12_MESES, '2026-10')).toBe(CPI_ATUAL_SO_MES);
    expect(actualValueText('PPI', SEM_BASE_DE_12_MESES, '2026-10')).toBe('+0,5% m/m');
    expect(actualValueText('NFP', SEM_BASE_DE_12_MESES, '2026-10')).toBe('+81 mil'); // Payroll não muda
    // o "Anterior" (setembro) segue completo: a base de setembro de 2025 existe
    expect(previousValueText('CPI', SEM_BASE_DE_12_MESES, '2026-10')).toBe(CPI_ANTERIOR);
  });

  it('as duas séries trazem o mês mas NENHUMA parte dá para calcular (sem o mês anterior e sem a base): continua sem "Atual" (nada de texto vazio)', () => {
    const nada = { CUSR0000SA0: mapa([['2026-10', 100.8]]), CUUR0000SA0: mapa([['2026-10', 104]]) };
    expect(actualValueText('CPI', nada, '2026-10')).toBeNull();
  });

  it('referência ausente ou mal formada, tipo sem BLS (PCE, FOMC) e série nula: null', () => {
    for (const ref of [null, undefined, '', '2026-13', '2026-1', 'outubro']) expect(actualValueText('CPI', DEPOIS, ref), String(ref)).toBeNull();
    expect(actualValueText('PCE', DEPOIS, '2026-10')).toBeNull();
    expect(actualValueText('FOMC', DEPOIS, '2026-10')).toBeNull();
    expect(actualValueText('CPI', { CUSR0000SA0: null, CUUR0000SA0: null }, '2026-10')).toBeNull();
    expect(actualValueText('CPI', null, '2026-10')).toBeNull();
  });
});

describe('"Atual" e "Revisado" no events.json (addendum 15)', () => {
  it('ANTES da hora do evento nunca há "Atual", mesmo que a série já traga o mês', () => {
    const cpi = byId(publicar(NOW, DEPOIS))['CPI-2026-11-10'];
    expect(cpi.values).toEqual({ previous: CPI_ANTERIOR, source: 'BLS' });
  });

  it('DEPOIS da hora, no 1º instante em que o BLS traz o mês: grava o "Atual" e mantém o "Anterior" (sem "Revisado" se o BLS não mexeu)', () => {
    const pub = publicar(NOW, ANTES);
    const ev = byId(publicar(AFTER_CPI, DEPOIS, pub));
    expect(ev['CPI-2026-11-10'].values).toEqual({ previous: CPI_ANTERIOR, actual: CPI_ATUAL, source: 'BLS' });
    expect(Object.keys(ev['CPI-2026-11-10'].values)).toEqual(['previous', 'actual', 'source']);
    // O Payroll de 06/11 também já saiu nesta data.
    expect(ev['NFP-2026-11-06'].values).toEqual({ previous: '+119 mil', actual: '+81 mil', source: 'BLS' });
    // O PPI (13/11) ainda é futuro: segue só com o "Anterior".
    expect(ev['PPI-2026-11-13'].values).toEqual({ previous: '-0,2% m/m · +2,0% a/a', source: 'BLS' });
  });

  it('se o BLS corrigiu o mês anterior junto com a divulgação, o "Revisado" entra ao lado do "Anterior" (que fica como foi publicado)', () => {
    const pub = publicar(NOW, ANTES);
    const ev = byId(publicar(AFTER_CPI, DEPOIS_REVISADO, pub));
    expect(ev['CPI-2026-11-10'].values).toEqual({ previous: CPI_ANTERIOR, actual: '+0,4% m/m · +4,0% a/a', revised: '+0,4% m/m · +3,0% a/a', source: 'BLS' });
    expect(Object.keys(ev['CPI-2026-11-10'].values)).toEqual(['previous', 'actual', 'revised', 'source']);
    expect(ev['NFP-2026-11-06'].values).toEqual({ previous: '+119 mil', actual: '+50 mil', revised: '+150 mil', source: 'BLS' });
  });

  it('depois que o "Atual" entra tudo fica CONGELADO: nova revisão do BLS não troca o que saiu na divulgação', () => {
    const pub = publicar(NOW, ANTES);
    const primeira = publicar(AFTER_CPI, DEPOIS, pub);
    const outraRevisao = { ...DEPOIS_REVISADO, CUSR0000SA0: mapa([['2026-09', 100.2], ['2026-08', 100], ['2026-10', 101]]) };
    const depois = publicar(AFTER_CPI + 3 * 3600000, outraRevisao, primeira);
    expect(byId(depois)['CPI-2026-11-10'].values).toEqual(byId(primeira)['CPI-2026-11-10'].values);
    expect(byId(depois)['NFP-2026-11-06'].values).toEqual(byId(primeira)['NFP-2026-11-06'].values);
  });

  it('o BLS ainda não trouxe o mês: mantém o "Anterior" publicado; a coleta seguinte, já com o mês, grava o "Atual"', () => {
    const pub = publicar(NOW, ANTES);
    const cedo = publicar(AFTER_CPI, ANTES, pub);
    expect(byId(cedo)['CPI-2026-11-10'].values).toEqual({ previous: CPI_ANTERIOR, source: 'BLS' });
    const tarde = publicar(AFTER_CPI + 600000, DEPOIS, cedo);
    expect(byId(tarde)['CPI-2026-11-10'].values).toEqual({ previous: CPI_ANTERIOR, actual: CPI_ATUAL, source: 'BLS' });
  });

  it('BLS fora do ar depois da hora: nada muda, nada some', () => {
    const pub = publicar(NOW, ANTES);
    for (const blsSeries of [null, {}, { CUSR0000SA0: null, CUUR0000SA0: null }]) {
      expect(byId(publicar(AFTER_CPI, blsSeries, pub))['CPI-2026-11-10'].values, JSON.stringify(blsSeries)).toEqual({ previous: CPI_ANTERIOR, source: 'BLS' });
    }
  });

  it('CPI só com a série mensal (falta a de 12 meses) NÃO congela pela metade: espera; o Payroll, que é um número só, entra', () => {
    const pub = publicar(NOW, ANTES);
    const meio = { ...DEPOIS, CUUR0000SA0: ANTES.CUUR0000SA0 };
    const ev = byId(publicar(AFTER_CPI, meio, pub));
    expect(ev['CPI-2026-11-10'].values).toEqual({ previous: CPI_ANTERIOR, source: 'BLS' });
    expect(ev['NFP-2026-11-06'].values.actual).toBe('+81 mil');
    const completo = byId(publicar(AFTER_CPI + 600000, DEPOIS, publicar(AFTER_CPI, meio, pub)));
    expect(completo['CPI-2026-11-10'].values.actual).toBe(CPI_ATUAL);
  });

  it('REPRODUZ o CPI de 10/11/2026 no events.json: sem a base de 12 meses o "Atual" congela só com o mês, na 1ª coleta, e nunca mais muda', () => {
    const pub = publicar(NOW, ANTES);
    const primeira = publicar(AFTER_CPI, SEM_BASE_DE_12_MESES, pub);
    expect(byId(primeira)['CPI-2026-11-10'].values).toEqual({ previous: CPI_ANTERIOR, actual: CPI_ATUAL_SO_MES, source: 'BLS' });
    const outraRevisao = { ...SEM_BASE_DE_12_MESES, CUSR0000SA0: mapa([['2026-09', 100.2], ['2026-08', 100], ['2026-10', 101]]) };
    const depois = publicar(AFTER_CPI + 3 * 3600000, outraRevisao, primeira);
    expect(byId(depois)['CPI-2026-11-10'].values).toEqual(byId(primeira)['CPI-2026-11-10'].values);
    expect(sanitizeValues(byId(primeira)['CPI-2026-11-10'].values)).not.toBeNull(); // a trava pública aceita o "Atual" só com o mês
  });

  it('evento visto pela 1ª vez JÁ divulgado (sem "Anterior" publicado): o "Anterior" é o melhor valor disponível e não há "Revisado"', () => {
    const ev = byId(publicar(AFTER_CPI, DEPOIS_REVISADO, []));
    expect(ev['CPI-2026-11-10'].values).toEqual({ previous: '+0,4% m/m · +3,0% a/a', actual: '+0,4% m/m · +4,0% a/a', source: 'BLS' });
  });

  it('evento sem mês de referência, PCE e FOMC nunca ganham "Atual"', () => {
    const ev = byId(publicar(Date.parse('2026-12-31T00:00:00Z'), DEPOIS));
    expect(ev['FOMC-2026-12-09']).toBeUndefined();
    const dezembro = byId(publicar(Date.parse('2026-12-09T20:00:00Z'), DEPOIS));
    expect(dezembro['FOMC-2026-12-09'].values).toBeNull();
    expect(dezembro['PCE-2026-11-25'] ?? { values: null }).toMatchObject({ values: null });
  });
});

describe('histórico de 45 dias e eventos que já aconteceram', () => {
  const comAtual = () => publicar(AFTER_CPI, DEPOIS, publicar(NOW, ANTES));

  it('evento divulgado COM "Atual" fica HISTORY_DAYS dias; passado esse prazo some', () => {
    expect(HISTORY_DAYS).toBe(45);
    const pub = comAtual();
    const dia20 = byId(publicar(Date.parse('2026-11-30T12:00:00Z'), DEPOIS, pub));
    expect(dia20['CPI-2026-11-10'].values.actual).toBe(CPI_ATUAL);
    expect(dia20['NFP-2026-11-06'].values.actual).toBe('+81 mil');
    const dia44 = byId(publicar(CPI_AT + 44 * 86400000, DEPOIS, pub));
    expect(dia44['CPI-2026-11-10']).toBeDefined();
    const dia46 = byId(publicar(CPI_AT + 46 * 86400000, DEPOIS, pub));
    expect(dia46['CPI-2026-11-10']).toBeUndefined();
  });

  it('evento divulgado SEM "Atual" some depois de 1 dia, como sempre foi', () => {
    const semAtual = publicar(NOW, ANTES);
    expect(byId(publicar(CPI_AT + 12 * 3600000, ANTES, semAtual))['CPI-2026-11-10']).toBeDefined();
    expect(byId(publicar(CPI_AT + 25 * 3600000, ANTES, semAtual))['CPI-2026-11-10']).toBeUndefined();
    expect(byId(publicar(Date.parse('2026-11-30T12:00:00Z'), ANTES, semAtual))['CPI-2026-11-10']).toBeUndefined();
  });

  it('evento que JÁ aconteceu não vira "a confirmar" quando o FRED deixa a data antiga de fora', () => {
    const pub = comAtual();
    const semADataAntiga = { ...FRED, CPI: ['2026-12-10'] };
    const ev = byId(buildEvents({ fredDatesByKind: semADataAntiga, nowMs: Date.parse('2026-11-20T12:00:00Z'), previous: pub, blsSeries: DEPOIS }));
    expect(ev['CPI-2026-11-10'].status).toBe('oficial');
    expect(ev['CPI-2026-12-10'].status).toBe('oficial'); // futuro e no FRED: não mexe
  });

  it('o mesmo vale para o evento que só existe no arquivo anterior (nem FRED, nem lista fixa)', () => {
    const pub = comAtual();
    // Sem a data de 10/11 no FRED e sem lista fixa: o evento só existe no arquivo anterior.
    const ev = byId(buildEvents({ fredDatesByKind: { ...FRED, CPI: ['2026-12-10'] }, fixedList: [], nowMs: Date.parse('2026-11-20T12:00:00Z'), previous: pub, blsSeries: DEPOIS }));
    expect(ev['CPI-2026-11-10'].status).toBe('oficial');
    expect(ev['CPI-2026-11-10'].values.actual).toBe(CPI_ATUAL);
  });

  it('evento FUTURO que sumiu das fontes continua virando "a confirmar" (a regra antiga não foi afrouxada)', () => {
    const pub = publicar(NOW, ANTES);
    const ev = byId(buildEvents({ fredDatesByKind: { ...FRED, CPI: ['2026-12-10'] }, nowMs: NOW + 3600000, previous: pub, blsSeries: ANTES }));
    expect(ev['CPI-2026-11-10'].status).toBe('a_confirmar');
  });

  it('o status.json não conta o passado na cobertura', () => {
    const ev = comAtual();
    const st = buildStatus({ events: ev, fredDatesByKind: FRED, nowMs: AFTER_CPI });
    expect(Date.parse(st.coverageUntil)).toBeGreaterThan(AFTER_CPI);
    expect(st.eventsCount).toBe(ev.length);
  });
});

describe('data ADIADA pelo FRED nunca vira divulgação (achado do Codex no PR #547)', () => {
  const ADIADO = { ...FRED, CPI: ['2026-11-11', '2026-12-10'] }; // o CPI de 10/11 foi para 11/11
  const publicado = publicar(NOW, ANTES);
  const emBreve = buildEvents({ fredDatesByKind: ADIADO, nowMs: Date.parse('2026-11-05T12:00:00Z'), previous: publicado, blsSeries: ANTES });

  it('antes da hora: a data antiga vira "a confirmar"; depois da hora original continua "a confirmar" (não volta a "oficial")', () => {
    expect(byId(emBreve)['CPI-2026-11-10'].status).toBe('a_confirmar');
    const depois = buildEvents({ fredDatesByKind: ADIADO, nowMs: Date.parse('2026-11-10T14:00:00Z'), previous: emBreve, blsSeries: ANTES });
    expect(byId(depois)['CPI-2026-11-10'].status).toBe('a_confirmar');
    expect(byId(depois)['CPI-2026-11-11'].status).toBe('oficial'); // a nova data segue oficial
  });

  it('mesmo quando o BLS já traz o mês, o evento antigo "a confirmar" NÃO ganha o "Atual" (não foi uma divulgação)', () => {
    const t = Date.parse('2026-11-10T20:00:00Z');
    const ev = byId(buildEvents({ fredDatesByKind: ADIADO, nowMs: t, previous: emBreve, blsSeries: DEPOIS }));
    expect(ev['CPI-2026-11-10'].status).toBe('a_confirmar');
    expect(ev['CPI-2026-11-10'].values).toEqual({ previous: CPI_ANTERIOR, source: 'BLS' });
    expect(ev['CPI-2026-11-10'].values.actual).toBeUndefined();
  });

  it('sem nada publicado antes e fora do FRED depois da hora: "a confirmar" (lado seguro — não se afirma que aconteceu)', () => {
    const ev = byId(buildEvents({ fredDatesByKind: ADIADO, nowMs: Date.parse('2026-11-10T14:00:00Z'), previous: [], blsSeries: ANTES }));
    expect(ev['CPI-2026-11-10'].status).toBe('a_confirmar');
  });

  it('o evento que de fato aconteceu e saiu da janela de 20 datas do FRED continua "oficial" (publicado como oficial)', () => {
    const saiu = publicar(AFTER_CPI, DEPOIS, publicar(NOW, ANTES));
    const ev = byId(buildEvents({ fredDatesByKind: { ...FRED, CPI: ['2026-12-10'] }, nowMs: Date.parse('2026-11-20T12:00:00Z'), previous: saiu, blsSeries: DEPOIS }));
    expect(ev['CPI-2026-11-10'].status).toBe('oficial');
    expect(ev['CPI-2026-11-10'].values.actual).toBe(CPI_ATUAL);
  });
});

describe('trava pública com "Atual" e "Revisado"', () => {
  const OK = { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,5% m/m · +4,0% a/a', revised: '+0,4% m/m · +3,0% a/a', source: 'BLS' };

  it('VALUES_KEYS é a lista fechada dos 4 campos', () => {
    expect(VALUES_KEYS).toEqual(['previous', 'actual', 'revised', 'source']);
  });

  it('sanitizeValues aceita as combinações válidas e devolve SEMPRE na mesma ordem de chaves', () => {
    expect(sanitizeValues(OK)).toEqual(OK);
    expect(Object.keys(sanitizeValues({ source: 'BLS', revised: OK.revised, actual: OK.actual, previous: OK.previous }))).toEqual(['previous', 'actual', 'revised', 'source']);
    expect(sanitizeValues({ previous: OK.previous, source: 'BLS' })).toEqual({ previous: OK.previous, source: 'BLS' });
    expect(sanitizeValues({ actual: OK.actual, source: 'BLS' })).toEqual({ actual: OK.actual, source: 'BLS' }); // sem Anterior (evento visto depois)
  });

  it('recusa: "Revisado" sem "Atual", só a fonte, chave a mais, outra fonte, texto livre, URL, tipo errado, lista e texto', () => {
    const ruins = [
      { previous: OK.previous, revised: OK.revised, source: 'BLS' },
      { revised: OK.revised, source: 'BLS' },
      { source: 'BLS' },
      { ...OK, nota: 'x' },
      { ...OK, source: 'FRED' },
      { ...OK, actual: 'o CPI veio quente' },
      { ...OK, actual: 'https://api.bls.gov/x?registrationkey=abc' },
      { ...OK, revised: 0.4 },
      { ...OK, actual: '+0,5%' }, // sem a unidade
      { ...OK, actual: '+0.5% m/m' }, // ponto
      { ...OK, actual: null },
      [OK.actual], OK.actual, null, undefined,
    ];
    for (const v of ruins) expect(sanitizeValues(v), JSON.stringify(v)).toBeNull();
  });

  it('assertPublicShape deixa passar o evento com os 3 números e barra os plantados', () => {
    const ev = comAtualEvents();
    const st = buildStatus({ events: ev, fredDatesByKind: FRED, nowMs: AFTER_CPI });
    expect(() => assertPublicShape(ev, st)).not.toThrow();
    const cpi = ev.find((e) => e.id === 'CPI-2026-11-10');
    for (const values of [
      { ...OK, actual: 'o CPI veio quente' },
      { previous: OK.previous, revised: OK.revised, source: 'BLS' },
      { ...OK, url: 'https://x.y' },
      { ...OK, source: 'Bloomberg' },
    ]) expect(() => assertPublicShape([{ ...cpi, values }], st), JSON.stringify(values)).toThrow(/conteúdo público recusado/);
  });

  function comAtualEvents() {
    return publicar(AFTER_CPI, DEPOIS_REVISADO, publicar(NOW, ANTES));
  }
});

describe('needsResultCheck — há resultado esperando?', () => {
  const ev = (id, kind, startsAtUtc, values = null, reference = '2026-10') => ({ id, kind, startsAtUtc, reference, values });
  const cpi = ev('CPI-2026-11-10', 'CPI', '2026-11-10T13:30:00.000Z');

  it('sim: evento do BLS com mês de referência que saiu há ≤ 4 h e ainda não tem o "Atual"', () => {
    expect(RESULT_WATCH_MS).toBe(4 * 3600000);
    expect(needsResultCheck([cpi], CPI_AT)).toBe(true); // na hora exata
    expect(needsResultCheck([cpi], CPI_AT + 3600000)).toBe(true);
    expect(needsResultCheck([cpi], CPI_AT + RESULT_WATCH_MS)).toBe(true); // no limite
  });

  it('não: ainda futuro, depois de 4 h, já com "Atual", sem referência, PCE/FOMC ou lista vazia/ruim', () => {
    expect(needsResultCheck([cpi], CPI_AT - 1)).toBe(false);
    expect(needsResultCheck([cpi], CPI_AT + RESULT_WATCH_MS + 1)).toBe(false);
    expect(needsResultCheck([{ ...cpi, values: { previous: CPI_ANTERIOR, actual: CPI_ATUAL, source: 'BLS' } }], CPI_AT + 60000)).toBe(false);
    expect(needsResultCheck([{ ...cpi, reference: null }], CPI_AT + 60000)).toBe(false);
    expect(needsResultCheck([ev('PCE-2026-11-10', 'PCE', cpi.startsAtUtc), ev('FOMC-2026-11-10', 'FOMC', cpi.startsAtUtc)], CPI_AT + 60000)).toBe(false);
    expect(needsResultCheck([], CPI_AT)).toBe(false);
    expect(needsResultCheck(null, CPI_AT)).toBe(false);
    expect(needsResultCheck([null, 7, { kind: 'CPI' }, { ...cpi, startsAtUtc: 'ontem' }], CPI_AT + 60000)).toBe(false);
  });

  it('com o "Anterior" mas sem o "Atual" ainda conta como esperando', () => {
    expect(needsResultCheck([{ ...cpi, values: { previous: CPI_ANTERIOR, source: 'BLS' } }], CPI_AT + 60000)).toBe(true);
  });

  it('"Atual" inválido no arquivo não conta como publicado (o coletor refaz)', () => {
    expect(needsResultCheck([{ ...cpi, values: { previous: CPI_ANTERIOR, actual: 'lixo', source: 'BLS' } }], CPI_AT + 60000)).toBe(true);
  });
});

describe('modo "janela" do coletor (main)', () => {
  const FKEY = 'fredkey0123456789abcdef0123456789';
  const BKEY = 'blskey0123456789abcdef0123456789';
  const blsResp = (series, id) => new Response(JSON.stringify({
    status: 'REQUEST_SUCCEEDED',
    message: [],
    Results: { series: [{ seriesID: id, data: [...series[id].entries()].map(([ym, v]) => ({ year: ym.slice(0, 4), period: `M${ym.slice(5)}`, value: String(v) })) }] },
  }), { status: 200 });
  const fetchCom = (series, contador) => async (url) => {
    contador.n += 1;
    const u = String(url);
    if (u.includes('api.bls.gov')) return blsResp(series, u.slice(u.lastIndexOf('/') + 1).split('?')[0]);
    const id = Number(new URL(u).searchParams.get('release_id'));
    const kind = Object.entries(FRED_RELEASES).find(([, v]) => v === id)?.[0];
    return new Response(JSON.stringify({ release_dates: FRED[kind].map((date) => ({ release_id: 1, date })) }), { status: 200 });
  };
  const arquivar = (events) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-janela-'));
    fs.writeFileSync(path.join(dir, 'events.json'), `${JSON.stringify(events, null, 2)}\n`);
    return dir;
  };
  async function rodar(dir, env, fetchImpl, now) {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      const code = await main(['--dir', dir], env, { fetchImpl, now: () => now });
      return { code, logs: logs.join('\n') };
    } finally {
      console.log = orig;
    }
  }
  const lido = (dir, f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);

  it('resolveMode: só o valor EXATO "janela" liga o modo', () => {
    expect(resolveMode({ COLLECT_MODE: 'janela' })).toBe('janela');
    for (const v of ['', 'Janela', 'JANELA', ' janela', 'janela ', 'normal', 'janela;rm -rf', undefined, null, 1]) expect(resolveMode({ COLLECT_MODE: v }), String(v)).toBe('normal');
    expect(resolveMode({})).toBe('normal');
    expect(resolveMode(undefined)).toBe('normal');
  });

  it('com resultado esperando: consulta o BLS, grava o "Atual" e o resumo mostra as colunas', async () => {
    const dir = arquivar(publicar(NOW, ANTES));
    const n = { n: 0 };
    try {
      const r = await rodar(dir, { FRED_API_KEY: FKEY, BLS_API_KEY: BKEY, COLLECT_MODE: 'janela' }, fetchCom(DEPOIS, n), AFTER_CPI);
      expect(r.code).toBe(0);
      expect(n.n).toBeGreaterThan(0);
      const cpi = byId(JSON.parse(lido(dir, 'events.json')))['CPI-2026-11-10'];
      expect(cpi.values).toEqual({ previous: CPI_ANTERIOR, actual: CPI_ATUAL, source: 'BLS' });
      expect(r.logs).toContain('| Evento | Hora (UTC) | Situação | Anterior (BLS) | Atual (BLS) | Revisado (BLS) |');
      expect(r.logs).toContain(`| CPI-2026-11-10 | 2026-11-10 13:30 | oficial | ${CPI_ANTERIOR} | ${CPI_ATUAL} | — |`);
      for (const t of [lido(dir, 'events.json'), lido(dir, 'status.json'), r.logs]) {
        expect(t).not.toContain(BKEY);
        expect(t).not.toContain(FKEY);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('o resumo mostra o "Revisado" quando o BLS corrigiu o mês anterior', async () => {
    const dir = arquivar(publicar(NOW, ANTES));
    try {
      const r = await rodar(dir, { FRED_API_KEY: FKEY, BLS_API_KEY: BKEY, COLLECT_MODE: 'janela' }, fetchCom(DEPOIS_REVISADO, { n: 0 }), AFTER_CPI);
      expect(r.logs).toContain(`| CPI-2026-11-10 | 2026-11-10 13:30 | oficial | ${CPI_ANTERIOR} | +0,4% m/m · +4,0% a/a | +0,4% m/m · +3,0% a/a |`);
      expect(r.logs).toContain('| NFP-2026-11-06 | 2026-11-06 13:30 | oficial | +119 mil | +50 mil | +150 mil |');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SEM resultado esperando: sai com 0, ZERO consulta de rede e NADA é gravado', async () => {
    const dir = arquivar(publicar(NOW, ANTES));
    const antes = lido(dir, 'events.json');
    const n = { n: 0 };
    try {
      const r = await rodar(dir, { FRED_API_KEY: FKEY, BLS_API_KEY: BKEY, COLLECT_MODE: 'janela' }, fetchCom(DEPOIS, n), NOW);
      expect(r.code).toBe(0);
      expect(n.n).toBe(0);
      expect(lido(dir, 'events.json')).toBe(antes);
      expect(lido(dir, 'status.json')).toBeNull();
      expect(r.logs).toMatch(/Nenhum evento do BLS está esperando o número oficial/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('janela com o "Atual" já publicado também não faz nada', async () => {
    const dir = arquivar(publicar(AFTER_CPI, DEPOIS, publicar(NOW, ANTES)));
    const n = { n: 0 };
    try {
      await rodar(dir, { FRED_API_KEY: FKEY, BLS_API_KEY: BKEY, COLLECT_MODE: 'janela' }, fetchCom(DEPOIS, n), AFTER_CPI + 600000);
      expect(n.n).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('janela sem events.json ainda: não há o que esperar, sai sem rede', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-janela-vazio-'));
    const n = { n: 0 };
    try {
      const r = await rodar(dir, { FRED_API_KEY: FKEY, COLLECT_MODE: 'janela' }, fetchCom(DEPOIS, n), AFTER_CPI);
      expect(r.code).toBe(0);
      expect(n.n).toBe(0);
      expect(lido(dir, 'events.json')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('modo diferente de "janela" (vazio, outra grafia ou ausente) é a coleta NORMAL: consulta e grava mesmo sem resultado esperando', async () => {
    for (const COLLECT_MODE of ['', 'JANELA', undefined]) {
      const dir = arquivar(publicar(NOW, ANTES));
      const n = { n: 0 };
      try {
        const r = await rodar(dir, { FRED_API_KEY: FKEY, BLS_API_KEY: BKEY, COLLECT_MODE }, fetchCom(ANTES, n), NOW);
        expect(r.code, String(COLLECT_MODE)).toBe(0);
        expect(n.n, String(COLLECT_MODE)).toBeGreaterThan(0);
        expect(lido(dir, 'status.json'), String(COLLECT_MODE)).not.toBeNull();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
