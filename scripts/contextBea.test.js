// Leitor da BEA (PCE oficial) — docs/known-risks.md item 285, addendum 33. Formato das respostas igual ao da sonda real de 19/11/2026
// (addendum 32): T20807 em "Percent change" (1 casa) e T20804 em "Level" (3 casas), linhas achadas pelo NOME.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseBeaTable, beaMonthText, beaPreviousValues, beaActualValues, fetchBeaPce, describeBea, beaYears, BEA_TABLES, BEA_SOURCE,
} from './contextBea.mjs';
import { buildEvents, buildStatus, assertPublicShape, sanitizeValues, needsResultCheck } from './contextCollect.mjs';
import { main } from './context-collect.mjs';

const KEY = 'ABCDEF01-2345-6789-ABCD-EF0123456789';
const HEAD = 'Personal consumption expenditures (PCE)';
const CORE = 'PCE excluding food and energy';
const MARKET = 'Market-based PCE excluding food and energy';

/** Corpo da BEA no formato real. `rows`: { [descrição]: { [AAAAMmm]: valor } }; `code` dá um SeriesCode por descrição. */
function beaBody(table, rows, { echoKey = true } = {}) {
  const data = [];
  let n = 0;
  for (const [desc, byPeriod] of Object.entries(rows)) {
    n += 1;
    for (const [period, value] of Object.entries(byPeriod)) {
      data.push({ TableName: table, SeriesCode: `S${n}`, LineNumber: String(n), LineDescription: desc, TimePeriod: period, CL_UNIT: 'x', UNIT_MULT: '0', DataValue: String(value) });
    }
  }
  return JSON.stringify({ BEAAPI: { ...(echoKey ? { Request: { RequestParam: [{ ParameterName: 'USERID', ParameterValue: KEY }] } } : {}), Results: { Data: data } } });
}

// Antes da divulgação de 25/11 (as tabelas terminam em setembro).
const MOM_SET = { [HEAD]: { '2026M08': '0.2', '2026M09': '0.5' }, [CORE]: { '2026M08': '0.2', '2026M09': '0.3' }, [MARKET]: { '2026M09': '0.9' } };
const IDX_SET = {
  [HEAD]: { '2025M08': '127.700', '2025M09': '128.000', '2025M10': '128.400', '2026M08': '131.600', '2026M09': '132.257' },
  [CORE]: { '2025M08': '126.800', '2025M09': '127.000', '2025M10': '127.300', '2026M08': '130.500', '2026M09': '130.902' },
};
// Depois: outubro publicado e setembro REVISADO (0,5 → 0,4 no mês, PCE cheio).
const MOM_OUT = { [HEAD]: { '2026M08': '0.2', '2026M09': '0.4', '2026M10': '0.3' }, [CORE]: { '2026M08': '0.2', '2026M09': '0.3', '2026M10': '0.2' }, [MARKET]: { '2026M10': '0.9' } };
const IDX_OUT = {
  [HEAD]: { ...IDX_SET[HEAD], '2026M10': '132.650' },
  [CORE]: { ...IDX_SET[CORE], '2026M10': '131.164' },
};

const series = (mom, idx) => ({ mom: parseBeaTable(beaBody(BEA_TABLES.mom, mom), BEA_TABLES.mom), index: parseBeaTable(beaBody(BEA_TABLES.index, idx), BEA_TABLES.index) });

