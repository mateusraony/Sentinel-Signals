import { describe, it, expect } from 'vitest';
import { detectFvg } from './fvg';
import { mkCandle } from './__fixtures__/candles';

// Um FVG bullish precisa de 3 velas onde a MÍNIMA da 3ª fica acima da MÁXIMA
// da 1ª. Helper monta exatamente isso, com o tamanho de gap pedido, e permite
// anexar velas posteriores para testar preenchimento.
function bullGapSeries({ gap = 2, after = [] } = {}) {
  // vela 0: high=100 | vela 1: candle de deslocamento | vela 2: low=100+gap
  const c0 = mkCandle(99, 100, 98, 99.5, 0);
  const c1 = mkCandle(99.5, 100 + gap + 2, 99, 100 + gap + 1, 1);
  const c2 = mkCandle(100 + gap + 1, 100 + gap + 3, 100 + gap, 100 + gap + 2, 2);
  return [c0, c1, c2, ...after];
}

function bearGapSeries({ gap = 2, after = [] } = {}) {
  // vela 0: low=100 | vela 2: high=100-gap (espelho do bullish)
  const c0 = mkCandle(101, 102, 100, 100.5, 0);
  const c1 = mkCandle(100.5, 101, 100 - gap - 2, 100 - gap - 1, 1);
  const c2 = mkCandle(100 - gap - 1, 100 - gap, 100 - gap - 3, 100 - gap - 2, 2);
  return [c0, c1, c2, ...after];
}

