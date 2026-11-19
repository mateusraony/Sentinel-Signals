// Item 285, addendum 27 — as datas passadas das divulgações (history.json). Sem rede: só regras puras e a gravação em pasta temporária.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HISTORY_VERSION, HISTORY_PER_KIND, parseHistory, buildHistory, assertHistoryShape, serializeHistory, lastDates,
} from './contextHistory.mjs';
import { writeHistory } from './context-collect.mjs';

const NOW = Date.parse('2026-11-17T17:00:00.000Z');

describe('buildHistory: só datas já passadas, da mais recente à mais antiga', () => {
  it('descarta a futura e a que ainda não terminou a hora de medição; ordena e limita', () => {
    const cpi = ['2026-08-12', '2026-09-11', '2026-10-24', '2026-11-17', '2026-12-10', '2027-01-13'];
    const h = buildHistory({ fredDatesByKind: { CPI: cpi }, nowMs: NOW });
    // 17/11 08:30 NY = 13:30 UTC; +61 min = 14:31 UTC ≤ 17:00 UTC → entra. 10/12 e 13/01 são futuras.
    expect(h.dates.CPI).toEqual(['2026-11-17', '2026-10-24', '2026-09-11', '2026-08-12']);
    const recente = buildHistory({ fredDatesByKind: { CPI: cpi }, nowMs: Date.parse('2026-11-17T14:00:00.000Z') });
    expect(recente.dates.CPI[0]).toBe('2026-10-24'); // 17/11 ainda dentro da hora de medição
    const muitas = Array.from({ length: 20 }, (_, i) => `2025-${String((i % 12) + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`);
    expect(buildHistory({ fredDatesByKind: { PPI: [...new Set(muitas)] }, nowMs: NOW }).dates.PPI.length).toBeLessThanOrEqual(HISTORY_PER_KIND);
  });

  it('mês com DUAS datas do mesmo tipo sai inteiro (não dá para saber qual é a divulgação certa)', () => {
    const h = buildHistory({ fredDatesByKind: { CPI: ['2026-09-11', '2026-10-10', '2026-10-24'] }, nowMs: NOW });
    expect(h.dates.CPI).toEqual(['2026-09-11']);
  });

  it('tipo que o FRED NÃO respondeu mantém o que já estava publicado (falha de rede não apaga)', () => {
    const previous = { version: 1, dates: { NFP: ['2026-11-06', '2026-10-03'], CPI: ['2026-10-24'] } };
    const h = buildHistory({ fredDatesByKind: { CPI: null, NFP: null }, previous, nowMs: NOW });
    expect(h.dates).toEqual({ NFP: ['2026-11-06', '2026-10-03'], CPI: ['2026-10-24'] });
  });

  it('tipo respondido mas SEM datas confiáveis também mantém o anterior; tipo desconhecido nunca entra', () => {
    const previous = { version: 1, dates: { CPI: ['2026-10-24'] } };
    const h = buildHistory({ fredDatesByKind: { CPI: ['2026-12-10'], XYZ: ['2026-09-16'] }, previous, nowMs: NOW });
    expect(h.dates).toEqual({ CPI: ['2026-10-24'] });
  });

  it('FOMC (addendum 36): as reuniões JÁ passadas, lidas no site do Fed, entram; a futura e o Fed fora do ar (null) mantêm o que estava', () => {
    const h = buildHistory({ fredDatesByKind: { FOMC: ['2026-12-09', '2026-10-28', '2026-09-16', '2026-07-29'] }, nowMs: NOW });
    expect(h.dates.FOMC).toEqual(['2026-10-28', '2026-09-16', '2026-07-29']);
    const antes = { version: 1, dates: { FOMC: ['2026-10-28'] } };
    expect(buildHistory({ fredDatesByKind: { FOMC: null }, previous: antes, nowMs: NOW }).dates.FOMC).toEqual(['2026-10-28']);
    expect(() => serializeHistory(h)).not.toThrow();
  });

  it('data mal formada ou inexistente é ignorada; entrada ruim não derruba', () => {
    const h = buildHistory({ fredDatesByKind: { CPI: ['lixo', '2026-02-30', 7, null, '2026-10-24'] }, nowMs: NOW });
    expect(h.dates.CPI).toEqual(['2026-10-24']);
    expect(buildHistory({ nowMs: NOW })).toEqual({ version: HISTORY_VERSION, dates: {} });
    expect(buildHistory({ fredDatesByKind: null, previous: 'x', nowMs: NOW }).dates).toEqual({});
  });
});