describe('parseBeaTable — lê pelo NOME, nunca o market-based, nunca o eco do UserID', () => {
  it('PCE cheio e núcleo viram mapas mês → número; o market-based fica de fora', () => {
    const t = parseBeaTable(beaBody('T20807', MOM_SET), 'T20807');
    expect([...t.headline.entries()]).toEqual([['2026-08', 0.2], ['2026-09', 0.5]]);
    expect([...t.core.entries()]).toEqual([['2026-08', 0.2], ['2026-09', 0.3]]);
  });
  it('a mesma descrição em DUAS séries diferentes é ambígua: a medida some (não se escolhe no chute)', () => {
    const body = JSON.stringify({ BEAAPI: { Results: { Data: [
      { TableName: 'T20807', SeriesCode: 'A', LineDescription: CORE, TimePeriod: '2026M09', DataValue: '0.3' },
      { TableName: 'T20807', SeriesCode: 'B', LineDescription: CORE, TimePeriod: '2026M09', DataValue: '0.7' },
      { TableName: 'T20807', SeriesCode: 'C', LineDescription: HEAD, TimePeriod: '2026M09', DataValue: '0.5' },
    ] } } });
    const t = parseBeaTable(body, 'T20807');
    expect(t.core).toBeNull();
    expect(t.headline.get('2026-09')).toBe(0.5);
  });
  it('número: vírgula só de milhar ("1,234.5"); "1,5", vazio, "(NA)" e período não mensal são ignorados', () => {
    const body = JSON.stringify({ BEAAPI: { Results: { Data: [
      { TableName: 'T20804', SeriesCode: 'A', LineDescription: HEAD, TimePeriod: '2026M07', DataValue: '1,234.5' },
      { TableName: 'T20804', SeriesCode: 'A', LineDescription: HEAD, TimePeriod: '2026M08', DataValue: '1,5' },
      { TableName: 'T20804', SeriesCode: 'A', LineDescription: HEAD, TimePeriod: '2026M09', DataValue: '(NA)' },
      { TableName: 'T20804', SeriesCode: 'A', LineDescription: HEAD, TimePeriod: '2026', DataValue: '130.1' },
      { TableName: 'T20804', SeriesCode: 'A', LineDescription: HEAD, TimePeriod: '2026Q3', DataValue: '130.1' },
    ] } } });
    expect([...parseBeaTable(body, 'T20804').headline.entries()]).toEqual([['2026-07', 1234.5]]);
  });
  it('erro da BEA (nos 2 lugares), JSON ruim, tabela errada ou sem as linhas: null', () => {
    expect(parseBeaTable(JSON.stringify({ BEAAPI: { Results: { Error: { APIErrorDescription: 'x' } } } }), 'T20807')).toBeNull();
    expect(parseBeaTable(JSON.stringify({ BEAAPI: { Error: { APIErrorDescription: 'x' } } }), 'T20807')).toBeNull();
    expect(parseBeaTable('<html>', 'T20807')).toBeNull();
    expect(parseBeaTable(beaBody('T20804', MOM_SET), 'T20807')).toBeNull();
    expect(parseBeaTable(beaBody('T20807', { Goods: { '2026M09': '0.1' } }), 'T20807')).toBeNull();
  });
});

describe('textos do "Anterior" e do "Atual" (mesmo formato do BLS)', () => {
  const antes = series(MOM_SET, IDX_SET);
  const depois = series(MOM_OUT, IDX_OUT);

  it('Anterior do PCE de 25/11 (mede outubro) = setembro: cheio e núcleo, no mês e em 12 meses', () => {
    expect(beaPreviousValues(antes, '2026-10')).toEqual({ previous: '+0,5% m/m · +3,3% a/a', core_previous: '+0,3% m/m · +3,1% a/a', source: BEA_SOURCE });
  });
  it('Atual: só quando as DUAS tabelas trazem o mês do PCE cheio — antes da divulgação, nunca há "Atual" falso', () => {
    expect(beaActualValues(antes, '2026-10')).toBeNull();
    expect(beaActualValues(depois, '2026-10')).toEqual({ actual: '+0,3% m/m · +3,3% a/a', core_actual: '+0,2% m/m · +3,0% a/a' });
    // Metade publicada (só a tabela do mês): espera a próxima coleta em vez de congelar pela metade.
    expect(beaActualValues({ mom: depois.mom, index: antes.index }, '2026-10')).toBeNull();
  });
  it('parte sem base de cálculo some (nunca estimada); fora da faixa plausível também; referência ruim: null', () => {
    expect(beaMonthText(new Map([['2026-09', 0.5]]), null, '2026-09')).toBe('+0,5% m/m');
    expect(beaMonthText(null, new Map([['2026-09', 132]]), '2026-09')).toBeNull(); // sem o mês-base de 12 meses
    expect(beaMonthText(new Map([['2026-09', 7]]), null, '2026-09')).toBeNull(); // 7% no mês: série errada
    expect(beaPreviousValues(antes, null)).toBeNull();
    expect(beaPreviousValues(antes, '2026-13')).toBeNull();
    expect(beaPreviousValues(null, '2026-10')).toBeNull();
  });
  it('anos pedidos: os 3 últimos (o "em 12 meses" de janeiro precisa de 2 anos atrás)', () => {
    expect(beaYears(Date.parse('2027-01-29T12:00:00Z'))).toBe('2025,2026,2027');
  });
});

