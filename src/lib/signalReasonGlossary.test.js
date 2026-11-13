import { describe, it, expect } from 'vitest';
import {
  explainSignalReason, explainSignalReasons, splitReasonPoints, formatReasonPoints,
} from './signalReasonGlossary.js';
import { calculateSignalStrength } from './indicators/confluence.js';
import { calculateSmcSignalStrength } from './indicators/smcConfluence.js';

// As frases REAIS que o motor grava em signal_reasons — geradas pelos próprios módulos de confluência com todas as regras a
// favor. Se alguém mudar o texto de um motivo lá, este teste quebra (em vez de o cartão passar a mostrar o texto cru em silêncio).
function rfReasons(side) {
  const isBuy = side === 'BUY';
  return calculateSignalStrength(
    { signal: side, direction: isBuy ? 1 : -1 },
    { crossedBull50: isBuy, crossedBear50: !isBuy },
    { histogram: isBuy ? 1 : -1 },
    { trend: isBuy ? 'bullish' : 'bearish' },
    { alignment: 'aligned' },
    '4h',
    { current: 2, ma: 1 },
  ).reasons;
}

function smcReasons(side, structureType, alignment) {
  return calculateSmcSignalStrength({
    structureType,
    signalType: side,
    rf1hDirection: side === 'BUY' ? 1 : -1,
    emaTrend: side === 'BUY' ? 'bullish' : 'bearish',
    volumeData: { current: 2, ma: 1 },
    alignmentResult: { alignment, direction: side === 'BUY' ? 'bullish' : 'bearish' },
    sweepConfirmed: true,
    obActive: true,
    fvgActive: true,
    weights: { obWeight: 5, fvgWeight: 5 },
  }).reasons;
}

describe('explainSignalReason — cobre TODAS as frases que o motor produz', () => {
  const real = [
    ...['BUY', 'SELL'].flatMap((side) => rfReasons(side).map((raw) => ({ raw, side }))),
    ...['BUY', 'SELL'].flatMap((side) => [
      ...smcReasons(side, 'BOS', 'aligned'), ...smcReasons(side, 'CHoCH', 'partially_aligned'),
    ].map((raw) => ({ raw, side }))),
  ];

  it('a amostra é a esperada (não-vacuidade): 6 regras da cascata RF por lado e as 9 da SMC', () => {
    expect(rfReasons('BUY')).toHaveLength(6);
    expect(rfReasons('SELL')).toHaveLength(6);
    expect(smcReasons('SELL', 'CHoCH', 'partially_aligned')).toHaveLength(9);
    expect(new Set(real.map((r) => splitReasonPoints(r.raw).text)).size).toBeGreaterThanOrEqual(20);
  });

  it('cada frase real é reconhecida, com título, "o que é" e "por que entra", e os pontos preservados', () => {
    for (const { raw, side } of real) {
      const out = explainSignalReason(raw, side);
      expect(out.known, raw).toBe(true);
      expect(out.raw).toBe(raw);
      expect(out.title.length, raw).toBeGreaterThan(5);
      expect(out.what.length, raw).toBeGreaterThan(20);
      expect(out.why.length, raw).toBeGreaterThan(10);
      expect(out.points, raw).toBe(splitReasonPoints(raw).points);
      expect(Number.isFinite(out.points), raw).toBe(true);
    }
  });

  it('nenhuma explicação promete resultado nem fala em chance de acerto', () => {
    const forbidden = /probabilidade|chance|garant|vai (subir|cair)|deve (subir|cair)|lucro certo|certeza|sempre funciona|% de acerto|taxa de acerto/i;
    for (const { raw, side } of real) {
      const { title, what, why } = explainSignalReason(raw, side);
      expect(`${title} ${what} ${why}`, raw).not.toMatch(forbidden);
    }
  });

  it('o texto acompanha o lado da operação', () => {
    expect(explainSignalReason('Follow-through confirmado (+25)', 'SELL').what).toMatch(/para baixo/);
    expect(explainSignalReason('Follow-through confirmado (+25)', 'BUY').what).toMatch(/para cima/);
    expect(explainSignalReason('MACD hist negativo (+20)', 'SELL').title).toMatch(/negativo/);
    expect(explainSignalReason('MACD hist positivo (+20)', 'BUY').what).toMatch(/alta/);
    expect(explainSignalReason('EMA tendência bearish (+20)', 'SELL').title).toMatch(/baixa/);
    expect(explainSignalReason('EMA tendência bullish (+20)', 'BUY').title).toMatch(/alta/);
    expect(explainSignalReason('RSI cruzou 50 para baixo (+15)', 'SELL').title).toMatch(/vendedor/);
    expect(explainSignalReason('RSI cruzou 50 para cima (+15)', 'BUY').title).toMatch(/comprador/);
    expect(explainSignalReason('Preço abaixo do filtro (+10)', 'SELL').why).toMatch(/vende/);
    expect(explainSignalReason('Preço acima do filtro (+10)', 'BUY').why).toMatch(/compra/);
    expect(explainSignalReason('EMA alinhada (+15)', 'SELL').what).toMatch(/abaixo da longa/);
    expect(explainSignalReason('EMA alinhada (+15)', 'BUY').what).toMatch(/acima da longa/);
    expect(explainSignalReason('Estrutura 1H: CHoCH (+30)', 'BUY').title).toMatch(/Mudança/);
    expect(explainSignalReason('Estrutura 1H: BOS (+30)', 'BUY').title).toMatch(/Rompimento/);
    expect(explainSignalReason('Alinhamento multi-timeframe parcial (+7.5)', 'BUY').what).toMatch(/metade/);
  });
});

