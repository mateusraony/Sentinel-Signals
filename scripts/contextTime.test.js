// Item 285 — fuso do Contexto de Mercado. O ponto crítico é o fim do horário de
// verão dos EUA em 2026-11-01: a mesma divulgação (CPI 08:30 ET) cai em 12:30Z
// antes e 13:30Z depois. Nenhum teste aqui soma deslocamento fixo.
import { describe, it, expect } from 'vitest';
import {
  nyToUtc, wallTimeToUtc, formatBrt, isUsDst, offsetMinutes, collectionHoursUtc,
  NY_ZONE, BRT_ZONE, COLLECTION_HOURS_BRT,
} from './contextTime.mjs';

describe('Nova York → UTC (divulgações dos EUA)', () => {
  it('CPI 08:30 ET ainda no horário de verão (UTC−4)', () => {
    expect(nyToUtc('2026-10-30', '08:30').iso).toBe('2026-10-30T12:30:00.000Z');
  });

  it('CPI 08:30 ET depois do fim do horário de verão (UTC−5)', () => {
    expect(nyToUtc('2026-11-02', '08:30').iso).toBe('2026-11-02T13:30:00.000Z');
  });

  it('o dia da virada (2026-11-01): 08:30 ET já é UTC−5', () => {
    expect(nyToUtc('2026-11-01', '08:30').iso).toBe('2026-11-01T13:30:00.000Z');
  });

  it('FOMC 14:00 ET: 18:00Z em 28/10 e 19:00Z em 09/12', () => {
    expect(nyToUtc('2026-10-28', '14:00').iso).toBe('2026-10-28T18:00:00.000Z');
    expect(nyToUtc('2026-12-09', '14:00').iso).toBe('2026-12-09T19:00:00.000Z');
  });

  it('início do horário de verão em 2027-03-14: 08:30 ET é UTC−4 (12:30Z)', () => {
    expect(nyToUtc('2027-03-12', '08:30').iso).toBe('2027-03-12T13:30:00.000Z'); // sexta, ainda inverno
    expect(nyToUtc('2027-03-15', '08:30').iso).toBe('2027-03-15T12:30:00.000Z'); // segunda, já verão
  });

  it('hora que NÃO existe (pulo da primavera) devolve null, nunca chuta', () => {
    expect(nyToUtc('2027-03-14', '02:30')).toBeNull();
  });

  it('hora que existe duas vezes (volta de outono) devolve a primeira e marca ambígua', () => {
    const r = nyToUtc('2026-11-01', '01:30');
    expect(r.ambiguous).toBe(true);
    expect(r.iso).toBe('2026-11-01T05:30:00.000Z');
  });

  it('hora normal não é ambígua', () => {
    expect(nyToUtc('2026-10-30', '08:30').ambiguous).toBe(false);
  });

  it('rejeita entrada malformada em vez de adivinhar', () => {
    expect(() => nyToUtc('30/10/2026', '08:30')).toThrow(/data inválida/);
    expect(() => nyToUtc('2026-10-30', '8:30')).toThrow(/hora inválida/);
    expect(() => nyToUtc('2026-10-30', '25:00')).toThrow(/hora inválida/);
  });
});

describe('diferença Brasil × EUA muda de 1h para 2h em 01/11/2026', () => {
  it('antes: NY−BRT = 1h; depois: 2h (Brasil sem horário de verão)', () => {
    const before = Date.UTC(2026, 9, 28, 12);
    const after = Date.UTC(2026, 10, 3, 12);
    expect(offsetMinutes(BRT_ZONE, before) - offsetMinutes(NY_ZONE, before)).toBe(60);
    expect(offsetMinutes(BRT_ZONE, after) - offsetMinutes(NY_ZONE, after)).toBe(120);
  });

  it('isUsDst acompanha a virada', () => {
    expect(isUsDst(Date.UTC(2026, 9, 31, 12))).toBe(true);
    expect(isUsDst(Date.UTC(2026, 10, 2, 12))).toBe(false);
    expect(isUsDst(Date.UTC(2027, 2, 15, 12))).toBe(true);
  });

  it('Brasília é UTC−3 o ano todo', () => {
    for (const m of [0, 3, 6, 9, 11]) {
      expect(offsetMinutes(BRT_ZONE, Date.UTC(2026, m, 15, 12))).toBe(-180);
    }
  });
});

describe('Brasília (o que o usuário lê)', () => {
  it('formata em DD/MM/AAAA HH:MM de Brasília', () => {
    expect(formatBrt('2026-10-30T12:30:00.000Z')).toBe('30/10/2026 09:30');
    expect(formatBrt('2026-11-02T13:30:00.000Z')).toBe('02/11/2026 10:30'); // mesmo CPI, 1h depois em Brasília
  });

  it('virada de dia: 00:00Z é 21:00 do dia anterior em Brasília', () => {
    expect(formatBrt(Date.UTC(2026, 9, 29, 0, 0))).toBe('28/10/2026 21:00');
  });
});

describe('horários das coletas (07h/12h/21h de Brasília)', () => {
  it('= 10:00, 15:00 e 00:00 UTC', () => {
    expect(COLLECTION_HOURS_BRT).toEqual([7, 12, 21]);
    expect(collectionHoursUtc()).toEqual([10, 15, 0]);
  });

  it('não depende do horário de verão dos EUA', () => {
    expect(collectionHoursUtc(Date.UTC(2026, 6, 1))).toEqual([10, 15, 0]);
    expect(collectionHoursUtc(Date.UTC(2027, 0, 15))).toEqual([10, 15, 0]);
  });

  it('wallTimeToUtc em Brasília bate com a lista', () => {
    expect(wallTimeToUtc(BRT_ZONE, '2026-10-28', '07:00').iso).toBe('2026-10-28T10:00:00.000Z');
    expect(wallTimeToUtc(BRT_ZONE, '2026-10-28', '21:00').iso).toBe('2026-10-29T00:00:00.000Z');
  });
});
