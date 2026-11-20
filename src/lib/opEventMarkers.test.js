import { describe, it, expect } from 'vitest';
import { buildOperationEventContext, eventMarkersFor, markerLabel, markerExplanation } from './opEventMarkers';
import { fetchOperationEventsSource } from './marketContextSource';

const D = (s) => Date.parse(s);
const NOW = D('2026-11-19T12:00:00Z');
const MESES = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
const mensal = (dia) => MESES.map((m) => `${m}-${dia}`).reverse();
const HISTORY = {
  version: 1,
  dates: {
    CPI: mensal('10'),
    NFP: mensal('06'),
    PPI: mensal('13'),
    PCE: mensal('12'),
    FOMC: ['2026-10-28', '2026-09-16', '2026-07-29', '2026-06-17', '2026-04-29', '2026-03-18', '2026-01-28', '2025-12-10'],
  },
};
const semMes = (kind, mes) => ({ ...HISTORY, dates: { ...HISTORY.dates, [kind]: HISTORY.dates[kind].filter((d) => !d.startsWith(mes)) } });
const op = (abre, fecha, extra = {}) => ({ status: 'TP2_HIT', entry_candle_time_15m: abre, closed_at: fecha, ...extra });
const ctxOk = () => buildOperationEventContext({ events: [], history: HISTORY }, NOW);

describe('buildOperationEventContext', () => {
  it('monta eventos, início da cobertura e buracos; sem histórico não monta', () => {
    const c = ctxOk();
    expect(c.events.length).toBeGreaterThan(30);
    expect(c.coverageStartMs).toBe(D('2026-04-13T12:30:00Z')); // o último "primeiro dia" entre os 5 tipos é o do PPI
    expect(c.gaps).toEqual({});
    expect(buildOperationEventContext(null, NOW)).toBeNull();
    expect(buildOperationEventContext({ events: [] }, NOW)).toBeNull();
    expect(buildOperationEventContext({ events: [], history: { dates: { CPI: ['2026-11-10'] } } }, NOW)).toBeNull(); // faltam tipos: não se chuta a cobertura
  });
});

describe('eventMarkersFor', () => {
  it('operação aberta quando saiu o CPI: devolve o CPI', () => {
    const hit = eventMarkersFor(op('2026-11-09T20:00:00Z', '2026-11-11T08:00:00Z'), ctxOk(), NOW);
    expect(hit.map((e) => e.kind)).toEqual(['CPI']);
  });

  it('operação sem evento de alta importância: null', () => {
    expect(eventMarkersFor(op('2026-11-14T00:00:00Z', '2026-11-15T00:00:00Z'), ctxOk(), NOW)).toBeNull();
  });

  it('PPI e PCE (importância média) NÃO marcam', () => {
    // 13/11 12:30 UTC (PPI) e 12/11 (PCE de exemplo): nenhuma operação dessa janela tem CPI/Payroll/FOMC
    expect(eventMarkersFor(op('2026-11-12T00:00:00Z', '2026-11-13T20:00:00Z'), ctxOk(), NOW)).toBeNull();
  });

  it('antes do início do histórico: null (não afirma nada)', () => {
    expect(eventMarkersFor(op('2026-01-20T00:00:00Z', '2026-01-30T00:00:00Z'), ctxOk(), NOW)).toBeNull(); // o FOMC de 28/01 existe, mas o histórico dos outros tipos não cobre
  });

  it('operação que toca um mês sem divulgação no histórico: null (nada de "sem evento" falso)', () => {
    const c = buildOperationEventContext({ events: [], history: semMes('CPI', '2026-07') }, NOW);
    expect(eventMarkersFor(op('2026-07-20T00:00:00Z', '2026-07-22T00:00:00Z'), c, NOW)).toBeNull();
    // a janela toca o buraco do CPI de julho E inclui o FOMC de 29/07: sem a regra do buraco ela seria marcada; com ela, nada é afirmado
    expect(eventMarkersFor(op('2026-07-20T00:00:00Z', '2026-07-30T00:00:00Z'), c, NOW)).toBeNull();
    // um buraco de PPI/PCE não atrapalha o marcador (só os tipos de alta importância contam)
    const c2 = buildOperationEventContext({ events: [], history: semMes('PCE', '2026-07') }, NOW);
    expect(eventMarkersFor(op('2026-07-28T00:00:00Z', '2026-07-30T00:00:00Z'), c2, NOW).map((e) => e.kind)).toEqual(['FOMC']);
  });

  it('operação ainda aberta vai até "agora"; sem contexto ou lixo: null', () => {
    const aberta = { status: 'RUNNER_ACTIVE', entry_candle_time_15m: '2026-11-09T20:00:00Z' };
    expect(eventMarkersFor(aberta, ctxOk(), NOW).map((e) => e.kind)).toEqual(['CPI']);
    expect(eventMarkersFor(aberta, null, NOW)).toBeNull();
    expect(eventMarkersFor(null, ctxOk(), NOW)).toBeNull();
    expect(eventMarkersFor({ status: 'TP2_HIT' }, ctxOk(), NOW)).toBeNull();
  });

  it('dois eventos na janela vêm os dois, em ordem de data', () => {
    const hit = eventMarkersFor(op('2026-11-05T00:00:00Z', '2026-11-11T00:00:00Z'), ctxOk(), NOW);
    expect(hit.map((e) => e.kind)).toEqual(['NFP', 'CPI']);
  });
});