describe('fetchBeaPce — a chave só na URL; sem chave, nenhuma requisição', () => {
  const NOW = Date.parse('2026-11-19T12:00:00Z');
  it('sem o segredo: nenhuma chamada e o resumo diz o que falta', async () => {
    let calls = 0;
    const r = await fetchBeaPce({ fetchImpl: async () => { calls += 1; return new Response('{}'); }, env: {}, nowMs: NOW });
    expect(calls).toBe(0);
    expect(r).toEqual({ series: null, keyPresent: false, read: 0 });
    expect(describeBea(r)).toMatch(/sem o segredo `BEA_API_KEY`/);
  });
  it('com a chave: 2 chamadas exatas, a chave nunca aparece no resultado nem no resumo', async () => {
    const urls = [];
    const r = await fetchBeaPce({
      fetchImpl: async (url) => { urls.push(url); return new Response(url.includes('T20807') ? beaBody('T20807', MOM_SET) : beaBody('T20804', IDX_SET)); },
      env: { BEA_API_KEY: ` ${KEY}\n` }, nowMs: NOW,
    });
    expect(urls).toEqual([
      `https://apps.bea.gov/api/data?UserID=${KEY}&method=GetData&DataSetName=NIPA&TableName=T20807&Frequency=M&Year=2024,2025,2026&ResultFormat=JSON`,
      `https://apps.bea.gov/api/data?UserID=${KEY}&method=GetData&DataSetName=NIPA&TableName=T20804&Frequency=M&Year=2024,2025,2026&ResultFormat=JSON`,
    ]);
    expect(r.read).toBe(2);
    expect(beaPreviousValues(r.series, '2026-10').previous).toBe('+0,5% m/m · +3,3% a/a');
    expect(describeBea(r)).toBe('BEA (números do PCE): 2 de 2 tabelas lidas.');
    const tudo = JSON.stringify({ ...r, series: null }) + describeBea(r);
    expect(tudo).not.toContain(KEY);
  });
  it('rede caída, HTTP 500 ou erro da BEA: nunca lança, nunca devolve texto de erro', async () => {
    for (const fetchImpl of [
      async (url) => { throw new Error(`falha em ${url}`); },
      async () => new Response('x', { status: 500 }),
      async () => new Response(JSON.stringify({ BEAAPI: { Results: { Error: { APIErrorDescription: `UserID ${KEY} inválido` } } } })),
    ]) {
      const r = await fetchBeaPce({ fetchImpl, env: { BEA_API_KEY: KEY }, nowMs: NOW });
      expect(r).toEqual({ series: null, keyPresent: true, read: 0 });
      expect(describeBea(r)).toBe('BEA (números do PCE): 0 de 2 tabelas lidas — o que já estava publicado foi mantido.');
    }
  });
});

