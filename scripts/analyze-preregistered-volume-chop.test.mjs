import { describe, it, expect } from 'vitest';
import {
  PREREG,
  isoWeekKey,
  extractRecords,
  slopeClusterRobust,
  evaluateHypothesis,
  verdictFrom,
  analyzeReport,
} from './analyze-preregistered-volume-chop.mjs';
import { mulberry32 } from './backtest-correlation-check.mjs';

// Ruído gaussiano determinístico (Box-Muller sobre mulberry32).
function makeNoise(seed) {
  const rand = mulberry32(seed);
  return () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

// n registros espalhados em `weeks` semanas e `symbols`×meses; R = base + efeitos + ruído.
function synth({ n = 600, weeks = 50, seed = 7, volEffect = 0, chopSlope = 0, noiseSd = 0.8 }) {
  const noise = makeNoise(seed);
  const rand = mulberry32(seed + 1);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const volume = rand() < 0.5 ? 1 : 0;
    const chop = 30 + rand() * 30;
    out.push({
      r: volEffect * volume + chopSlope * (chop - 45) + noiseSd * noise(),
      volume,
      chop,
      week: `2025-W${String(i % weeks).padStart(2, '0')}`,
      symbolMonth: `S${i % 7}|2025-${String(1 + (i % 12)).padStart(2, '0')}`,
    });
  }
  return out;
}

describe('isoWeekKey', () => {
  it('semana ISO, inclusive nas viradas de ano', () => {
    expect(isoWeekKey('2025-01-01T00:00:00Z')).toBe('2025-W01');
    expect(isoWeekKey('2024-12-30T10:00:00Z')).toBe('2025-W01');
    expect(isoWeekKey('2021-01-03T10:00:00Z')).toBe('2020-W53');
    expect(isoWeekKey('2025-10-05T00:00:00Z')).toBe('2025-W40');
  });
  it('data inválida → null', () => {
    expect(isoWeekKey('lixo')).toBeNull();
  });
});

describe('extractRecords', () => {
  const rec = (over = {}, outcome = { rResult: 0.5 }) => ({
    snapshot: { symbol: 'BTCUSDT', candle_time: '2025-03-10T08:00:00Z', volume_above_ma: true, chop_value: 45, ...over },
    outcome,
  });
  it('descarta e CONTA registros sem R, sem volume booleano ou sem chop (nunca vira 0)', () => {
    const report = { indicatorAttribution: { records: [
      rec(),
      rec({ volume_above_ma: null }),
      rec({ chop_value: null }),
      rec({}, { rResult: null }),
      rec({}, null),
      rec({ candle_time: 'x' }),
    ] } };
    const { records, dropped, total } = extractRecords(report);
    expect(total).toBe(6);
    expect(records).toHaveLength(1);
    expect(dropped).toBe(5);
    expect(records[0]).toMatchObject({ r: 0.5, volume: 1, chop: 45, week: '2025-W11', symbolMonth: 'BTCUSDT|2025-03' });
  });
  it('relatório sem atribuição não quebra', () => {
    expect(extractRecords({}).records).toEqual([]);
  });
});

describe('slopeClusterRobust', () => {
  it('reta exata y=2x+1: inclinação 2', () => {
    const x = [0, 1, 2, 3, 4, 5];
    const res = slopeClusterRobust(x, x.map((v) => 2 * v + 1), x.map((_, i) => `c${i}`));
    expect(res.slope).toBeCloseTo(2, 10);
  });
  it('valor conferido à mão (clusters unitários): se = sqrt(0,5)', () => {
    // x=[0,0,1,1], y=[0,1,1,2] → slope 1; resíduos ±0,5; Σ(x̃e)²=0,25; sxx=1;
    // var = 0,25 · (G/(G−1)=4/3) · ((n−1)/(n−2)=3/2) = 0,5
    const res = slopeClusterRobust([0, 0, 1, 1], [0, 1, 1, 2], ['a', 'b', 'c', 'd']);
    expect(res.slope).toBeCloseTo(1, 10);
    expect(res.se).toBeCloseTo(Math.sqrt(0.5), 10);
    expect(res.G).toBe(4);
  });
  it('IC usa t de Student com G−1 gl, não o z normal (G=4 → t=3,182446)', () => {
    const res = slopeClusterRobust([0, 0, 1, 1], [0, 1, 1, 2], ['a', 'b', 'c', 'd']);
    expect(res.crit).toBeCloseTo(3.182446, 4);
    expect(res.lower).toBeCloseTo(res.slope - 3.182446 * res.se, 4);
    expect(res.upper).toBeCloseTo(res.slope + 3.182446 * res.se, 4);
  });
  it('não estimável: 1 cluster, regressor constante ou n<3', () => {
    expect(slopeClusterRobust([0, 1, 2, 3], [1, 2, 3, 4], ['a', 'a', 'a', 'a'])).toBeNull();
    expect(slopeClusterRobust([1, 1, 1, 1], [1, 2, 3, 4], ['a', 'b', 'c', 'd'])).toBeNull();
    expect(slopeClusterRobust([0, 1], [0, 1], ['a', 'b'])).toBeNull();
  });
});

