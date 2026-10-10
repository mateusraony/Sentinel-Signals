// docs/known-risks.md item 266 — parsers e alinhamento do laboratório de
// padrões. O que importa aqui é "nada do futuro entra na barra": cada teste de
// alinhamento planta um valor no limite exato e confere que ele fica de fora.
import { describe, it, expect } from 'vitest';
import {
  buildMonthlyPremiumUrl,
  buildDailyMetricsUrl,
  parseFlowKlineCsv,
  parseUtcDateTime,
  parseMetricsCsv,
  alignRowsToBars,
  alignFundingToBars,
  buildLabBars,
  FUNDING_MAX_STALE_MS,
} from './patternLabArchive.js';
import { archivePlan } from './fetch-pattern-lab-data.mjs';

const MIN = 60 * 1000;
const H4 = 4 * 60 * MIN;
const C = Date.parse('2024-01-01T04:00:00Z'); // fechamento de uma barra 4h

describe('URLs', () => {
  it('premiumIndexKlines mensal e metrics diário', () => {
    expect(buildMonthlyPremiumUrl('BTCUSDT', '4h', 2024, 3))
      .toBe('https://data.binance.vision/data/futures/um/monthly/premiumIndexKlines/BTCUSDT/4h/BTCUSDT-4h-2024-03.zip');
    expect(buildDailyMetricsUrl('ETHUSDT', 2023, 1, 7))
      .toBe('https://data.binance.vision/data/futures/um/daily/metrics/ETHUSDT/ETHUSDT-metrics-2023-01-07.zip');
  });
});

describe('parseFlowKlineCsv', () => {
  it('lê volume agressor (col 9) e número de trades; pula cabeçalho; normaliza microssegundos', () => {
    const csv = [
      'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
      '1704067200000,1,2,0.5,1.5,100,1704081599999,150,42,60,90,0',
      '1704081600000000,1.5,2,1,1.8,50,1704095999999000,90,10,20,36,0',
    ].join('\n');
    expect(parseFlowKlineCsv(csv)).toEqual([
      { openTime: 1704067200000, close: 1.5, volume: 100, trades: 42, takerBuyVolume: 60 },
      { openTime: 1704081600000, close: 1.8, volume: 50, trades: 10, takerBuyVolume: 20 },
    ]);
  });
});

describe('parseMetricsCsv', () => {
  it('resolve colunas pelo nome (ordem trocada) e lê a data UTC', () => {
    const csv = [
      'symbol,count_long_short_ratio,create_time,sum_open_interest,sum_toptrader_long_short_ratio',
      'BTCUSDT,1.5,2024-01-01 00:05:00,1000,2.0',
    ].join('\n');
    expect(parseMetricsCsv(csv)).toEqual([
      { time: Date.parse('2024-01-01T00:05:00Z'), openInterest: 1000, topPositionLS: 2, globalAccountLS: 1.5 },
    ]);
  });

  it('coluna faltando aborta em vez de adivinhar', () => {
    expect(() => parseMetricsCsv('create_time,sum_open_interest\n2024-01-01 00:05:00,1')).toThrow(/sum_toptrader_long_short_ratio/);
  });

  it('parseUtcDateTime aceita data e epoch', () => {
    expect(parseUtcDateTime('2024-01-01 04:00:00')).toBe(C);
    expect(parseUtcDateTime(String(C))).toBe(C);
    expect(parseUtcDateTime('lixo')).toBeNaN();
  });
});

describe('alignRowsToBars — sem olhar o futuro', () => {
  const opts = { maxRowLagMs: 5 * MIN, maxStaleMs: 60 * MIN };

  it('linha carimbada EXATAMENTE no fechamento não entra (pico plantado); a de C−5min entra', () => {
    const rows = [{ time: C - 5 * MIN, v: 'ok' }, { time: C, v: 'PICO' }];
    expect(alignRowsToBars([C], rows, opts)[0].v).toBe('ok');
  });

  it('linha mais velha que 60 min vira null (buraco, não valor velho)', () => {
    expect(alignRowsToBars([C], [{ time: C - 61 * MIN, v: 'velha' }], opts)[0]).toBeNull();
    expect(alignRowsToBars([C], [{ time: C - 60 * MIN, v: 'limite' }], opts)[0].v).toBe('limite');
  });
});

describe('alignFundingToBars', () => {
  it('liquidação em C entra; depois de C não entra; normaliza por hora do intervalo', () => {
    const rows = [
      { calcTime: C - 8 * 60 * MIN, intervalHours: 8, rate: 0.0008 },
      { calcTime: C, intervalHours: 4, rate: 0.0004 },
      { calcTime: C + 1, intervalHours: 4, rate: 0.9 },
    ];
    expect(alignFundingToBars([C], rows)[0]).toBeCloseTo(0.0001, 12);
    expect(alignFundingToBars([C - 1], rows)[0]).toBeCloseTo(0.0001, 12); // a de 8h antes, 0,0008/8
  });

  it('intervalo ausente = 8h; mais de 24h sem liquidação vira null', () => {
    expect(alignFundingToBars([C], [{ calcTime: C - MIN, intervalHours: null, rate: 0.0008 }])[0]).toBeCloseTo(0.0001, 12);
    expect(alignFundingToBars([C], [{ calcTime: C - FUNDING_MAX_STALE_MS - 1, intervalHours: 8, rate: 0.001 }])[0]).toBeNull();
  });
});

describe('buildLabBars', () => {
  it('junta os datasets e descarta barra que fecha depois de dataEnd', () => {
    const k = (open, close) => ({ openTime: open, close, volume: 10, takerBuyVolume: 6, trades: 1 });
    const bars = buildLabBars({
      klines: [k(C - H4, 100), k(C, 101), k(C + H4, 102)],
      premium: [{ openTime: C - H4, close: 0.0002 }],
      funding: [{ calcTime: C - MIN, intervalHours: 8, rate: 0.0008 }],
      metricsRows: [{ time: C - 5 * MIN, openInterest: 5, topPositionLS: 1.2, globalAccountLS: 1.1 }],
      barMs: H4, dataStartMs: C - H4, dataEndMs: C + H4,
      maxRowLagMs: 5 * MIN, maxStaleMs: 60 * MIN,
    });
    expect(bars.map((b) => b.t)).toEqual([C, C + H4]);
    expect(bars[0]).toMatchObject({ close: 100, premium: 0.0002, openInterest: 5, topPositionLS: 1.2, globalAccountLS: 1.1 });
    expect(bars[0].fundingPerHour).toBeCloseTo(0.0001, 12);
    expect(bars[1].premium).toBeNull();
  });
});

describe('archivePlan — nada do período lacrado é baixado', () => {
  it('meses inteiros no mensal; mês final só dia a dia até antes de dataEnd', () => {
    const plan = archivePlan(Date.parse('2025-08-01T00:00:00Z'), Date.parse('2025-10-02T00:00:00Z'));
    expect(plan.monthly).toEqual([{ year: 2025, month: 8 }, { year: 2025, month: 9 }]);
    expect(plan.daily).toEqual([{ year: 2025, month: 10, day: 1 }]);
  });
});