describe('detectFvg', () => {
  it('detecta um FVG bullish com as bordas certas (gapLow = high da 1ª, gapHigh = low da 3ª)', () => {
    const result = detectFvg(bullGapSeries({ gap: 2 }), { direction: 'BUY', sizeThreshold: 1 });
    expect(result.active).toBe(true);
    expect(result.gapLow).toBe(100); // high da vela 0
    expect(result.gapHigh).toBe(102); // low da vela 2
    expect(result.gapSize).toBe(2);
    expect(result.barsAgo).toBe(0);
  });

  it('detecta um FVG bearish simetricamente', () => {
    const result = detectFvg(bearGapSeries({ gap: 2 }), { direction: 'SELL', sizeThreshold: 1 });
    expect(result.active).toBe(true);
    expect(result.gapLow).toBe(98); // high da vela 2
    expect(result.gapHigh).toBe(100); // low da vela 0
    expect(result.gapSize).toBe(2);
  });

  it('a fronteira do sizeThreshold é ESTRITA: gap igual ao limiar não conta', () => {
    // Mesmo `>` do Pine (`sz > size_threshold`), não `>=`.
    const candles = bullGapSeries({ gap: 2 });
    expect(detectFvg(candles, { direction: 'BUY', sizeThreshold: 2 }).active).toBe(false);
    expect(detectFvg(candles, { direction: 'BUY', sizeThreshold: 1.999 }).active).toBe(true);
  });

  it('calcula fillTargetLevel a 60% do gap (default real do Pine)', () => {
    const result = detectFvg(bullGapSeries({ gap: 10 }), { direction: 'BUY', sizeThreshold: 1 });
    // gapLow=100, gapHigh=110 -> 110 - 0.6*10 = 104
    expect(result.fillTargetLevel).toBeCloseTo(104, 5);
  });

  it('um fechamento posterior além de 60% do gap PREENCHE (bullish)', () => {
    // gap [100, 110], alvo 104 — fechar em 103.9 preenche.
    const after = [mkCandle(105, 106, 103, 103.9, 3)];
    const result = detectFvg(bullGapSeries({ gap: 10, after }), { direction: 'BUY', sizeThreshold: 1 });
    expect(result.active).toBe(false);
    expect(result.reason).toBe('no_unfilled_gap');
  });

  it('um fechamento posterior que NÃO alcança 60% não preenche', () => {
    const after = [mkCandle(105, 106, 103, 104.1, 3)]; // fecha acima do alvo 104
    const result = detectFvg(bullGapSeries({ gap: 10, after }), { direction: 'BUY', sizeThreshold: 1 });
    expect(result.active).toBe(true);
    expect(result.barsAgo).toBe(1);
  });

  it('modo CLOSE: pavio que entra fundo no gap mas fecha fora NÃO preenche', () => {
    // low=100 varre o gap inteiro, mas o close (104.5) fica acima do alvo 104.
    const after = [mkCandle(105, 106, 100, 104.5, 3)];
    const result = detectFvg(bullGapSeries({ gap: 10, after }), { direction: 'BUY', sizeThreshold: 1 });
    expect(result.active).toBe(true);
  });

  it('preenchimento bearish é espelhado (fechamento ACIMA do alvo)', () => {
    // bear gap [88, 100] com gap=12 -> alvo = 88 + 0.6*12 = 95.2
    const filled = detectFvg(bearGapSeries({ gap: 12, after: [mkCandle(90, 96, 89, 95.3, 3)] }), {
      direction: 'SELL', sizeThreshold: 1,
    });
    expect(filled.active).toBe(false);
    const notFilled = detectFvg(bearGapSeries({ gap: 12, after: [mkCandle(90, 96, 89, 95.1, 3)] }), {
      direction: 'SELL', sizeThreshold: 1,
    });
    expect(notFilled.active).toBe(true);
  });

  it('havendo dois FVGs não preenchidos, retorna o MAIS RECENTE', () => {
    // Primeiro gap nas velas 0-2, segundo nas velas 3-5.
    const first = bullGapSeries({ gap: 2 }); // gap [100, 102]
    const c3 = mkCandle(103, 104, 102.5, 103.5, 3);
    const c4 = mkCandle(103.5, 112, 103, 111, 4);
    const c5 = mkCandle(111, 113, 110, 112, 5); // low=110 > high da vela 3 (104)
    const result = detectFvg([...first, c3, c4, c5], { direction: 'BUY', sizeThreshold: 1 });
    expect(result.active).toBe(true);
    expect(result.gapLow).toBe(104); // do segundo gap, não do primeiro
    expect(result.barsAgo).toBe(0);
  });

  it('respeita o lookback — um gap fora da janela não é encontrado', () => {
    const filler = Array.from({ length: 10 }, (_, i) => mkCandle(120, 121, 119, 120, 10 + i));
    const candles = [...bullGapSeries({ gap: 2 }), ...filler];
    expect(detectFvg(candles, { direction: 'BUY', sizeThreshold: 1, lookback: 5 }).active).toBe(false);
    expect(detectFvg(candles, { direction: 'BUY', sizeThreshold: 1, lookback: 60 }).active).toBe(true);
  });

  it('série sem nenhum gap retorna no_unfilled_gap sem lançar', () => {
    const candles = Array.from({ length: 10 }, (_, i) => mkCandle(100, 101, 99, 100, i));
    const result = detectFvg(candles, { direction: 'BUY', sizeThreshold: 0.1 });
    expect(result.active).toBe(false);
    expect(result.reason).toBe('no_unfilled_gap');
  });

  // Revisão do Codex (PR #85): o Pine avalia `sz > size_threshold` no instante
  // da FORMAÇÃO e o objeto vive até ser preenchido (`remove_insignificant` só
  // re-testaria tamanho com `gc_cycle > 0`, que a chamada real omite). Aplicar
  // um único limiar "de hoje" a todos os candidatos históricos fazia um gap
  // antigo aparecer e sumir conforme o ATR oscilava — viés direto em
  // report.smcObFvg, que é justamente o entregável do estágio 1.
  describe('limiar por barra de formação (não o limiar corrente)', () => {
    // Gap de 2 formado nas velas 0-2, seguido de 3 velas de alta volatilidade.
    const withVolatileTail = () => bullGapSeries({
      gap: 2,
      after: [
        mkCandle(105, 106, 104, 105.5, 3),
        mkCandle(105.5, 107, 104.5, 106, 4),
        mkCandle(106, 108, 105, 107, 5),
      ],
    });

    it('um gap que passou na formação NÃO some quando o ATR sobe depois', () => {
      const candles = withVolatileTail();
      // Limiar baixo (1) nas barras 0-2 (formação) e alto (5) depois.
      const series = candles.map((_, i) => (i <= 2 ? 1 : 5));
      const result = detectFvg(candles, { direction: 'BUY', sizeThreshold: series });
      expect(result.active).toBe(true);
      expect(result.gapSize).toBe(2);

      // Contraprova: com o escalar "de hoje" (5), o mesmo gap desapareceria —
      // era exatamente o bug reportado.
      expect(detectFvg(candles, { direction: 'BUY', sizeThreshold: 5 }).active).toBe(false);
    });

    it('um gap reprovado na formação NÃO reaparece quando o ATR cai depois', () => {
      const candles = withVolatileTail();
      // Limiar ALTO (5) na formação -> reprovado; baixo (1) depois.
      const series = candles.map((_, i) => (i <= 2 ? 5 : 1));
      expect(detectFvg(candles, { direction: 'BUY', sizeThreshold: series }).active).toBe(false);
    });

    it('limiar negativo (ATR em warm-up) descarta a barra sem lançar', () => {
      const candles = withVolatileTail();
      const series = candles.map(() => -1);
      const result = detectFvg(candles, { direction: 'BUY', sizeThreshold: series });
      expect(result.active).toBe(false);
      expect(result.reason).toBe('no_unfilled_gap');
    });

    it('série de tamanho diferente do array de candles é invalid_params', () => {
      const candles = withVolatileTail();
      expect(detectFvg(candles, { direction: 'BUY', sizeThreshold: [1, 2] }).reason)
        .toBe('invalid_params');
    });
  });

  it('entradas inválidas não lançam exceção', () => {
    const candles = bullGapSeries({ gap: 2 });
    expect(detectFvg(candles, { direction: 'UP', sizeThreshold: 1 }).reason).toBe('invalid_params');
    expect(detectFvg(candles, { direction: 'BUY', sizeThreshold: null }).reason).toBe('invalid_params');
    expect(detectFvg(candles, { direction: 'BUY', sizeThreshold: 1, fillTargetRatio: 1.5 }).reason).toBe('invalid_params');
    expect(detectFvg([], { direction: 'BUY', sizeThreshold: 1 }).reason).toBe('no_candles');
    expect(detectFvg([mkCandle(100, 101, 99, 100, 0)], { direction: 'BUY', sizeThreshold: 1 }).reason).toBe('no_candles');
  });
});
