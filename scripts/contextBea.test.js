// Leitor da BEA (PCE oficial) — docs/known-risks.md item 285, addendum 33. Formato das respostas igual ao da sonda real de 19/11/2026
// (addendum 32): T20807 em "Percent change" (1 casa) e T20804 em "Level" (3 casas), linhas achadas pelo NOME.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseBeaTable, beaMonthText, beaPreviousValues, beaActualValues, fetchBeaPce, describeBea, beaYears, BEA_TABLES, BEA_SOURCE,
} from './contextBea.mjs';
import { buildEvents, buildStatus, assertPublicShape, sanitizeValues } from './contextCollect.mjs';
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