describe('explainSignalReason — o que ele NÃO conhece não é inventado', () => {
  it('frase desconhecida volta com o texto original e sem explicação', () => {
    const out = explainSignalReason('Indicador novo XYZ (+12)', 'BUY');
    expect(out).toEqual({ raw: 'Indicador novo XYZ (+12)', known: false, title: 'Indicador novo XYZ', what: null, why: null, points: 12 });
  });

  it('frase sem pontos (motivo de operação manual) também volta crua', () => {
    const out = explainSignalReason('Entrada manual pelo painel', 'SELL');
    expect(out.known).toBe(false);
    expect(out.title).toBe('Entrada manual pelo painel');
    expect(out.points).toBeNull();
  });

  it('texto parecido mas diferente não casa por engano', () => {
    expect(explainSignalReason('Volume acima da média de 30 dias (+10)').known).toBe(false);
    expect(explainSignalReason('Sem follow-through confirmado (+0)').known).toBe(false);
    expect(explainSignalReason('EMA alinhada com o diário (+5)').known).toBe(false);
  });

  it('entrada que não é texto não quebra', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      const out = explainSignalReason(bad, 'BUY');
      expect(out.known).toBe(false);
      expect(out.title).toBe('');
      expect(out.points).toBeNull();
    }
  });
});

describe('explainSignalReasons / splitReasonPoints / formatReasonPoints', () => {
  it('lista: mantém a ordem, pula vazio/nulo e aceita não-lista', () => {
    const list = explainSignalReasons(['MACD hist negativo (+20)', null, '', '  ', 'Outra coisa'], 'SELL');
    expect(list.map((r) => r.known)).toEqual([true, false]);
    expect(list[1].title).toBe('Outra coisa');
    expect(explainSignalReasons(null)).toEqual([]);
    expect(explainSignalReasons('texto')).toEqual([]);
  });

  it('separa os pontos do texto', () => {
    expect(splitReasonPoints('MACD hist negativo (+20)')).toEqual({ text: 'MACD hist negativo', points: 20 });
    expect(splitReasonPoints('Alinhamento multi-timeframe parcial (+7.5)')).toEqual({ text: 'Alinhamento multi-timeframe parcial', points: 7.5 });
    expect(splitReasonPoints('Sem pontos')).toEqual({ text: 'Sem pontos', points: null });
    expect(splitReasonPoints('Parênteses (no meio) do texto')).toEqual({ text: 'Parênteses (no meio) do texto', points: null });
    expect(splitReasonPoints(undefined)).toEqual({ text: '', points: null });
  });

  it('pontos por extenso', () => {
    expect(formatReasonPoints(25)).toBe('25 pontos');
    expect(formatReasonPoints(1)).toBe('1 ponto');
    expect(formatReasonPoints(7.5)).toBe('7.5 pontos');
    expect(formatReasonPoints(null)).toBeNull();
    expect(formatReasonPoints(NaN)).toBeNull();
  });
});
