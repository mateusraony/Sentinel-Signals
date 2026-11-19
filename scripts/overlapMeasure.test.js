import { describe, it, expect } from 'vitest';
import { eventInstant, buildEvents, gateVerdict, formatReport, medianHours, GATE_FRACTION } from './overlapMeasure.mjs';
import { run } from './overlap-measure.mjs';
import { overlapStats } from '../src/lib/contextOverlap.js';

const D = (s) => Date.parse(s);
const NOW = D('2026-11-19T12:00:00Z');
const HISTORY = {
  version: 1,
  dates: {
    CPI: ['2026-11-10', '2026-10-14', '2026-04-10'],
    NFP: ['2026-11-06', '2026-04-03'],
    PPI: ['2026-11-13', '2026-04-14'],
    PCE: ['2026-10-29', '2026-02-20'],
    FOMC: ['2026-10-28', '2025-12-10'],
  },
};

describe('eventInstant', () => {
  it('converte pelo horário de Nova York, com horário de verão (CPI 08:30 ET)', () => {
    expect(eventInstant('CPI', '2026-10-14')).toBe(D('2026-10-14T12:30:00Z')); // EDT
    expect(eventInstant('CPI', '2026-11-10')).toBe(D('2026-11-10T13:30:00Z')); // EST
  });
  it('FOMC é 14:00 ET', () => {
    expect(eventInstant('FOMC', '2026-10-28')).toBe(D('2026-10-28T18:00:00Z'));
    expect(eventInstant('FOMC', '2026-12-09')).toBe(D('2026-12-09T19:00:00Z'));
  });
  it('data ou tipo inválidos → null', () => {
    expect(eventInstant('CPI', '10/11/2026')).toBeNull();
    expect(eventInstant('XYZ', '2026-11-10')).toBeNull();
    expect(eventInstant('CPI', undefined)).toBeNull();
  });
});

describe('buildEvents', () => {
  it('lê o histórico e a cobertura é o MAIS RECENTE dos primeiros dias conhecidos dos 5 tipos', () => {
    const b = buildEvents({ history: HISTORY, events: [], nowMs: NOW });
    expect(b.events).toHaveLength(11);
    expect(b.coverageStartMs).toBe(eventInstant('PPI', '2026-04-14')); // o último "primeiro dia" é o do PPI
    expect(b.kindsWithHistory).toHaveLength(5);
  });

  it('tipo sem nenhuma data no histórico → cobertura null (não se chuta)', () => {
    const h = { dates: { ...HISTORY.dates, PCE: [] } };
    expect(buildEvents({ history: h, events: [], nowMs: NOW }).coverageStartMs).toBeNull();
  });

  it('junta events.json só com data firme e já ocorrida, sem repetir o que o histórico já tem', () => {
    const events = [
      { kind: 'CPI', startsAtUtc: '2026-11-10T13:30:00.000Z', status: 'oficial' }, // repetido
      { kind: 'NFP', startsAtUtc: '2026-12-04T13:30:00.000Z', status: 'oficial' }, // futuro
      { kind: 'PPI', startsAtUtc: '2026-11-17T13:30:00.000Z', status: 'a_confirmar' }, // sem data firme
      { kind: 'PPI', startsAtUtc: '2026-11-18T13:30:00.000Z', status: 'confirmada' }, // novo, firme, passado
      { kind: 'ZZZ', startsAtUtc: '2026-11-18T13:30:00.000Z', status: 'oficial' }, // tipo desconhecido
      null,
    ];
    const b = buildEvents({ history: HISTORY, events, nowMs: NOW });
    expect(b.events).toHaveLength(12);
    expect(b.events.filter((e) => e.startsAtMs === D('2026-11-10T13:30:00Z'))).toHaveLength(1);
    expect(b.events.some((e) => e.startsAtMs > NOW)).toBe(false);
    expect(b.events.some((e) => e.startsAtMs === D('2026-11-17T13:30:00Z'))).toBe(false);
  });

  it('entradas quebradas não derrubam', () => {
    expect(buildEvents({ history: null, events: 'x', nowMs: NOW }).events).toEqual([]);
    expect(buildEvents({ history: { dates: { CPI: ['lixo', null, 5] } }, events: [], nowMs: NOW }).events).toEqual([]);
  });
});

describe('gateVerdict', () => {
  const s = (marked, total) => ({ marked, total, fraction: total ? marked / total : null });
  it('30% exato passa; acima não', () => {
    expect(GATE_FRACTION).toBe(0.3);
    expect(gateVerdict(s(3, 10))).toMatch(/^PASSA/);
    expect(gateVerdict(s(4, 10))).toMatch(/^NÃO PASSA/);
    expect(gateVerdict(s(0, 10))).toMatch(/^PASSA/);
  });
  it('sem amostra não decide', () => {
    expect(gateVerdict(s(0, 0))).toMatch(/^SEM AMOSTRA/);
    expect(gateVerdict(null)).toMatch(/^SEM AMOSTRA/);
  });
});

describe('medianHours', () => {
  it('mediana de janelas; null sem janelas', () => {
    const w = (h) => ({ startMs: 0, endMs: h * 3600000 });
    expect(medianHours([w(1), w(3), w(2)])).toBe(2);
    expect(medianHours([w(1), w(3)])).toBe(2);
    expect(medianHours([])).toBeNull();
  });
});