describe('parseHistory: o arquivo vem da rede/disco e não é confiável', () => {
  it('lixo vira histórico vazio; tipo desconhecido, data ruim e repetida são limpos', () => {
    for (const x of [null, undefined, 7, 'x', [], {}, { version: 2, dates: {} }, { version: 1, dates: [] }]) {
      expect(parseHistory(x), JSON.stringify(x)).toEqual({ version: 1, dates: {} });
    }
    const lido = parseHistory({ version: 1, dates: { CPI: ['2026-10-24', '2026-10-24', 'lixo', '2026-09-11'], FOMC: ['2026-09-16'], XYZ: ['2026-09-16'], NFP: 'nao-lista' } });
    expect(lido.dates).toEqual({ CPI: ['2026-10-24', '2026-09-11'], FOMC: ['2026-09-16'] });
  });
  it('lastDates devolve as N mais recentes e vazio sem histórico', () => {
    const h = { version: 1, dates: { CPI: ['2026-10-24', '2026-09-11', '2026-08-12', '2026-07-15'] } };
    expect(lastDates(h, 'CPI', 3)).toEqual(['2026-10-24', '2026-09-11', '2026-08-12']);
    expect(lastDates(h, 'NFP')).toEqual([]);
    expect(lastDates(null, 'CPI')).toEqual([]);
  });
});

describe('trava do conteúdo público', () => {
  const ok = { version: 1, dates: { CPI: ['2026-10-24', '2026-09-11'] } };
  it('aceita o formato certo e serializa com quebra de linha final', () => {
    expect(() => assertHistoryShape(ok)).not.toThrow();
    expect(serializeHistory(ok)).toBe(`${JSON.stringify(ok, null, 2)}\n`);
  });
  it('recusa campo extra, texto livre, tipo desconhecido, data ruim, repetida, fora de ordem, lista vazia ou grande demais', () => {
    const ruins = [
      { ...ok, nota: 'texto livre' },
      { version: 2, dates: {} },
      { dates: {} },
      { version: 1, dates: { XYZ: ['2026-09-16'] } },
      { version: 1, dates: { FOMC: ['2026-09-16', '2026-09-16'] } },
      { version: 1, dates: { CPI: ['2026-10-24 08:30'] } },
      { version: 1, dates: { CPI: ['2026-02-30'] } },
      { version: 1, dates: { CPI: ['2026-10-24', '2026-10-24'] } },
      { version: 1, dates: { CPI: ['2026-09-11', '2026-10-24'] } },
      { version: 1, dates: { CPI: [] } },
      { version: 1, dates: { CPI: Array.from({ length: HISTORY_PER_KIND + 1 }, (_, i) => `2026-01-${String(28 - i).padStart(2, '0')}`) } },
      null,
      [],
    ];
    for (const r of ruins) expect(() => assertHistoryShape(r), JSON.stringify(r)?.slice(0, 70)).toThrow(/history\.json/);
  });
});

describe('writeHistory (o passo do coletor)', () => {
  let dir;
  let errSpy;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-history-'));
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = () => path.join(dir, 'history.json');

  it('grava na 1ª vez, diz "inalterado" na 2ª e não deixa arquivo temporário', () => {
    const fred = { CPI: ['2026-09-11', '2026-10-24'] };
    expect(writeHistory(file(), fred, NOW)).toBe('gravado');
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ version: 1, dates: { CPI: ['2026-10-24', '2026-09-11'] } });
    expect(writeHistory(file(), fred, NOW)).toBe('inalterado');
    expect(fs.readdirSync(dir)).toEqual(['history.json']);
  });

  it('sem datas (FRED sem resposta e sem histórico anterior): não cria arquivo', () => {
    expect(writeHistory(file(), { CPI: null, NFP: null, PPI: null, PCE: null }, NOW)).toBe('não gravado (sem datas)');
    expect(fs.existsSync(file())).toBe(false);
  });

  it('FRED caiu depois de já haver histórico: o arquivo NÃO é apagado nem alterado', () => {
    writeHistory(file(), { CPI: ['2026-10-24'] }, NOW);
    const antes = fs.readFileSync(file(), 'utf8');
    expect(writeHistory(file(), { CPI: null }, NOW)).toBe('inalterado');
    expect(fs.readFileSync(file(), 'utf8')).toBe(antes);
  });

  it('arquivo anterior ilegível é tratado como vazio (não quebra a coleta)', () => {
    fs.writeFileSync(file(), '{ isto não é json');
    expect(writeHistory(file(), { CPI: ['2026-10-24'] }, NOW)).toBe('gravado');
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).version).toBe(1);
  });
});
