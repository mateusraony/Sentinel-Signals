import { describe, it, expect } from 'vitest';
import { parseBcbSeries, computeAccrualCurve, computePriceChangeCurve, BCB_SERIES, BENCHMARK_OPTIONS } from './marketBenchmarks.js';

describe('parseBcbSeries', () => {
  it('parses dd/MM/yyyy dates and decimal-point values into sorted {timestamp, ratePct}', () => {
    const json = [
      { data: '02/08/2026', valor: '0.05' },
      { data: '01/08/2026', valor: '0.04' },
    ];
    const parsed = parseBcbSeries(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].ratePct).toBe(0.04); // sorted ascending by timestamp
    expect(parsed[1].ratePct).toBe(0.05);
    expect(parsed[0].timestamp).toBeLessThan(parsed[1].timestamp);
  });

  it('accepts decimal-comma values (some BCB series eras use comma)', () => {
    const parsed = parseBcbSeries([{ data: '01/08/2026', valor: '0,45' }]);
    expect(parsed[0].ratePct).toBe(0.45);
  });

  it('drops malformed entries instead of throwing', () => {
    const json = [
      { data: '01/08/2026', valor: '0.04' },
      { data: 'not-a-date', valor: '0.05' },
      { data: '02/08/2026', valor: 'not-a-number' },
    ];
    expect(parseBcbSeries(json)).toHaveLength(1);
  });

  it('returns [] for non-array input', () => {
    expect(parseBcbSeries(null)).toEqual([]);
    expect(parseBcbSeries(undefined)).toEqual([]);
  });
});

describe('computeAccrualCurve', () => {
  it('compounds periodic rates into cumulative % (order-only, periodicity-agnostic)', () => {
    // 1% then 1% again: (1.01 * 1.01 - 1) * 100 = 2.01%, not 2% (juros compostos, não simples)
    const curve = computeAccrualCurve([
      { timestamp: 1, ratePct: 1 },
      { timestamp: 2, ratePct: 1 },
    ]);
    expect(curve[0].market).toBeCloseTo(1, 6);
    expect(curve[1].market).toBeCloseTo(2.01, 6);
  });

  it('a zero-rate series stays flat at 0%', () => {
    const curve = computeAccrualCurve([{ timestamp: 1, ratePct: 0 }, { timestamp: 2, ratePct: 0 }]);
    expect(curve[1].market).toBe(0);
  });

  it('negative rates compound down correctly', () => {
    const curve = computeAccrualCurve([{ timestamp: 1, ratePct: -10 }, { timestamp: 2, ratePct: -10 }]);
    // (0.9 * 0.9 - 1) * 100 = -19%
    expect(curve[1].market).toBeCloseTo(-19, 6);
  });

  it('empty input returns empty curve', () => {
    expect(computeAccrualCurve([])).toEqual([]);
  });
});

describe('computePriceChangeCurve', () => {
  it('normalizes price points against a base price into % change', () => {
    const curve = computePriceChangeCurve(
      [{ timestamp: 1, close: 110 }, { timestamp: 2, close: 90 }],
      100,
    );
    expect(curve[0].market).toBeCloseTo(10, 6);
    expect(curve[1].market).toBeCloseTo(-10, 6);
  });

  it('returns [] when basePrice is invalid or zero (avoids divide-by-zero)', () => {
    expect(computePriceChangeCurve([{ timestamp: 1, close: 100 }], 0)).toEqual([]);
    expect(computePriceChangeCurve([{ timestamp: 1, close: 100 }], null)).toEqual([]);
  });
});

describe('BENCHMARK_OPTIONS registry', () => {
  it('exposes BTC + the 3 BCB series (CDI, Selic, IPCA) as selectable options', () => {
    const keys = BENCHMARK_OPTIONS.map((o) => o.key);
    expect(keys).toEqual(['BTC', 'CDI', 'SELIC', 'IPCA']);
    expect(BCB_SERIES).toEqual({ CDI: 12, SELIC: 11, IPCA: 433 });
    BENCHMARK_OPTIONS.forEach((option) => {
      expect(typeof option.fetchCurve).toBe('function');
      expect(typeof option.label).toBe('string');
    });
  });
});
