// docs/known-risks.md item 288 — o TESTE A SECO ponta a ponta, sem rede e sem banco:
// o "banco ao vivo" é um backend falso, a Binance é uma função que devolve velas sintéticas,
// e o provedor de velas é o MESMO do bundle (recoveryMarketDataProvider.js: pré-carga +
// limite − 1 como o ao vivo). Prova que o teste a seco (a) chega ao mesmo resultado de rodar
// sem parar, (b) não escreve nada no "banco" e (c) para nas travas antes de ler o banco.
import { describe, it, expect, vi } from 'vitest';
import { createFakeBackend } from '../src/lib/__fixtures__/fakeBackend.js';

vi.mock('@/api/entities', () => ({ backend: {} }));
vi.mock('../src/lib/telegram', () => ({
  isTelegramConfigured: vi.fn(() => false),
  notifyNewSignal: vi.fn(), notifyTradeCreated: vi.fn(), notifyTP1Hit: vi.fn(), notifyTP2Hit: vi.fn(),
  notifyStopHit: vi.fn(), notifyInvalidated: vi.fn(), notifyTimeStop: vi.fn(), notifyChopExit: vi.fn(),
  notifyLockDegraded: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
// Delegação preguiçosa ao provedor REAL da recuperação. (Importá-lo dentro da fábrica do mock
// trava: ele depende de backtestEngine → scanner → este mesmo módulo mockado.)
const market = vi.hoisted(() => ({ impl: null }));
vi.mock('../src/lib/marketDataProvider', () => ({
  fetchCandles: (...a) => market.impl.fetchCandles(...a),
  fetchCurrentPrice: (...a) => market.impl.fetchCurrentPrice(...a),
  MARKET_SOURCE: 'spot', DATA_EXCHANGE: 'binance', EXECUTOR: 'cron',
}));
vi.mock('../src/lib/pineParser', () => ({
  getPineConfig: vi.fn(),
  getPineConfigStatus: vi.fn(() => ({ source: 'postgres', version: null, hash: null, degraded: false })),
}));

import * as entitiesModule from '@/api/entities';
import { getPineConfig } from '../src/lib/pineParser';
import { runBacktest } from '../src/lib/backtestEngine.js';
import { exportSnapshot } from '../src/lib/recovery/snapshotBackend.js';
import { TIMEFRAME_MS } from '../src/lib/recovery/recoveryReplay.js';
import * as recoveryMarket from './recoveryMarketDataProvider.js';
import { preloadSeries, clearSeries, seriesFingerprint } from './recoveryMarketDataProvider.js';

market.impl = recoveryMarket;
import {
  runDryRun, formatDryRunMarkdown, formatAbortMarkdown, assertSignalsCover, RECOVERY_TIMEFRAMES, SIGNAL_SNAPSHOT_LIMIT,
  readSnapshot,
} from './recoveryDryRun.mjs';

const FOUR_H = TIMEFRAME_MS['4h'];
const FIFTEEN_M = TIMEFRAME_MS['15m'];
const iso = (ms) => new Date(ms).toISOString();
const mk = (open, high, low, close, openTime, intervalMs) => ({ open, high, low, close, volume: 100, openTime, closeTime: openTime + intervalMs, isClosed: true });

const START_4H = Date.parse('2026-01-01T00:00:00.000Z');
const FLIP = Date.parse('2026-01-18T04:00:00.000Z');
const FROM = FLIP - 2 * FOUR_H;
const TO = FLIP + 20 * FOUR_H;

// 4h: mesma série do item 261 + tombo entre FLIP e FLIP+8h (stop no meio da pausa).
function series4h() {
  const out = [];
  let p = 300;
  for (let i = 0; i < 100; i += 1) { out.push(mk(p, p + 0.2, p - 1.2, p - 1, START_4H + i * FOUR_H, FOUR_H)); p -= 1; }
  for (let i = 0; i < 60; i += 1) { out.push(mk(p, p + 3.2, p - 0.2, p + 3, START_4H + (100 + i) * FOUR_H, FOUR_H)); p += 3; }
  return out.map((c) => (c.closeTime > FLIP && c.closeTime <= FLIP + 2 * FOUR_H ? { ...c, open: 120, high: 125, low: 100, close: 110 } : c));
}
// 15m contínua até depois de TO (o teste a seco exige série sem buraco até o fim).
function series15m() {
  const start = FLIP - 100 * FIFTEEN_M;
  return Array.from({ length: 100 + 20 * 16 + 8 }, (_, i) => {
    const o = 100 + i * 0.5;
    return mk(o, o + 0.7, o - 0.2, o + 0.5, start + i * FIFTEEN_M, FIFTEEN_M);
  });
}
function flatSeries(tf, fromMs, toMs) {
  const iv = TIMEFRAME_MS[tf];
  const out = [];
  for (let t = Math.ceil(fromMs / iv) * iv; t + iv <= toMs + iv; t += iv) out.push(mk(100, 100.1, 99.9, 100, t, iv));
  return out;
}
const fullSeries = { '4h': series4h(), '15m': series15m() };
async function fetchSeries(symbol, tf, fromMs, toMs) {
  if (fullSeries[tf]) return fullSeries[tf].filter((c) => c.openTime <= toMs);
  return flatSeries(tf, fromMs, toMs);
}

const ASSET = {
  id: 'asset1', symbol: 'TESTUSDT', is_active: true,
  smc_enabled: false, smc_confirm_4h15m: false,
  timeframes_enabled: { '1h': false, '4h': true, '1d': false },
  rf_period: 20, rf_multiplier: 3.5,
};
const CFG = {
  minScore: 0, tp1R: 1.5, tp1QtyPercent: 50, trailAtrMult: 2.0,
  useADX: false, useChop: false, useTimeStop: true, useChopExit: false, useInvalidation: false, invalidRFBars: 2,
};
const PAUSED = [
  { path: '.github/workflows/scan.yml', state: 'disabled_manually' },
  { path: '.github/workflows/backfill.yml', state: 'disabled_manually' },
];

async function preloadAll() {
  clearSeries();
  for (const tf of RECOVERY_TIMEFRAMES) await preloadSeries(ASSET.symbol, tf, START_4H - 400 * TIMEFRAME_MS['1d'], TO + 2 * FOUR_H, fetchSeries);
}

// "Banco ao vivo" depois de o scan rodar até `untilMs` (o último scan antes da queda).
async function liveDb(untilMs) {
  getPineConfig.mockResolvedValue(CFG);
  await preloadAll();
  const live = createFakeBackend();
  Object.assign(entitiesModule.backend, live);
  live._seed('MonitoredAsset', { ...ASSET });
  live._seed('StrategyConfig', { id: 'current', tp1R: 1.5 });
  await runBacktest({ assets: [ASSET], backend: live, fromMs: FROM, toMs: untilMs, stepMs: FIFTEEN_M, pineConfig: CFG });
  await live.entities.MonitoredAsset.update(ASSET.id, { last_scan_at: iso(untilMs) });
  return live;
}

const deps = (live, over = {}) => ({
  liveBackend: live, workflows: PAUSED, entitiesTarget: entitiesModule.backend,
  getPineConfig: async () => CFG, getPineConfigStatus: () => ({ degraded: false }),
  nowMs: TO + 7 * 60 * 1000, runId: '40999999999', fetchSeries, ...over,
});
const byId = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
function mergeOps(before, diff) {
  const m = new Map(before.map((o) => [o.id, o]));
  for (const o of diff.ops.created) m.set(o.id, o);
  for (const c of diff.ops.changed) m.set(c.id, c.after);
  return [...m.values()];
}

describe('teste a seco ponta a ponta', () => {
  it('chega ao MESMO resultado de rodar sem parar, sem escrever nada no banco', async () => {
    const continuous = await liveDb(TO);
    const expectedOps = byId(await continuous.entities.TradeOperation.list());
    expect(expectedOps.some((o) => o.status === 'STOP_HIT')).toBe(true); // stop no meio da pausa

    const live = await liveDb(FLIP + FIFTEEN_M);
    const before = await exportSnapshot(live);
    const result = await runDryRun(deps(live));

    expect(result.ok).toBe(true);
    expect(result.windows[ASSET.id].fromMs).toBe(FLIP + 2 * FIFTEEN_M);
    expect(result.windows[ASSET.id].toMs).toBe(TO);
    expect(byId(mergeOps(before.TradeOperation, result.diff))).toEqual(expectedOps);
    expect(result.diff.ops.created.length).toBeGreaterThan(0);
    // Nada foi escrito no "banco ao vivo".
    expect(await exportSnapshot(live)).toEqual(before);
    // Etiquetas: só metadado; novas = recovery.
    for (const t of result.tags) expect(Object.keys(t.patch).every((k) => k.startsWith('recovery_') || k === 'source')).toBe(true);
    expect(result.summary).toMatch(/Operações novas \(deveriam ter aberto na pausa\): \d/);

    const md = formatDryRunMarkdown(result);
    expect(md).toMatch(/Nada foi gravado no banco/);
    expect(md).toMatch(/TESTUSDT \|/);
    expect(md).toMatch(/o número desta execução é `40999999999`/);
  }, 120000);

  it('dois testes a seco do mesmo banco dão as mesmas impressões digitais', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const a = await runDryRun(deps(live));
    const b = await runDryRun(deps(live));
    expect(b.fingerprints).toEqual(a.fingerprints);
  }, 120000);
});

describe('impressões digitais estáveis (achados do Codex no PR #523)', () => {
  it('a ordem em que o banco devolve as linhas não muda o retrato nem a impressão', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const a = await readSnapshot(live);
    // Mesmo banco devolvendo as linhas em ordem invertida (Postgres sem ORDER BY pode fazer isso).
    const reversed = { ...live, entities: Object.fromEntries(Object.entries(live.entities).map(([n, api]) => [n, {
      ...api, list: async (...x) => [...(await api.list(...x))].reverse(),
    }])) };
    const b = await readSnapshot(reversed);
    expect(b).toEqual(a);
  }, 120000);

  it('volume e horário de fechamento entram na impressão das velas', async () => {
    clearSeries();
    const base = [mk(1, 2, 0.5, 1.5, 0, FIFTEEN_M), mk(1.5, 2, 1, 1.8, FIFTEEN_M, FIFTEEN_M)];
    await preloadSeries('X', '15m', 0, 2 * FIFTEEN_M, async () => base);
    const f0 = seriesFingerprint();
    await preloadSeries('X', '15m', 0, 2 * FIFTEEN_M, async () => base.map((c, i) => (i === 1 ? { ...c, volume: 999 } : c)));
    expect(seriesFingerprint()).not.toBe(f0);
    await preloadSeries('X', '15m', 0, 2 * FIFTEEN_M, async () => base.map((c, i) => (i === 1 ? { ...c, closeTime: c.closeTime - 1 } : c)));
    expect(seriesFingerprint()).not.toBe(f0);
  });
});

describe('travas do teste a seco (param ANTES de simular)', () => {
  function spyReads(live) {
    let reads = 0;
    for (const api of Object.values(live.entities)) {
      for (const m of ['list', 'filter']) { const f = api[m]; api[m] = (...x) => { reads += 1; return f(...x); }; }
    }
    return () => reads;
  }

  it('"Backfill check" ligado → para sem ler o banco', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const reads = spyReads(live);
    const workflows = [PAUSED[0], { ...PAUSED[1], state: 'active' }];
    await expect(runDryRun(deps(live, { workflows }))).rejects.toMatchObject({ code: 'live_scan_active' });
    expect(reads()).toBe(0);
  }, 120000);

  it('sem StrategyConfig "current" → para (o replay usaria valores padrão)', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    await live.entities.StrategyConfig.delete('current');
    await expect(runDryRun(deps(live))).rejects.toMatchObject({ code: 'strategy_config_missing' });
  }, 120000);

  it('vela faltando na Binance → para sem simular nada', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const holed = async (symbol, tf, fromMs, toMs) => {
      const s = await fetchSeries(symbol, tf, fromMs, toMs);
      return tf === '15m' ? s.filter((c) => c.openTime !== FLIP + 4 * FIFTEEN_M) : s;
    };
    await expect(runDryRun(deps(live, { fetchSeries: holed }))).rejects.toMatchObject({ code: 'candle_gaps' });
  }, 120000);

  it('assertSignalsCover: lote cheio que não alcança 1 dia antes do início → para', () => {
    const recent = Array.from({ length: SIGNAL_SNAPSHOT_LIMIT }, (_, i) => ({ id: `s${i}`, created_date: iso(FLIP + i * 1000) }));
    expect(() => assertSignalsCover(recent, FLIP)).toThrow(expect.objectContaining({ code: 'snapshot_incomplete' }));
    expect(() => assertSignalsCover(recent.slice(0, 10), FLIP)).not.toThrow(); // lote incompleto = leu tudo
    const deep = [{ id: 'old', created_date: iso(FLIP - 2 * TIMEFRAME_MS['1d']) }, ...recent.slice(1)];
    expect(() => assertSignalsCover(deep, FLIP)).not.toThrow();
  });

  it('relatório de parada em português, sem nada gravado', () => {
    const md = formatAbortMarkdown(Object.assign(new Error('desative antes o Backfill check'), { code: 'live_scan_active' }));
    expect(md).toMatch(/TESTE A SECO PAROU/);
    expect(md).toMatch(/Nada foi gravado no banco/);
    expect(md).toMatch(/live_scan_active/);
  });
});