describe('o coletor com a BEA: o ciclo Anterior → Atual (+ Revisado) do PCE, congelado depois', () => {
  const PCE_FIXO = [{ kind: 'PCE', reference: '2026-10', date: '2026-11-25', status: 'oficial' }];
  const ANTES = Date.parse('2026-11-24T12:00:00Z');
  const DEPOIS = Date.parse('2026-11-25T13:50:00Z'); // 13:30 UTC + 20 min
  const build = (nowMs, beaSeries, previous = []) => buildEvents({ fredDatesByKind: {}, fixedList: PCE_FIXO, previous, nowMs, beaSeries });
  const pceOf = (evs) => evs.find((e) => e.id === 'PCE-2026-11-25');

  it('antes: grava o "Anterior" oficial (cheio + núcleo) com a fonte BEA; passa na trava pública', () => {
    const evs = build(ANTES, series(MOM_SET, IDX_SET));
    expect(pceOf(evs).values).toEqual({ previous: '+0,5% m/m · +3,3% a/a', core_previous: '+0,3% m/m · +3,1% a/a', source: 'BEA' });
    expect(() => assertPublicShape(evs, buildStatus({ events: evs, fredDatesByKind: {}, nowMs: ANTES }))).not.toThrow();
  });
  it('depois: "Atual" das duas medidas e o "Revisado" do PCE cheio (a BEA corrigiu setembro); o núcleo sem revisão não ganha "Revisado"', () => {
    const antes = build(ANTES, series(MOM_SET, IDX_SET));
    const evs = build(DEPOIS, series(MOM_OUT, IDX_OUT), antes);
    expect(pceOf(evs).values).toEqual({
      previous: '+0,5% m/m · +3,3% a/a', actual: '+0,3% m/m · +3,3% a/a', revised: '+0,4% m/m · +3,3% a/a',
      core_previous: '+0,3% m/m · +3,1% a/a', core_actual: '+0,2% m/m · +3,0% a/a', source: 'BEA',
    });
  });
  it('congelado: uma revisão posterior (ou a BEA fora do ar) não troca o que saiu; sem BEA antes da divulgação, o publicado fica', () => {
    const antes = build(ANTES, series(MOM_SET, IDX_SET));
    const saiu = build(DEPOIS, series(MOM_OUT, IDX_OUT), antes);
    const mudou = { ...MOM_OUT, [HEAD]: { ...MOM_OUT[HEAD], '2026M10': '0.9' } };
    expect(pceOf(build(DEPOIS + 3600000, series(mudou, IDX_OUT), saiu)).values).toEqual(pceOf(saiu).values);
    expect(pceOf(build(DEPOIS + 3600000, null, saiu)).values).toEqual(pceOf(saiu).values);
    expect(pceOf(build(ANTES + 3600000, null, antes)).values).toEqual(pceOf(antes).values);
  });
  it('depois da hora, enquanto a BEA ainda não trouxe outubro: segue só com o "Anterior" (nunca um "Atual" falso)', () => {
    const antes = build(ANTES, series(MOM_SET, IDX_SET));
    expect(pceOf(build(DEPOIS, series(MOM_SET, IDX_SET), antes)).values).toEqual(pceOf(antes).values);
  });
  it('número de outra fonte no arquivo anterior (BLS num PCE) nunca é aproveitado', () => {
    const antes = build(ANTES, null);
    const forjado = antes.map((e) => (e.id === 'PCE-2026-11-25' ? { ...e, values: { previous: '+9,9% m/m', source: 'BLS' } } : e));
    expect(pceOf(build(ANTES + 60000, null, forjado)).values).toBeNull();
  });
  it('trava pública: núcleo só com a fonte BEA; "Atual" do núcleo só junto do "Atual" do cheio; BEA só no PCE', () => {
    expect(sanitizeValues({ previous: '+0,5% m/m', core_previous: '+0,3% m/m', source: 'BLS' })).toBeNull();
    expect(sanitizeValues({ previous: '+0,5% m/m', core_actual: '+0,3% m/m', source: 'BEA' })).toBeNull();
    expect(sanitizeValues({ previous: '+0,5% m/m', actual: '+0,3% m/m', core_revised: '+0,3% m/m', source: 'BEA' })).toBeNull();
    expect(sanitizeValues({ previous: '+0,5% m/m', gap: 'nao_divulgado', actual: '+0,3% m/m', source: 'BEA' })).toBeNull();
    expect(sanitizeValues({ core_previous: 'texto livre', source: 'BEA' })).toBeNull();
    const evs = build(ANTES, series(MOM_SET, IDX_SET));
    const st = buildStatus({ events: evs, fredDatesByKind: {}, nowMs: ANTES });
    const fomcComNumero = { ...pceOf(evs), id: 'FOMC-2026-11-25', kind: 'FOMC' };
    expect(() => assertPublicShape([fomcComNumero], st)).toThrow(/fonte dos números não é a do tipo/);
  });
});