describe('verdictFrom (regra de decisão fixa)', () => {
  it('tabela completa', () => {
    expect(verdictFrom(false, [true, true])).toBe('INCONCLUSIVA_AMOSTRA');
    expect(verdictFrom(true, [true, true])).toBe('CONFIRMADA');
    expect(verdictFrom(true, [true, false])).toBe('DIVERGENTE_NAO_CONFIRMADA');
    expect(verdictFrom(true, [false, true])).toBe('DIVERGENTE_NAO_CONFIRMADA');
    expect(verdictFrom(true, [false, false])).toBe('NAO_CONFIRMADA');
  });
  it('constantes do pré-registro não mudam sem querer', () => {
    expect(PREREG).toMatchObject({ minRecords: 300, minClusters: 20, alphaTwoSided: 0.05 });
    expect(PREREG.clusterings).toEqual(['week', 'symbolMonth']);
  });
});

describe('evaluateHypothesis', () => {
  const H1 = { regressor: 'volume', direction: +1 };
  const H2 = { regressor: 'chop', direction: -1 };

  it('H1: efeito positivo forte de volume → CONFIRMADA', () => {
    expect(evaluateHypothesis(synth({ volEffect: 0.6 }), H1).verdict).toBe('CONFIRMADA');
  });
  it('H1: sem efeito → NAO_CONFIRMADA (o erro tipo I não vira "achado")', () => {
    expect(evaluateHypothesis(synth({ volEffect: 0 }), H1).verdict).toBe('NAO_CONFIRMADA');
  });
  it('H1: efeito NEGATIVO forte nunca confirma (direção importa)', () => {
    expect(evaluateHypothesis(synth({ volEffect: -0.6 }), H1).verdict).toBe('NAO_CONFIRMADA');
  });
  it('H2: R cai com o chop → CONFIRMADA; R sobe com o chop → NAO_CONFIRMADA', () => {
    expect(evaluateHypothesis(synth({ chopSlope: -0.04 }), H2).verdict).toBe('CONFIRMADA');
    expect(evaluateHypothesis(synth({ chopSlope: +0.04 }), H2).verdict).toBe('NAO_CONFIRMADA');
  });
  it('n < 300 → INCONCLUSIVA_AMOSTRA mesmo com efeito enorme', () => {
    const res = evaluateHypothesis(synth({ n: 200, volEffect: 2 }), H1);
    expect(res.reliable).toBe(false);
    expect(res.verdict).toBe('INCONCLUSIVA_AMOSTRA');
  });
  it('G < 20 clusters → INCONCLUSIVA_AMOSTRA mesmo com n grande e efeito enorme', () => {
    const res = evaluateHypothesis(synth({ n: 600, weeks: 10, volEffect: 2 }), H1);
    expect(res.specs.week.G).toBe(10);
    expect(res.verdict).toBe('INCONCLUSIVA_AMOSTRA');
  });
  it('é determinístico (mesma entrada, mesmo resultado)', () => {
    const a = evaluateHypothesis(synth({ volEffect: 0.3 }), H1);
    const b = evaluateHypothesis(synth({ volEffect: 0.3 }), H1);
    expect(a).toEqual(b);
  });
});

describe('analyzeReport (ponta a ponta)', () => {
  it('monta H1 e H2 a partir de um relatório', () => {
    const noise = makeNoise(3);
    const rand = mulberry32(5);
    const records = [];
    for (let i = 0; i < 600; i += 1) {
      const vol = rand() < 0.5;
      const chop = 30 + rand() * 30;
      const day = 1 + (i % 28);
      const month = 1 + (i % 12);
      records.push({
        snapshot: {
          symbol: `S${i % 7}`,
          candle_time: `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T08:00:00Z`,
          volume_above_ma: vol,
          chop_value: chop,
        },
        outcome: { rResult: (vol ? 0.7 : 0) - 0.05 * (chop - 45) + 0.8 * noise() },
      });
    }
    const result = analyzeReport({ indicatorAttribution: { records } });
    expect(result.usedRecords).toBe(600);
    expect(result.droppedRecords).toBe(0);
    expect(result.H1_volume.verdict).toBe('CONFIRMADA');
    expect(result.H2_chop.verdict).toBe('CONFIRMADA');
  });
});
