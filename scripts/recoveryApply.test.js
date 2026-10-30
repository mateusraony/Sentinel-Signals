// docs/known-risks.md item 288 — o modo APLICAR ponta a ponta, sem rede: o "banco ao vivo" é
// um backend falso (mesma regra de CAS de produção), a Binance é uma função que devolve velas
// sintéticas e o provedor de velas é o MESMO do pacote. Prova: aplicar o teste a seco aprovado
// deixa o banco igual a "rodar sem parar"; cada trava para ANTES de gravar; uma falha depois de
// começar a gravar é dita com todas as letras; sempre exatamente 1 mensagem no Telegram.
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
import { preloadSeries, clearSeries } from './recoveryMarketDataProvider.js';

market.impl = recoveryMarket;
import { runDryRun, RECOVERY_TIMEFRAMES } from './recoveryDryRun.mjs';
import { runApply, formatApplyMarkdown, diffEvents, LOCK_NAMES } from './recoveryApply.mjs';

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


const approve = async (live, nowMs = TO + 7 * 60 * 1000) => JSON.parse(JSON.stringify(await runDryRun(deps(live, { nowMs }))));
function applyDeps(live, approved, over = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      ...deps(live), approved, approvedRunId: approved.runId, runId: '41000000000',
      sendSummary: async (text) => { sent.push(text); return true; }, ...over,
    },
  };
}
function spyLocks(live) {
  const calls = [];
  live.locks.acquireScanLock = async (name, ttl, holder) => { calls.push(['acquire', name, holder]); return true; };
  live.locks.releaseScanLock = async (name, holder) => { calls.push(['release', name, holder]); };
  return calls;
}

describe('aplicar o teste a seco aprovado', () => {
  it('deixa o banco IGUAL a rodar sem parar, etiqueta só metadado, grava o cursor e manda 1 mensagem', async () => {
    const continuous = await liveDb(TO);
    const expected = byId(await continuous.entities.TradeOperation.list());

    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const lockCalls = spyLocks(live);
    const { deps: d, sent } = applyDeps(live, approved);
    const out = await runApply(d);

    expect(out.ok).toBe(true);
    const after = byId(await live.entities.TradeOperation.list());
    const strip = (o) => { const { source, recovery_original_source, recovery_run_id, recovery_detected_at, recovery_entry_lag_ms, ...rest } = o; return rest; };
    expect(after.map(strip)).toEqual(expected.map(strip));
    // Novas: source=recovery (fora das estatísticas ao vivo); antigas tocadas: só o id da recuperação.
    const created = out.diff.ops.created.map((o) => o.id);
    expect(created.length).toBeGreaterThan(0);
    for (const op of after) {
      if (created.includes(op.id)) expect(op.source).toBe('recovery');
      else if (out.diff.ops.changed.some((c) => c.id === op.id)) {
        expect(op.recovery_run_id).toBe('41000000000');
        expect(op.source).not.toBe('recovery');
      }
    }
    expect((await live.entities.MonitoredAsset.list())[0].recovery_replayed_to).toBe(new Date(TO).toISOString());
    // Locks pegos com o dono da recuperação e soltos no fim.
    for (const name of LOCK_NAMES) {
      expect(lockCalls).toContainEqual(['acquire', name, 'recovery_41000000000']);
      expect(lockCalls).toContainEqual(['release', name, 'recovery_41000000000']);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/APLICADO no banco/);
    expect(formatApplyMarkdown({ ...out, telegramSent: true })).toMatch(/APLICADA no banco/);
  }, 180000);

  it('aplicar DE NOVO com o mesmo teste a seco é recusado (o banco já mudou) e não grava nada', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    await runApply(applyDeps(live, approved).deps);
    const before = byId(await live.entities.TradeOperation.list());
    const { deps: d, sent } = applyDeps(live, approved);
    const out = await runApply(d);
    expect(out).toMatchObject({ ok: false, code: 'snapshot_changed', wrote: false });
    expect(byId(await live.entities.TradeOperation.list())).toEqual(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/NÃO aplicada — nada foi gravado/);
  }, 180000);
});

describe('travas do modo aplicar (param ANTES de gravar)', () => {
  async function expectNoWrite(live, run) {
    const before = byId(await live.entities.TradeOperation.list());
    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.wrote).toBe(false);
    expect(byId(await live.entities.TradeOperation.list())).toEqual(before);
    return out;
  }

  it('teste a seco com mais de 24 h é recusado', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live, FLIP + 2 * FIFTEEN_M);
    const out = await expectNoWrite(live, () => runApply(applyDeps(live, approved, { nowMs: FLIP + 2 * FIFTEEN_M + 25 * 3600 * 1000 }).deps));
    expect(out.code).toBe('approval_too_old');
  }, 180000);

  it('número digitado diferente do teste a seco baixado', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const out = await expectNoWrite(live, () => runApply(applyDeps(live, approved, { approvedRunId: '123' }).deps));
    expect(out.code).toBe('approval_mismatch');
  }, 180000);

  it('banco mexido depois do teste a seco', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const [op] = await live.entities.TradeOperation.list();
    await live.entities.TradeOperation.update(op.id, { notes: 'mexido no painel' });
    const out = await expectNoWrite(live, () => runApply(applyDeps(live, approved).deps));
    expect(out.code).toBe('snapshot_changed');
  }, 180000);

  it('política estrita: algo novo aconteceu depois do teste a seco → pede novo teste', async () => {
    const live = await liveDb(FLIP - FOUR_H); // a queda começa antes do sinal
    const approved = await approve(live, FLIP - FIFTEEN_M); // teste a seco ANTES do sinal: nada a fazer
    expect(diffEvents(approved.diff)).toEqual([]);
    // Aplicação 4 h depois (dentro das 24 h): nesse meio-tempo o sinal e a entrada aconteceram.
    const out = await expectNoWrite(live, () => runApply(applyDeps(live, approved, { nowMs: FLIP + FOUR_H + 7 * 60 * 1000 }).deps));
    expect(out.code).toBe('tail_changed');
    expect(out.summary).toMatch(/operação nova/);
  }, 180000);

  it('lock ocupado por outro processo (scan ao vivo ou painel aberto)', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const calls = spyLocks(live);
    live.locks.acquireScanLock = async (name, ttl, holder) => { calls.push(['acquire', name, holder]); return name !== 'price-check'; };
    const out = await expectNoWrite(live, () => runApply(applyDeps(live, approved).deps));
    expect(out.code).toBe('lock_busy');
    expect(calls).toContainEqual(['release', 'full-scan', 'recovery_41000000000']); // soltou o que tinha pego
  }, 180000);
});

describe('falha DEPOIS de começar a gravar', () => {
  it('a conferência pega o banco diferente da simulação e a mensagem diz "parou no meio"', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    // Simula um banco que grava algo diferente do motor (ex.: bug de persistência).
    const real = live.tradeOps.transitionTradeOp;
    live.tradeOps.transitionTradeOp = async (id, from, patch, opts) => real(id, from, { ...patch, campo_estranho: 1 }, opts);
    const { deps: d, sent } = applyDeps(live, approved);
    const out = await runApply(d);
    expect(out).toMatchObject({ ok: false, code: 'verify_mismatch', wrote: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/parou NO MEIO/);
    expect(sent[0]).toMatch(/NÃO rode de novo/);
    expect(formatApplyMarkdown(out)).toMatch(/PAROU NO MEIO/);
  }, 180000);
});