describe('main do coletor com a BEA (ponta a ponta, sem FRED/BLS)', () => {
  it('grava os números do PCE no events.json, o resumo mostra a fonte e o núcleo, e a chave não vaza', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bea-'));
    const fetchImpl = async (url) => {
      if (String(url).includes('apps.bea.gov')) return new Response(String(url).includes('T20807') ? beaBody('T20807', MOM_SET) : beaBody('T20804', IDX_SET));
      return new Response('x', { status: 500 });
    };
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      expect(await main(['--dir', dir], { BEA_API_KEY: KEY }, { fetchImpl, now: () => Date.parse('2026-11-24T12:00:00Z') })).toBe(0);
    } finally {
      console.log = orig;
    }
    const events = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
    const pce = events.find((e) => e.id === 'PCE-2026-11-25');
    expect(pce.values).toEqual({ previous: '+0,5% m/m · +3,3% a/a', core_previous: '+0,3% m/m · +3,1% a/a', source: 'BEA' });
    const out = logs.join('\n');
    expect(out).toContain('BEA (números do PCE): 2 de 2 tabelas lidas.');
    expect(out).toContain('| PCE-2026-11-25 | 2026-11-25 13:30 | oficial | BEA | +0,5% m/m · +3,3% a/a | — | — | +0,3% m/m · +3,1% a/a → — |');
    expect(out + fs.readFileSync(path.join(dir, 'events.json'), 'utf8')).not.toContain(KEY);
  });
});