const op = (start, end, extra = {}) => ({ status: 'TP2_HIT', entry_candle_time_15m: start, closed_at: end, symbol: 'SEGREDOUSDT', entry_price: 123.456, ...extra });

describe('run (sem rede nem banco)', () => {
  const okFetch = async (url) => ({
    status: 200,
    text: async () => JSON.stringify(String(url).endsWith('history.json') ? HISTORY : []),
  });

  it('mede e imprime só contagens: nada de símbolo nem preço', async () => {
    const ops = [
      op('2026-11-09T20:00:00Z', '2026-11-11T08:00:00Z'), // pega o CPI
      op('2026-11-14T00:00:00Z', '2026-11-15T00:00:00Z'), // nenhum
      op('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z'), // nenhum
      op('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), // fora do período
    ];
    const { lines, code } = await run({ fetchImpl: okFetch, listOps: async () => ops, nowMs: NOW });
    const text = lines.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('**3**'); // total dentro do período
    expect(text).toContain('1 de 3');
    expect(text).toMatch(/fora do período \(antes do histórico\): 1/);
    expect(text).not.toMatch(/SEGREDO|123\.456|123,456/);
  });

  it('usa a mesma regra de sobreposição do painel (resultado confere com overlapStats)', async () => {
    const ops = [op('2026-11-09T20:00:00Z', '2026-11-11T08:00:00Z'), op('2026-11-14T00:00:00Z', '2026-11-15T00:00:00Z')];
    const b = buildEvents({ history: HISTORY, events: [], nowMs: NOW });
    const direto = overlapStats(ops, b.events, { nowMs: NOW, coverageStartMs: b.coverageStartMs });
    const { lines } = await run({ fetchImpl: okFetch, listOps: async () => ops, nowMs: NOW });
    expect(lines.join('\n')).toContain(`${direto.marked} de ${direto.total}`);
  });

  it('a alta importância não conta PPI/PCE; o painel "todos" conta', async () => {
    const ops = [op('2026-11-12T20:00:00Z', '2026-11-13T20:00:00Z')]; // só o PPI de 13/11
    const text = (await run({ fetchImpl: okFetch, listOps: async () => ops, nowMs: NOW })).lines.join('\n');
    expect(text).toContain('Marcadas: **0 de 1**');
    expect(text).toContain('Marcadas: 1 de 1');
  });

  it('a duração mediana só considera operações dentro do período', async () => {
    const ops = [op('2026-11-14T00:00:00Z', '2026-11-14T10:00:00Z'), op('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z')]; // 10 h dentro; ~1400 h fora
    const text = (await run({ fetchImpl: okFetch, listOps: async () => ops, nowMs: NOW })).lines.join('\n');
    expect(text).toContain('mediana das operações do período: 10,0 h');
  });

  it('histórico indisponível → código 2, sem tocar o banco', async () => {
    let tocou = false;
    const down = async () => ({ status: 503, text: async () => '' });
    const r = await run({ fetchImpl: down, listOps: async () => { tocou = true; return []; }, nowMs: NOW });
    expect(r.code).toBe(2);
    expect(tocou).toBe(false);
  });

  it('rede que lança → código 2 sem repetir a mensagem do erro', async () => {
    const boom = async () => { throw new Error('postgres://u:SENHA@host/db falhou'); };
    const r = await run({ fetchImpl: boom, listOps: async () => [], nowMs: NOW });
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).not.toMatch(/SENHA|postgres:/);
  });

  it('banco que lança → código 3, mostra só o código e nunca a mensagem crua', async () => {
    const r = await run({ fetchImpl: okFetch, listOps: async () => { throw new Error('connect postgres://u:SENHA@host/db'); }, nowMs: NOW });
    expect(r.code).toBe(3);
    expect(r.lines.join('\n')).toContain('banco_indisponivel');
    expect(r.lines.join('\n')).not.toMatch(/SENHA|postgres:/);
  });

  it('histórico sem um dos tipos → código 2', async () => {
    const partial = async (url) => ({ status: 200, text: async () => JSON.stringify(String(url).endsWith('history.json') ? { dates: { CPI: ['2026-11-10'] } } : []) });
    expect((await run({ fetchImpl: partial, listOps: async () => [], nowMs: NOW })).code).toBe(2);
  });

  it('o aviso de credencial entra no fim do relatório', async () => {
    const { lines } = await run({ fetchImpl: okFetch, listOps: async () => [], nowMs: NOW, notes: ['⚠️ nota X'] });
    expect(lines[lines.length - 1]).toBe('⚠️ nota X');
  });
});

describe('formatReport', () => {
  const st = { total: 5, marked: 1, fraction: 0.2, byKind: { CPI: 1, NFP: 0, FOMC: 0 }, unreadable: 0, outsideCoverage: 2 };
  it('amostra pequena é dita às claras', () => {
    const t = formatReport({ high: st, all: st, coverageStartMs: D('2026-04-14T00:00:00Z'), nowMs: NOW, eventsCount: 11, durationHoursMedian: 30.25 }).join('\n');
    expect(t).toMatch(/amostra pequena/i);
    expect(t).toContain('20,0%');
    expect(t).toContain('30,3 h');
  });
});
