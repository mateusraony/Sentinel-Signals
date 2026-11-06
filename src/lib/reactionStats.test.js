// Item 285, addendum 18 — Agenda 4d, etapa 2: os textos de "como o BTC se mexeu nas últimas divulgações". O que importa: o critério escrito ANTES
// (posição >= 75% e razão >= 1,3x) é aplicado exatamente, o arquivo com defeito não vira número na tela, e o texto nunca prevê nem usa emoji.
import { describe, it, expect } from 'vitest';
import raw from '@/data/reactionStats.json';
import { REACTION_CRITERION, parseReactionStats, reactionVerdict, reactionNote } from './reactionStats';

const clone = (x) => JSON.parse(JSON.stringify(x));

describe('arquivo de agregados medido (src/data/reactionStats.json)', () => {
  it('é válido e traz os 4 tipos com os números do relatório de 06/11/2026 (trava contra edição por engano)', () => {
    const s = parseReactionStats(raw);
    expect(s).not.toBeNull();
    expect(Object.keys(s.kinds)).toEqual(['NFP', 'CPI', 'PPI', 'PCE']);
    expect(s.normal).toMatchObject({ n: 120, med5: 0.09, med60: 0.22 });
    expect(s.kinds.NFP).toMatchObject({ n: 35, med60: 0.44, ratio60: 2.0, rank60: 0.79 });
    expect(s.kinds.CPI).toMatchObject({ n: 34, med60: 0.65, ratio60: 3.0, rank60: 0.87 });
    expect(s.kinds.PPI).toMatchObject({ n: 34, med60: 0.28, ratio60: 1.3, rank60: 0.62 });
    expect(s.kinds.PCE).toMatchObject({ n: 34, med60: 0.27, ratio60: 1.2, rank60: 0.59 });
    expect(s.measuredAt).toBe('2026-11-06');
  });
});

describe('critério escrito antes de ver o número', () => {
  it('aplicado aos números reais: CPI e Payroll "mexem mais", PPI e PCE ficam "perto de um dia normal"', () => {
    expect(REACTION_CRITERION).toEqual({ minRank: 0.75, minRatio: 1.3 });
    expect(['NFP', 'CPI', 'PPI', 'PCE'].map((k) => reactionNote(k).verdict)).toEqual(['maior', 'maior', 'normal', 'normal']);
  });
  it('fronteira exata: 75% e 1,3x passam; um tiquinho abaixo de qualquer um, não', () => {
    expect(reactionVerdict({ rank60: 0.75, ratio60: 1.3 })).toBe('maior');
    expect(reactionVerdict({ rank60: 0.7499, ratio60: 1.3 })).toBe('normal');
    expect(reactionVerdict({ rank60: 0.75, ratio60: 1.29 })).toBe('normal');
    expect(reactionVerdict({ rank60: 0.99, ratio60: 1.0 })).toBe('normal'); // posição alta mas razão baixa
    expect(reactionVerdict({ rank60: 0.5, ratio60: 5 })).toBe('normal'); // razão alta mas posição baixa
  });
});

describe('parseReactionStats recusa arquivo com defeito (a tela some em silêncio)', () => {
  it('versão, datas, dia normal e números inválidos', () => {
    expect(parseReactionStats(null)).toBeNull();
    expect(parseReactionStats({})).toBeNull();
    for (const mutate of [
      (j) => { j.version = 2; },
      (j) => { j.measuredAt = '06/11/2026'; },
      (j) => { j.sinceDate = ''; },
      (j) => { delete j.normal; },
      (j) => { j.normal.med60 = 0; },
      (j) => { j.normal.n = 0; },
      (j) => { j.normal.med5 = Number.NaN; },
    ]) {
      const j = clone(raw);
      mutate(j);
      expect(parseReactionStats(j), String(mutate)).toBeNull();
    }
  });
  it('um tipo com defeito é descartado sem derrubar os outros', () => {
    const j = clone(raw);
    j.kinds.CPI.med60 = -1;
    j.kinds.PPI.rank60 = 1.5;
    j.kinds.PCE.n = 0;
    const s = parseReactionStats(j);
    expect(Object.keys(s.kinds)).toEqual(['NFP']);
  });
});

describe('textos', () => {
  it('CPI (mexe mais): números formatados em português, razão e data da medição', () => {
    const n = reactionNote('CPI');
    expect(n).toEqual({
      verdict: 'maior',
      chip: 'Costuma mexer mais que num dia normal',
      cases: '34 divulgações desde jan/2024',
      hour: { value: '0,65%', normal: '0,22%', times: '3,0×' },
      first5: { value: '0,44%', normal: '0,09%' },
      measuredAt: '06/11/2026',
    });
  });
  it('PPI (perto do normal): sem "vezes mais" (não afirma diferença que a regra não sustenta)', () => {
    const n = reactionNote('PPI');
    expect(n.chip).toBe('Perto de um dia normal');
    expect(n.hour.times).toBeNull();
    expect(n.hour.value).toBe('0,28%');
  });
  it('FOMC, tipo desconhecido e arquivo inválido = sem bloco', () => {
    expect(reactionNote('FOMC')).toBeNull();
    expect(reactionNote('XYZ')).toBeNull();
    expect(reactionNote('CPI', null)).toBeNull();
    expect(reactionNote('CPI', parseReactionStats({ version: 1 }))).toBeNull();
  });
  it('nenhum texto prevê direção, dá probabilidade ou usa emoji', () => {
    const all = JSON.stringify(['NFP', 'CPI', 'PPI', 'PCE'].map((k) => reactionNote(k)));
    expect(all).not.toMatch(/vai (subir|cair|descer)|tende a (subir|cair)|probabilidade|acerto|compre|venda|alta|queda/i);
    expect(/\p{Extended_Pictographic}/u.test(all)).toBe(false);
  });
});