// Addendum 36 (achados da revisão independente de 19/11): a referência dos eventos só do FRED e a 2ª tentativa sem o ano corrente.
describe('referência derivada: evento que só existe no FRED (fora da lista fixa)', () => {
  const NOW = Date.parse('2026-12-24T12:00:00Z'); // depois do PCE de 23/12 (que mediu novembro)
  const MOM_NOV = { [HEAD]: { '2026M09': '0.4', '2026M10': '0.3', '2026M11': '0.2' }, [CORE]: { '2026M09': '0.3', '2026M10': '0.2', '2026M11': '0.2' } };
  const IDX_NOV = {
    [HEAD]: { '2025M10': '128.400', '2025M11': '128.700', '2026M10': '132.650', '2026M11': '132.900' },
    [CORE]: { '2025M10': '127.300', '2025M11': '127.600', '2026M10': '131.164', '2026M11': '131.400' },
  };
  const novSeries = series(MOM_NOV, IDX_NOV);
  const build = (fred, extra = {}) => buildEvents({ fredDatesByKind: { PCE: fred }, fixedList: [], previous: [], nowMs: NOW, beaSeries: novSeries, ...extra });
  const pce = (evs, d) => evs.find((e) => e.id === `PCE-${d}`);

  it('o PRÓXIMO PCE (29/01/2027, só do FRED) ganha a referência 2026-12 e o "Anterior" oficial de novembro', () => {
    const evs = build(['2027-01-29']);
    expect(pce(evs, '2027-01-29').reference).toBe('2026-12');
    expect(pce(evs, '2027-01-29').values).toEqual({ previous: '+0,2% m/m · +3,3% a/a', core_previous: '+0,2% m/m · +3,0% a/a', source: 'BEA' });
  });
  it('só o próximo de cada tipo: o seguinte (26/02) continua sem referência até virar o próximo', () => {
    const evs = build(['2027-01-29', '2027-02-26']);
    expect(pce(evs, '2027-01-29').reference).toBe('2026-12');
    expect(pce(evs, '2027-02-26').reference).toBeNull();
    expect(pce(evs, '2027-02-26').values).toBeNull();
  });
  it('os DOIS sinais precisam concordar: a fonte atrasada (último mês = outubro) ou a data fora do padrão deixam o evento sem referência', () => {
    const velha = series({ [HEAD]: { '2026M09': '0.4', '2026M10': '0.3' }, [CORE]: { '2026M09': '0.3', '2026M10': '0.2' } }, IDX_SET);
    expect(pce(build(['2027-01-29'], { beaSeries: velha }), '2027-01-29').reference).toBeNull();
    expect(pce(build(['2027-03-27']), '2027-03-27').reference).toBeNull(); // 03/2027 mediria 2027-02, mas a fonte diz 2026-12
  });
  it('um PCE já passado (23/12, sem referência) não conta como "o próximo": quem ganha é o 29/01', () => {
    const evs = build(['2026-12-23', '2027-01-29']);
    expect(pce(evs, '2027-01-29').reference).toBe('2026-12');
  });
  it('ACHADO DO CODEX (#594): a referência derivada SOBREVIVE à hora da divulgação — o "Atual" é anexado e o modo "janela" continua esperando', () => {
    // O CPI de 13/01/2027 mede DEZEMBRO: antes da divulgação o último mês publicado é novembro.
    const cpiAntes = { CUSR0000SA0: new Map([['2026-10', 299], ['2026-11', 300]]), CUUR0000SA0: new Map([['2025-11', 289], ['2026-10', 298], ['2026-11', 299]]) };
    const ANTES = Date.parse('2027-01-13T12:00:00Z');
    const DEPOIS = Date.parse('2027-01-13T13:40:00Z'); // 10 min depois das 13:30 UTC
    const cpi = (nowMs, series, previous) => buildEvents({ fredDatesByKind: { CPI: ['2027-01-13'] }, fixedList: [], previous, nowMs, blsSeries: series });
    const ev = (evs) => evs.find((e) => e.id === 'CPI-2027-01-13');
    const antes = cpi(ANTES, cpiAntes, []);
    expect(ev(antes).reference).toBe('2026-12');
    expect(ev(antes).values.previous).toMatch(/m\/m/); // o "Anterior" (novembro) foi calculado
    // depois da hora e AINDA sem o número: a referência fica (era null antes da correção) e o modo "janela" continua esperando
    const depoisSemNumero = cpi(DEPOIS, cpiAntes, antes);
    expect(ev(depoisSemNumero).reference).toBe('2026-12');
    expect(needsResultCheck(depoisSemNumero, DEPOIS)).toBe(true);
    // o BLS publica dezembro: o "Atual" é anexado ao evento
    const comDezembro = { CUSR0000SA0: new Map([['2026-10', 299], ['2026-11', 300], ['2026-12', 301]]), CUUR0000SA0: new Map([['2025-11', 289], ['2025-12', 290], ['2026-10', 298], ['2026-11', 299], ['2026-12', 300]]) };
    const depois = cpi(DEPOIS + 20 * 60000, comDezembro, depoisSemNumero);
    expect(ev(depois).reference).toBe('2026-12');
    expect(ev(depois).values.actual).toMatch(/m\/m/);
    expect(needsResultCheck(depois, DEPOIS + 20 * 60000)).toBe(false); // já tem o "Atual": a janela para de esperar
  });
  it('a referência carregada adiante NÃO conta como mudança: "lastChangedAt" fica quieto entre coletas (senão o arquivo público mudaria a cada passada)', () => {
    const cpiS = { CUSR0000SA0: new Map([['2026-10', 299], ['2026-11', 300]]), CUUR0000SA0: new Map([['2025-11', 289], ['2026-10', 298], ['2026-11', 299]]) };
    const run = (nowMs, previous) => buildEvents({ fredDatesByKind: { CPI: ['2027-01-13'] }, fixedList: [], previous, nowMs, blsSeries: cpiS });
    const t1 = run(Date.parse('2027-01-13T12:00:00Z'), []);
    const t2 = run(Date.parse('2027-01-13T12:15:00Z'), t1);
    const t3 = run(Date.parse('2027-01-13T13:40:00Z'), t2); // já depois da hora: a referência vem do arquivo anterior
    for (const t of [t2, t3]) expect(t[0].lastChangedAt).toBe(t1[0].lastChangedAt);
    expect(t3[0].reference).toBe('2026-12');
  });
  it('a referência da lista fixa continua mandando (nunca é sobrescrita)', () => {
    const evs = build(['2027-01-29'], { fixedList: [{ kind: 'PCE', reference: '2026-10', date: '2027-01-29', status: 'oficial' }] });
    expect(pce(evs, '2027-01-29').reference).toBe('2026-10');
  });
  it('sem a fonte (BEA fora do ar) não inventa referência; data a confirmar nunca ganha', () => {
    expect(pce(build(['2027-01-29'], { beaSeries: null }), '2027-01-29').reference).toBeNull();
    const evs = build([], { fixedList: [{ kind: 'PCE', reference: null, date: '2027-01-29', status: 'a_confirmar' }] });
    expect(pce(evs, '2027-01-29').reference).toBeNull();
  });
  it('BLS também: o próximo CPI só do FRED (10/02/2027) ganha 2027-01 quando o último mês publicado é dezembro', () => {
    const cpiSeries = { CUSR0000SA0: new Map([['2026-11', 300], ['2026-12', 301]]), CUUR0000SA0: new Map([['2025-12', 290], ['2026-11', 299], ['2026-12', 300]]) };
    const evs = buildEvents({ fredDatesByKind: { CPI: ['2027-02-10'] }, fixedList: [], previous: [], nowMs: NOW, blsSeries: cpiSeries });
    expect(evs.find((e) => e.id === 'CPI-2027-02-10').reference).toBe('2027-01');
    expect(evs.find((e) => e.id === 'CPI-2027-02-10').values.previous).toMatch(/m\/m/);
  });
});