describe('markerLabel / markerExplanation', () => {
  const e = (kind, iso) => ({ kind, startsAtMs: D(iso) });
  it('o texto curto tem o nome em português e o dia em Brasília', () => {
    expect(markerLabel([e('CPI', '2026-11-10T13:30:00Z')])).toBe('Aberta durante o CPI (10/11)');
    expect(markerLabel([e('NFP', '2026-11-06T13:30:00Z'), e('CPI', '2026-11-10T13:30:00Z')])).toBe('Aberta durante o Payroll (06/11) e o CPI (10/11)');
    expect(markerLabel([e('NFP', '2026-11-06T13:30:00Z'), e('CPI', '2026-11-10T13:30:00Z'), e('FOMC', '2026-11-12T19:00:00Z')])).toBe('Aberta durante o Payroll (06/11) e o CPI (10/11) +1');
  });

  it('o dia é o de Brasília (UTC−3), não o de UTC', () => {
    expect(markerLabel([e('FOMC', '2027-01-27T00:30:00Z')])).toBe('Aberta durante o FOMC (26/01)'); // 00:30Z = 21:30 do dia anterior em Brasília
  });

  it('a explicação diz a hora de Brasília e que é só coincidência (nunca causa)', () => {
    const t = markerExplanation([e('CPI', '2026-11-10T13:30:00Z')]);
    expect(t).toContain('inflação ao consumidor (CPI) em 10/11 às 10:30 (Brasília)');
    expect(t).toContain('coincidência de horário');
    expect(t).toContain('não diz que o evento mexeu no resultado');
    expect(t).not.toMatch(/causou|provocou|por causa d/i);
  });
});

describe('fetchOperationEventsSource', () => {
  const ok = (body) => ({ ok: true, json: async () => body });
  it('devolve eventos e histórico; sem o histórico devolve null; sem o events.json segue só com o histórico', async () => {
    const f = async (url) => (String(url).endsWith('history.json') ? ok(HISTORY) : ok([]));
    expect(await fetchOperationEventsSource({ fetchImpl: f })).toEqual({ events: [], history: HISTORY });
    const semHistorico = async (url) => (String(url).endsWith('history.json') ? { ok: false, status: 404 } : ok([]));
    expect(await fetchOperationEventsSource({ fetchImpl: semHistorico })).toBeNull();
    const semEventos = async (url) => (String(url).endsWith('history.json') ? ok(HISTORY) : { ok: false, status: 404 });
    expect(await fetchOperationEventsSource({ fetchImpl: semEventos })).toEqual({ events: [], history: HISTORY });
    expect(await fetchOperationEventsSource({ fetchImpl: null })).toBeNull();
  });
});
