// docs/known-risks.md item 266 — montagem do download do laboratório contra
// uma "Binance" falsa (fetch substituído; zips gerados no teste). O que importa:
// as peças se encaixam e NENHUM endereço do período lacrado é pedido.
import { describe, it, expect, vi, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import { fetchSymbol } from './fetch-pattern-lab-data.mjs';

const H4 = 4 * 60 * 60 * 1000;
const PREREG = {
  barMinutes: 240,
  dataStart: '2025-09-30',
  dataEnd: '2025-10-02',
  metrics: { maxRowLagMinutes: 5, maxStaleMinutes: 60 },
};

function zipOf(csv) {
  const zip = new AdmZip();
  zip.addFile('data.csv', Buffer.from(csv));
  return zip.toBuffer();
}
const klineRows = (fromMs, count, close) => Array.from({ length: count }, (_, i) => {
  const t = fromMs + i * H4;
  return `${t},1,2,0.5,${close + i},100,${t + H4 - 1},150,10,60,90,0`;
}).join('\n');
const metricsRows = (dayMs) => ['create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio',
  ...Array.from({ length: 288 }, (_, k) => {
    const d = new Date(dayMs + k * 5 * 60 * 1000);
    const s = d.toISOString().replace('T', ' ').slice(0, 19);
    return `${s},BTCUSDT,${1000 + k},1,1,1.5,1.2,1`;
  })].join('\n');

const SEP29 = Date.parse('2025-09-29T00:00:00Z');
const OCT1 = Date.parse('2025-10-01T00:00:00Z');

function fakeBinance(requested) {
  return async (url) => {
    requested.push(url);
    const ok = (csv) => new Response(zipOf(csv), { status: 200 });
    if (url.includes('/monthly/klines/BTCUSDT/4h/BTCUSDT-4h-2025-09.zip')) return ok(klineRows(SEP29, 12, 100)); // 29 e 30/09
    if (url.includes('/daily/klines/BTCUSDT/4h/BTCUSDT-4h-2025-10-01.zip')) return ok(klineRows(OCT1, 6, 200));
    if (url.includes('/monthly/premiumIndexKlines/BTCUSDT/4h/BTCUSDT-4h-2025-09.zip')) return ok(klineRows(SEP29, 12, 0));
    if (url.includes('/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2025-09.zip')) {
      return ok(`calc_time,funding_interval_hours,last_funding_rate\n${Date.parse('2025-09-30T16:00:00Z')},8,0.0008`);
    }
    if (url.includes('/daily/metrics/BTCUSDT/BTCUSDT-metrics-2025-09-30.zip')) return ok(metricsRows(Date.parse('2025-09-30T00:00:00Z')));
    if (url.includes('/daily/metrics/BTCUSDT/BTCUSDT-metrics-2025-10-01.zip')) return ok(metricsRows(OCT1));
    return new Response('not found', { status: 404 });
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('fetchSymbol (Binance falsa)', () => {
  it('junta klines + prêmio + funding + metrics, recorta no pré-registro e nunca pede o período lacrado', async () => {
    const requested = [];
    vi.stubGlobal('fetch', fakeBinance(requested));
    const r = await fetchSymbol('BTCUSDT', PREREG);

    // 30/09 00:00 → 01/10 20:00 (abertura) = 12 velas; 29/09 fica de fora.
    expect(r.bars).toHaveLength(12);
    expect(new Date(r.bars[0].t).toISOString()).toBe('2025-09-30T04:00:00.000Z');
    expect(new Date(r.bars.at(-1).t).toISOString()).toBe('2025-10-02T00:00:00.000Z');
    expect(r.bars[0]).toMatchObject({ volume: 100, takerBuyVolume: 60 });
    expect(r.bars[0].openInterest).not.toBeNull();
    expect(r.bars.at(-1).fundingPerHour).toBeNull(); // última liquidação 30/09 16:00 → mais de 24h antes de 02/10 00:00
    expect(r.bars[4].fundingPerHour).toBeCloseTo(0.0001, 12); // 30/09 20:00
    expect(r.coverage).toMatchObject({ bars: 12, metricsDaysRequested: 2, metricsDaysMissing: 0 });

    // Nenhum arquivo do dia 02/10 em diante, nenhum mensal de outubro.
    const dates = requested.map((u) => u.match(/(\d{4}-\d{2}(?:-\d{2})?)\.zip$/)?.[1]).filter(Boolean);
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates) expect(d.length === 7 ? d < '2025-10' : d < '2025-10-02', d).toBe(true);
  });
});