describe('FOMC nunca tem números oficiais automáticos', () => {
  it('um arquivo anterior com `values` num FOMC (adulterado) não trava o coletor: o valor é descartado e a trava pública passa', () => {
    const NOW = Date.parse('2026-11-19T15:00:00Z');
    const previous = [{ id: 'FOMC-2026-12-09', kind: 'FOMC', reference: '2026-12', startsAtUtc: '2026-12-09T19:00:00.000Z', status: 'oficial', firstSeenAt: '2026-11-01T00:00:00.000Z', lastChangedAt: '2026-11-01T00:00:00.000Z', values: { previous: '+0,3% m/m', source: 'BLS' } }];
    const evs = buildEvents({ fredDatesByKind: {}, fixedList: [{ kind: 'FOMC', reference: '2026-12', date: '2026-12-09', status: 'oficial' }], previous, nowMs: NOW });
    expect(evs.find((e) => e.id === 'FOMC-2026-12-09').values).toBeNull();
    expect(() => assertPublicShape(evs, buildStatus({ events: evs, fredDatesByKind: {}, nowMs: NOW }))).not.toThrow();
  });
});

describe('fetchBeaPce: 2ª tentativa sem o ano corrente', () => {
  const NOW = Date.parse('2027-01-20T12:00:00Z'); // janeiro: a BEA ainda não tem nenhum valor de 2027
  const respondeSemOAnoNovo = (calls) => async (url) => {
    const u = new URL(String(url));
    calls.push(u.searchParams.get('Year'));
    if (u.searchParams.get('Year').includes('2027')) return new Response(JSON.stringify({ BEAAPI: { Results: { Error: { APIErrorDescription: 'Data not available for 2027' } } } }));
    return new Response(u.searchParams.get('TableName') === 'T20807' ? beaBody('T20807', MOM_SET) : beaBody('T20804', IDX_SET));
  };
  it('o pedido com 2027 é recusado → repete só com 2025 e 2026 e lê as 2 tabelas', async () => {
    const calls = [];
    const r = await fetchBeaPce({ fetchImpl: respondeSemOAnoNovo(calls), env: { BEA_API_KEY: KEY }, nowMs: NOW });
    expect(r.read).toBe(2);
    expect(calls).toEqual(['2025,2026,2027', '2025,2026,2027', '2025,2026', '2025,2026']);
    expect(beaYears(NOW, { withCurrent: false })).toBe('2025,2026');
  });
  it('a 1ª tentativa deu certo: não há 2ª; tudo falhou: 4 chamadas e nada vaza', async () => {
    const calls = [];
    const ok = await fetchBeaPce({ fetchImpl: async (url) => { calls.push(1); return new Response(String(url).includes('T20807') ? beaBody('T20807', MOM_SET) : beaBody('T20804', IDX_SET)); }, env: { BEA_API_KEY: KEY }, nowMs: NOW });
    expect(ok.read).toBe(2);
    expect(calls.length).toBe(2);
    let n = 0;
    const falha = await fetchBeaPce({ fetchImpl: async (url) => { n += 1; throw new Error(`x ${url}`); }, env: { BEA_API_KEY: KEY }, nowMs: NOW });
    expect(falha).toEqual({ series: null, keyPresent: true, read: 0 });
    expect(n).toBe(4);
  });
});
