// docs/known-risks.md item 288 — replay de recuperação depois de uma queda longa do banco.
//
// Mesmo padrão de backtestEngine.test.js: o scanAsset/persistScanResults REAIS rodam
// contra um backend em memória e velas sintéticas. A propriedade central:
//
//   rodar o sistema SEM PARAR  ≡  rodar até a queda + retrato do banco + replay de recuperação
//
// (operações e sinais idênticos, campo a campo), e — não-vacuidade — o caminho que o
// sistema seguiria SEM o replay (uma passada ao vivo na volta) dá resultado ERRADO.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFakeBackend } from '../__fixtures__/fakeBackend.js';

vi.mock('@/api/entities', () => ({ backend: {} }));
vi.mock('../telegram', () => ({
  isTelegramConfigured: vi.fn(() => false),
  notifyNewSignal: vi.fn().mockResolvedValue(undefined),
  notifyTradeCreated: vi.fn().mockResolvedValue(undefined),
  notifyTP1Hit: vi.fn().mockResolvedValue(undefined),
  notifyTP2Hit: vi.fn().mockResolvedValue(undefined),
  notifyStopHit: vi.fn().mockResolvedValue(undefined),
  notifyInvalidated: vi.fn().mockResolvedValue(undefined),
  notifyTimeStop: vi.fn().mockResolvedValue(undefined),
  notifyChopExit: vi.fn().mockResolvedValue(undefined),
  notifyLockDegraded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock('../marketDataProvider', () => ({
  fetchCandles: vi.fn(), fetchCurrentPrice: vi.fn(), MARKET_SOURCE: 'futures', DATA_EXCHANGE: 'binance', EXECUTOR: 'browser',
}));
vi.mock('../pineParser', () => ({
  getPineConfig: vi.fn(),
  getPineConfigStatus: vi.fn(() => ({ source: 'postgres', version: null, hash: null, degraded: false })),
}));

import * as entitiesModule from '@/api/entities';
import { fetchCandles } from '../marketDataProvider';
import { getPineConfig } from '../pineParser';
import { sliceClosedAsOf, simNow, runBacktest, installSimClock, restoreClock } from '../backtestEngine.js';
import { createSnapshotBackend, exportSnapshot } from './snapshotBackend.js';
import {
  STEP_RF_MS, resolveResumePoint, computeReplayWindow, runRecoveryReplay, buildRecoveryDiff, fingerprint,
  sliceLikeLive, validateSeriesContinuity, assertLiveScanPaused, assertStrategyConfigPresent, assertRealClock,
  buildRecoveryTags, RECOVERY_TAG_KEYS, assertTagPatch, formatRecoverySummary, RecoveryAbort, LIVE_FETCH_LIMITS,
  runBacktestTo, clipSummaryForTelegram, TELEGRAM_SUMMARY_MAX,
} from './recoveryReplay.js';

const FOUR_H = 4 * 60 * 60 * 1000;
const FIFTEEN_M = 15 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function mkCandle(open, high, low, close, openTime, closeTime) {
  return { open, high, low, close, volume: 100, openTime, closeTime, isClosed: true };
}
function downtrendCandles(n, start, step, startMs, intervalMs) {
  return Array.from({ length: n }, (_, i) => {
    const open = start - i * step;
    const close = open - step;
    return mkCandle(open, open + 0.2, close - 0.2, close, startMs + i * intervalMs, startMs + (i + 1) * intervalMs);
  });
}
function uptrendCandles(n, start, step, startMs, intervalMs) {
  return Array.from({ length: n }, (_, i) => {
    const open = start + i * step;
    const close = open + step;
    return mkCandle(open, close + 0.2, open - 0.2, close, startMs + i * intervalMs, startMs + (i + 1) * intervalMs);
  });
}

// Mesma série do item 261 (backtestEngine.test.js): um flip de COMPRA da RF 4h em FLIP,
// confirmado na hora pela série de 15m. Entrada 150, stop 146.40, TP1 155.40, TP2 160.79.
const START_4H = Date.parse('2026-01-01T00:00:00.000Z');
const FLIP = Date.parse('2026-01-18T04:00:00.000Z');
const FROM = FLIP - 2 * FOUR_H;
const TO = FLIP + 20 * FOUR_H;
function base4h() {
  const down = downtrendCandles(100, 300, 1, START_4H, FOUR_H);
  const up = uptrendCandles(60, down[down.length - 1].close, 3, START_4H + 100 * FOUR_H, FOUR_H);
  return [...down, ...up];
}
function base15m() {
  return uptrendCandles(100, 100, 0.5, FLIP - 100 * FIFTEEN_M, FIFTEEN_M);
}
// Tombo entre (a, b]: a 1ª operação é estopada NO MEIO da pausa e uma 2ª operação abre
// e anda (TP1) também dentro da pausa — exatamente o que o ao vivo perde.
const dip = (series, a, b) => series.map((c) => (c.closeTime > a && c.closeTime <= b
  ? { ...c, open: 120, high: 125, low: 100, close: 110 } : c));
// Preço parado entre o stop e o TP1 depois da entrada: só o Time Stop encerra.
const flatAfterEntry = (series) => series.map((c) => (c.closeTime > FLIP
  ? { ...c, open: 151, high: 151.3, low: 150.7, close: 151 + ((c.closeTime - FLIP) / FOUR_H) * 0.05 } : c));

const ASSET = {
  id: 'asset1', symbol: 'TESTUSDT', is_active: true,
  smc_enabled: false, smc_confirm_4h15m: false,
  timeframes_enabled: { '1h': false, '4h': true, '1d': false },
  rf_period: 20, rf_multiplier: 3.5,
};
function pineConfig(overrides = {}) {
  return {
    minScore: 0, tp1R: 1.5, tp1QtyPercent: 50, trailAtrMult: 2.0,
    useADX: false, useChop: false,
    useTimeStop: true, useChopExit: false, useInvalidation: false, invalidRFBars: 2,
    ...overrides,
  };
}

function setMarket(candles4h, cfg) {
  getPineConfig.mockResolvedValue(cfg);
  const candles15m = base15m();
  fetchCandles.mockImplementation(async (sym, tf, limit) =>
    sliceClosedAsOf(tf === '4h' ? candles4h : tf === '15m' ? candles15m : [], simNow(), limit));
}
const byId = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

// O "ao vivo" rodando até `untilMs` (o último scan antes da queda). O retrato do banco
// traz o MonitoredAsset com o last_scan_at desse último scan, como o cron grava.
async function liveUntil(candles4h, cfg, untilMs) {
  setMarket(candles4h, cfg);
  const live = createFakeBackend();
  Object.assign(entitiesModule.backend, live);
  live._seed('MonitoredAsset', { ...ASSET });
  await runBacktest({ assets: [ASSET], backend: live, fromMs: FROM, toMs: untilMs, stepMs: FIFTEEN_M, pineConfig: cfg });
  await live.entities.MonitoredAsset.update(ASSET.id, { last_scan_at: iso(untilMs) });
  return { live, snapshot: await exportSnapshot(live) };
}

async function continuous(candles4h, cfg, toMs = TO) {
  const { snapshot } = await liveUntil(candles4h, cfg, toMs);
  return snapshot;
}

const rowsForAsset = (snap, assetId) => ({
  assetStates: snap.AssetState.filter((r) => r.asset_id === assetId),
  ops: snap.TradeOperation.filter((r) => r.asset_id === assetId),
  signals: snap.SignalEvent.filter((r) => r.asset_id === assetId),
  tasks: snap.VerificationTask.filter((r) => r.asset_id === assetId),
});

async function recover(snapshot, cfg, { toMs = TO, forceFromMs = null } = {}) {
  getPineConfig.mockResolvedValue(cfg);
  const { backend, journal } = createSnapshotBackend(snapshot);
  Object.assign(entitiesModule.backend, backend);
  const assetRow = snapshot.MonitoredAsset.find((a) => a.id === ASSET.id);
  const fromMs = forceFromMs ?? resolveResumePoint({
    asset: assetRow, rows: rowsForAsset(snapshot, ASSET.id), stepMs: STEP_RF_MS, nowMs: toMs,
  }).fromMs;
  const window = computeReplayWindow({ fromMs, nowMs: toMs, stepMs: STEP_RF_MS });
  await runRecoveryReplay({ assets: [assetRow], windows: { [ASSET.id]: window }, pineConfig: cfg });
  return { after: await exportSnapshot(backend), journal, window };
}

// O que o sistema faria SEM o replay: uma única passada ao vivo quando o banco volta.
async function singleLiveTickAt(snapshot, cfg, tMs) {
  getPineConfig.mockResolvedValue(cfg);
  const { backend } = createSnapshotBackend(snapshot);
  Object.assign(entitiesModule.backend, backend);
  await runBacktest({ assets: [ASSET], backend, fromMs: tMs, toMs: runBacktestTo({ fromMs: tMs, toMs: tMs }), stepMs: FIFTEEN_M, pineConfig: cfg });
  return exportSnapshot(backend);
}

afterEach(() => restoreClock());

describe('equivalência: sem parar ≡ queda + retrato + replay de recuperação', () => {
  const CASES = [
    ['a queda começa ANTES do sinal (o sinal e a entrada nascem na pausa)', base4h, () => pineConfig(), FLIP - FOUR_H],
    ['a queda começa entre a criação e o TP1', base4h, () => pineConfig(), FLIP + FIFTEEN_M],
    ['stop tocado no meio da pausa + 2ª operação abre e anda dentro dela', () => dip(base4h(), FLIP, FLIP + 2 * FOUR_H), () => pineConfig(), FLIP + FIFTEEN_M],
    ['a queda começa depois do TP1 da 2ª operação (runner com trailing)', () => dip(base4h(), FLIP, FLIP + 2 * FOUR_H), () => pineConfig(), Date.parse('2026-01-19T08:15:00.000Z')],
    ['Time Stop vence dentro da pausa', () => flatAfterEntry(base4h()), () => pineConfig({ timeStopBarsOverride: 6 }), FLIP + FIFTEEN_M],
  ];

  it.each(CASES)('%s', async (_label, mkCandles, mkCfg, outageMs) => {
    const cfg = mkCfg();
    const expected = await continuous(mkCandles(), cfg);
    // Não-vacuidade do cenário: houve operação de verdade para comparar.
    expect(expected.TradeOperation.length).toBeGreaterThan(0);

    const { snapshot } = await liveUntil(mkCandles(), cfg, outageMs);
    const { after, window } = await recover(snapshot, cfg);

    expect(window.fromMs).toBe(outageMs + FIFTEEN_M);
    expect(byId(after.TradeOperation)).toEqual(byId(expected.TradeOperation));
    expect(byId(after.SignalEvent)).toEqual(byId(expected.SignalEvent));
    expect(byId(after.VerificationTask)).toEqual(byId(expected.VerificationTask));
  }, 60000);
});

describe('não-vacuidade: sem o replay, a volta do banco dá resultado ERRADO', () => {
  it('uma passada ao vivo na volta não vê o stop do meio da pausa nem a operação que abriu nela', async () => {
    const cfg = pineConfig();
    const candles = () => dip(base4h(), FLIP, FLIP + 2 * FOUR_H);
    const expected = await continuous(candles(), cfg);
    const { snapshot } = await liveUntil(candles(), cfg, FLIP + FIFTEEN_M);
    const naive = await singleLiveTickAt(snapshot, cfg, TO);

    const firstId = snapshot.TradeOperation[0].id;
    expect(expected.TradeOperation.find((o) => o.id === firstId).status).toBe('STOP_HIT');
    expect(naive.TradeOperation.find((o) => o.id === firstId).status).not.toBe('STOP_HIT');
    // A operação que abriu dentro da pausa só existe com o replay.
    expect(expected.TradeOperation.length).toBe(2);
    expect(naive.TradeOperation.length).toBe(1);
  }, 60000);

  it('uma passada ao vivo na volta fecha o Time Stop no preço de HOJE (o replay fecha no preço certo)', async () => {
    const cfg = pineConfig({ timeStopBarsOverride: 6 });
    const candles = () => flatAfterEntry(base4h());
    const expected = await continuous(candles(), cfg);
    const { snapshot } = await liveUntil(candles(), cfg, FLIP + FIFTEEN_M);
    const naive = await singleLiveTickAt(snapshot, cfg, TO);

    const id = snapshot.TradeOperation[0].id;
    const ok = expected.TradeOperation.find((o) => o.id === id);
    const bad = naive.TradeOperation.find((o) => o.id === id);
    expect(ok.closed_reason).toBe('TIME_STOP');
    expect(bad.closed_reason).toBe('TIME_STOP');
    // Mesma "hora real" gravada, preços diferentes: o ao vivo usa o fechamento de HOJE.
    expect(bad.exit_price).not.toBe(ok.exit_price);
  }, 60000);
});

describe('guardas do replay', () => {
  it('começar ANTES do último processamento reproduz o STOP falso; com a guarda, igual ao sem parar', async () => {
    const cfg = pineConfig();
    const candles = () => dip(base4h(), FLIP, FLIP + 2 * FOUR_H);
    const outage = Date.parse('2026-01-19T08:15:00.000Z');
    const expected = await continuous(candles(), cfg);
    const { snapshot } = await liveUntil(candles(), cfg, outage);
    const runner = snapshot.TradeOperation.find((o) => o.status === 'RUNNER_ACTIVE');
    expect(runner).toBeTruthy();

    const guarded = await recover(snapshot, cfg);
    expect(byId(guarded.after.TradeOperation)).toEqual(byId(expected.TradeOperation));

    // Sem a guarda: reprocessar velas já processadas com o estado NOVO (stop já avançado).
    const unguarded = await recover(snapshot, cfg, { forceFromMs: FLIP + FIFTEEN_M });
    expect(byId(unguarded.after.TradeOperation)).not.toEqual(byId(expected.TradeOperation));
  }, 60000);

  it('rodar de novo depois de terminar não escreve nada (a janela fica vazia)', async () => {
    const cfg = pineConfig();
    const { snapshot } = await liveUntil(base4h(), cfg, FLIP + FIFTEEN_M);
    const first = await recover(snapshot, cfg);
    expect(first.journal.length).toBeGreaterThan(0);
    const done = structuredClone(first.after);
    done.MonitoredAsset = done.MonitoredAsset.map((a) => ({ ...a, recovery_replayed_to: iso(first.window.toMs) }));
    const second = await recover(done, cfg);
    expect(second.window.empty).toBe(true);
    expect(second.journal).toEqual([]);
  }, 60000);

  it('cair no meio e retomar pelo cursor dá o mesmo fim de uma vez só', async () => {
    const cfg = pineConfig();
    const candles = () => dip(base4h(), FLIP, FLIP + 2 * FOUR_H);
    const { snapshot } = await liveUntil(candles(), cfg, FLIP + FIFTEEN_M);
    const oneShot = await recover(snapshot, cfg);

    const mid = Date.parse('2026-01-18T20:00:00.000Z');
    const part1 = await recover(snapshot, cfg, { toMs: mid });
    const resumed = structuredClone(part1.after);
    resumed.MonitoredAsset = resumed.MonitoredAsset.map((a) => ({ ...a, recovery_replayed_to: iso(part1.window.toMs) }));
    const part2 = await recover(resumed, cfg);
    expect(part2.window.fromMs).toBe(mid + FIFTEEN_M);
    expect(byId(part2.after.TradeOperation)).toEqual(byId(oneShot.after.TradeOperation));
  }, 60000);

  it('nada é criado nem muda de estado antes do início do replay', async () => {
    const cfg = pineConfig();
    const candles = () => dip(base4h(), FLIP, FLIP + 2 * FOUR_H);
    const { snapshot } = await liveUntil(candles(), cfg, FLIP + FIFTEEN_M);
    const { after, window } = await recover(snapshot, cfg);
    const diff = buildRecoveryDiff(snapshot, after);
    expect(diff.ops.created.length + diff.ops.changed.length).toBeGreaterThan(0);
    for (const op of diff.ops.created) expect(Date.parse(op.created_date)).toBeGreaterThanOrEqual(window.fromMs);
    for (const ch of diff.ops.changed) {
      for (const k of ch.changedKeys.filter((key) => /_at$/.test(key))) {
        expect(Date.parse(ch.after[k])).toBeGreaterThanOrEqual(window.fromMs);
      }
    }
  }, 60000);

  it('teste a seco não escreve no banco "real": o retrato é copiado e o original fica intacto', async () => {
    const cfg = pineConfig();
    const { live, snapshot } = await liveUntil(dip(base4h(), FLIP, FLIP + 2 * FOUR_H), cfg, FLIP + FIFTEEN_M);
    const before = await exportSnapshot(live);
    const { journal } = await recover(snapshot, cfg);
    expect(journal.length).toBeGreaterThan(0); // o replay fez coisas...
    expect(await exportSnapshot(live)).toEqual(before); // ...só na memória
  }, 60000);

  it('determinismo: dois testes a seco do mesmo retrato dão o mesmo diário', async () => {
    const cfg = pineConfig();
    const { snapshot } = await liveUntil(dip(base4h(), FLIP, FLIP + 2 * FOUR_H), cfg, FLIP + FIFTEEN_M);
    const a = await recover(snapshot, cfg);
    const b = await recover(snapshot, cfg);
    expect(a.journal.length).toBeGreaterThan(0);
    expect(fingerprint(b.journal)).toBe(fingerprint(a.journal));
  }, 60000);

  it('falha de busca de vela no meio do replay PARA tudo (nada deve ser aplicado)', async () => {
    const cfg = pineConfig();
    const { snapshot } = await liveUntil(base4h(), cfg, FLIP + FIFTEEN_M);
    fetchCandles.mockImplementation(async () => { throw new Error('rede caiu'); });
    await expect(recover(snapshot, cfg)).rejects.toMatchObject({ code: 'replay_integrity' });
  }, 60000);
});

describe('resolveResumePoint', () => {
  const NOW = Date.parse('2026-11-01T12:00:00.000Z');
  it('começa no 1º passo DEPOIS do último processamento do motor (last_scan_at / recovery_replayed_to)', () => {
    const asset = { id: 'a', symbol: 'X', last_scan_at: '2026-10-19T10:07:12.000Z' };
    expect(resolveResumePoint({ asset, nowMs: NOW, stepMs: FIFTEEN_M }).fromMs).toBe(Date.parse('2026-10-19T10:15:00.000Z'));
    const replayed = { ...asset, recovery_replayed_to: '2026-10-25T00:00:00.000Z' };
    expect(resolveResumePoint({ asset: replayed, nowMs: NOW, stepMs: FIFTEEN_M }).fromMs).toBe(Date.parse('2026-10-25T00:15:00.000Z'));
    // Em cima do passo exato: o passo seguinte (nunca reprocessa o mesmo).
    const exact = { id: 'a', last_scan_at: '2026-10-19T10:15:00.000Z' };
    expect(resolveResumePoint({ asset: exact, nowMs: NOW, stepMs: FIFTEEN_M }).fromMs).toBe(Date.parse('2026-10-19T10:30:00.000Z'));
  });

  it('carimbo escrito pelo PAINEL depois da volta do banco NÃO pula a pausa (achado do Codex, PR #522)', () => {
    // Tarefa revisada no painel em 01/11 11:58 e um price-check logo depois do último scan:
    // nenhum dos dois é processamento de velas — o início continua logo depois de 19/10.
    const asset = { id: 'a', symbol: 'X', last_scan_at: '2026-10-19T10:07:12.000Z' };
    const rows = {
      tasks: [{ id: 't', reviewed_at: '2026-11-01T11:58:00.000Z' }],
      ops: [{ id: 'o', stop_hit_at: '2026-10-19T10:08:00.000Z' }],
    };
    const rp = resolveResumePoint({ asset, rows, nowMs: NOW, stepMs: FIFTEEN_M });
    expect(rp.fromMs).toBe(Date.parse('2026-10-19T10:15:00.000Z'));
    expect(rp.latestRowWrite).toBe(Date.parse('2026-11-01T11:58:00.000Z')); // só informado
  });

  it('aborta: sem nenhum carimbo, carimbo no futuro, pausa longa demais', () => {
    expect(() => resolveResumePoint({ asset: { id: 'a' }, nowMs: NOW })).toThrow(RecoveryAbort);
    expect(() => resolveResumePoint({ asset: { id: 'a', last_scan_at: '2026-11-02T00:00:00Z' }, nowMs: NOW }))
      .toThrow(expect.objectContaining({ code: 'future_timestamp' }));
    expect(() => resolveResumePoint({ asset: { id: 'a', last_scan_at: '2026-09-01T00:00:00Z' }, nowMs: NOW }))
      .toThrow(expect.objectContaining({ code: 'gap_too_long' }));
  });
});

describe('janela, velas e travas', () => {
  it('janela de UM passo roda exatamente esse passo (runBacktest exige toMs > fromMs)', async () => {
    const t = FLIP;
    expect(runBacktestTo({ fromMs: t, toMs: t })).toBe(t + 1);
    expect(runBacktestTo({ fromMs: t, toMs: t + FIFTEEN_M })).toBe(t + FIFTEEN_M);
    const ticks = [];
    const fake = vi.fn(async ({ fromMs, toMs, stepMs }) => {
      for (let x = fromMs; x <= toMs; x += stepMs) ticks.push(x);
      return { dataIntegrity: { valid: true } };
    });
    await runRecoveryReplay({ assets: [ASSET], windows: { [ASSET.id]: { fromMs: t, toMs: t, stepMs: FIFTEEN_M, ticks: 1, empty: false } }, runBacktestImpl: fake });
    expect(ticks).toEqual([t]);
  });

  it('computeReplayWindow: fim no último passo fechado e aquecimento por timeframe', () => {
    const fromMs = Date.parse('2026-10-19T10:15:00.000Z');
    const w = computeReplayWindow({ fromMs, nowMs: Date.parse('2026-11-01T12:07:00.000Z'), stepMs: FIFTEEN_M });
    expect(w.toMs).toBe(Date.parse('2026-11-01T12:00:00.000Z'));
    expect(w.ticks).toBe((w.toMs - fromMs) / FIFTEEN_M + 1);
    expect(w.fetch['4h'].fromMs).toBe(fromMs - (LIVE_FETCH_LIMITS['4h'] + 50) * FOUR_H);
    expect(computeReplayWindow({ fromMs: w.toMs + FIFTEEN_M, nowMs: w.toMs, stepMs: FIFTEEN_M }).empty).toBe(true);
  });

  it('sliceLikeLive entrega limite − 1 velas fechadas, como o ao vivo (item 287)', () => {
    const series = Array.from({ length: 10 }, (_, i) => mkCandle(1, 1, 1, 1, i * 1000, (i + 1) * 1000));
    expect(sliceLikeLive(series, 10_000, 4).map((c) => c.closeTime)).toEqual([8000, 9000, 10_000]);
    expect(sliceLikeLive(series, 10_000, 1)).toEqual([]);
    expect(sliceLikeLive(series, 5000).length).toBe(5);
  });

  it('validateSeriesContinuity acha buraco e série curta; aquecimento curto só avisa', () => {
    const ok = Array.from({ length: 10 }, (_, i) => mkCandle(1, 1, 1, 1, i * 1000, (i + 1) * 1000));
    expect(validateSeriesContinuity(ok, 1000, { fromMs: 0, toMs: 10_000 })).toEqual({ problems: [], warmupShort: false });
    const holed = ok.filter((_, i) => i !== 4);
    expect(validateSeriesContinuity(holed, 1000, { fromMs: 0, toMs: 10_000 }).problems.join()).toMatch(/buraco/);
    expect(validateSeriesContinuity(ok, 1000, { fromMs: 0, toMs: 20_000 }).problems.join()).toMatch(/termina/);
    expect(validateSeriesContinuity(ok, 1000, { fromMs: -5000, toMs: 10_000 }).warmupShort).toBe(true);
  });

  it('assertLiveScanPaused: scan e checagem retroativa precisam estar desativados', () => {
    const off = [
      { path: '.github/workflows/scan.yml', state: 'disabled_manually' },
      { path: '.github/workflows/backfill.yml', state: 'disabled_manually' },
    ];
    expect(() => assertLiveScanPaused(off)).not.toThrow();
    const backfillOn = [off[0], { ...off[1], state: 'active' }];
    expect(() => assertLiveScanPaused(backfillOn)).toThrow(expect.objectContaining({ code: 'live_scan_active' }));
    expect(() => assertLiveScanPaused([])).toThrow(RecoveryAbort);
  });

  it('assertStrategyConfigPresent: sem configuração ou degradada, não recupera', () => {
    expect(() => assertStrategyConfigPresent({ row: null })).toThrow(expect.objectContaining({ code: 'strategy_config_missing' }));
    expect(() => assertStrategyConfigPresent({ row: { id: 'current' }, status: { degraded: true } }))
      .toThrow(expect.objectContaining({ code: 'strategy_config_degraded' }));
    expect(() => assertStrategyConfigPresent({ row: { id: 'current' }, status: { degraded: false } })).not.toThrow();
  });

  it('assertRealClock: lock com relógio simulado lança (o lock nasceria vencido)', () => {
    expect(() => assertRealClock()).not.toThrow();
    installSimClock(Date.parse('2026-01-01T00:00:00Z'));
    expect(() => assertRealClock('pegar o lock')).toThrow(expect.objectContaining({ code: 'sim_clock_active' }));
    restoreClock();
    expect(() => assertRealClock()).not.toThrow();
  });
});

describe('diferença, etiquetas e resumo', () => {
  const before = { TradeOperation: [{ id: 'old', symbol: 'BTCUSDT', side: 'BUY', status: 'SIGNAL_CONFIRMED' }], SignalEvent: [], VerificationTask: [] };
  const after = {
    TradeOperation: [
      { id: 'old', symbol: 'BTCUSDT', side: 'BUY', status: 'STOP_HIT', exit_price: 95, stop_hit_real_time: '2026-10-22T12:00:00.000Z' },
      { id: 'new', symbol: 'ETHUSDT', side: 'SELL', status: 'RUNNER_ACTIVE', entry_price: 2400, created_date: '2026-10-25T08:00:00.000Z', candle_close_time: '2026-10-25T08:00:00.000Z' },
    ],
    SignalEvent: [{ id: 's1' }], VerificationTask: [],
  };

  it('operação aberta que o replay NÃO mexeu entra na conta de abertas (achado do Codex, PR #522)', () => {
    const still = { TradeOperation: [{ id: 'x', symbol: 'SOLUSDT', status: 'SIGNAL_CONFIRMED' }], SignalEvent: [], VerificationTask: [] };
    const d = buildRecoveryDiff(still, structuredClone(still));
    expect(d.ops.created).toEqual([]);
    expect(d.ops.changed).toEqual([]);
    expect(formatRecoverySummary({ diff: d, windowFromMs: 0, windowToMs: 0 })).toMatch(/abertas depois da recuperação \(todas, mexidas ou não\): 1/);
  });

  it('buildRecoveryDiff separa criadas e mudadas', () => {
    const d = buildRecoveryDiff(before, after);
    expect(d.ops.created.map((o) => o.id)).toEqual(['new']);
    expect(d.ops.changed.map((c) => [c.id, c.changedKeys])).toEqual([['old', ['exit_price', 'status', 'stop_hit_real_time']]]);
    expect(d.signals.created).toHaveLength(1);
  });

  it('etiquetas: só metadado, nunca status/stop/preço; novas marcadas source=recovery', () => {
    const tags = buildRecoveryTags({ diff: buildRecoveryDiff(before, after), runId: 'run42', detectedAtMs: Date.parse('2026-11-01T12:00:00.000Z') });
    const novo = tags.find((t) => t.id === 'new').patch;
    expect(novo).toMatchObject({ source: 'recovery', recovery_run_id: 'run42', recovery_original_source: null });
    expect(novo.recovery_entry_lag_ms).toBe(Date.parse('2026-11-01T12:00:00.000Z') - Date.parse('2026-10-25T08:00:00.000Z'));
    expect(tags.find((t) => t.id === 'old').patch).toEqual({ recovery_run_id: 'run42' });
    for (const t of tags) for (const k of Object.keys(t.patch)) expect(RECOVERY_TAG_KEYS).toContain(k);
    expect(() => assertTagPatch({ status: 'CLOSED' })).toThrow(expect.objectContaining({ code: 'tag_not_allowed' }));
  });

  it('fingerprint não depende da ordem das chaves', () => {
    expect(fingerprint({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(fingerprint({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it('resumo em português com horário de Brasília', () => {
    const text = formatRecoverySummary({
      diff: buildRecoveryDiff(before, after),
      windowFromMs: Date.parse('2026-10-19T10:15:00.000Z'), windowToMs: Date.parse('2026-11-01T12:00:00.000Z'),
    });
    expect(text).toMatch(/Período reprocessado: 19\/10 07:15 a 01\/11 09:00/);
    expect(text).toMatch(/Operações novas \(deveriam ter aberto na pausa\): 1/);
    expect(text).toMatch(/BTCUSDT SIGNAL_CONFIRMED → STOP_HIT a 95 \(vela de 22\/10 09:00\)/);
    expect(text).toMatch(/Operações abertas depois da recuperação \(todas, mexidas ou não\): 1/);
  });
});


// PR-10 (auditoria de 31/10) — parada entre ativos e mensagem do Telegram dentro do limite.
describe('shouldStop — parada limpa ENTRE ativos', () => {
  const mkAsset = (n) => ({ id: `a${n}`, symbol: `S${n}USDT` });
  const win = { fromMs: FLIP, toMs: FLIP, stepMs: FIFTEEN_M, ticks: 1, empty: false };
  const assets = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const windows = Object.fromEntries(assets.map((a) => [a.id, win]));

  it('depois de pedir para parar, os que faltam voltam como pendentes e NÃO são reprocessados', async () => {
    const ran = [];
    const fake = vi.fn(async ({ assets: [a] }) => { ran.push(a.id); return { dataIntegrity: { valid: true } }; });
    const done = [];
    let calls = 0;
    const out = await runRecoveryReplay({
      assets, windows, runBacktestImpl: fake,
      shouldStop: () => { calls += 1; return calls >= 2; }, // 1ª pergunta: segue; 2ª: para
      onAssetDone: async (a) => { done.push(a.id); },
    });
    expect(ran).toEqual(['a1']);
    expect(done).toEqual(['a1']);
    expect(out.map((r) => [r.assetId, Boolean(r.pending)])).toEqual([['a1', false], ['a2', true], ['a3', true]]);
  });

  it('é "pegajoso": uma vez que pediu para parar, não volta a rodar o ativo seguinte', async () => {
    const ran = [];
    const fake = vi.fn(async ({ assets: [a] }) => { ran.push(a.id); return { dataIntegrity: { valid: true } }; });
    const answers = [false, true, false]; // a 3ª resposta "false" não pode religar o laço
    await runRecoveryReplay({ assets, windows, runBacktestImpl: fake, shouldStop: () => answers.shift() ?? false });
    expect(ran).toEqual(['a1']);
  });

  it('sem shouldStop o comportamento é o de sempre (todos rodam)', async () => {
    const ran = [];
    const fake = vi.fn(async ({ assets: [a] }) => { ran.push(a.id); return { dataIntegrity: { valid: true } }; });
    const out = await runRecoveryReplay({ assets, windows, runBacktestImpl: fake });
    expect(ran).toEqual(['a1', 'a2', 'a3']);
    expect(out.some((r) => r.pending)).toBe(false);
  });
});

describe('clipSummaryForTelegram — o resumo cabe no limite de 4.096 caracteres', () => {
  const cabecalho = ['Recuperação após pausa do banco (APLICADO no banco)', 'Período reprocessado: 19/10 a 01/11 (horário de Brasília)'];
  const make = (novas, fechadas) => [
    ...cabecalho,
    `Operações novas (deveriam ter aberto na pausa): ${novas}`,
    ...Array.from({ length: novas }, (_, i) => `• SIMBOLO${i}USDT BUY — entrada ${1000 + i} em 20/10/2026 10:15 — agora: STOP_HIT`),
    `Operações antigas que mudaram de estado: ${fechadas}`,
    ...Array.from({ length: fechadas }, (_, i) => `• ANTIGA${i}USDT RUNNER_ACTIVE → TP2_HIT a ${2000 + i} (vela de 21/10/2026 04:00)`),
    'Operações abertas depois da recuperação (todas, mexidas ou não): 7',
    'Sinais novos: 55',
  ].join('\n');

  it('texto curto passa intacto', () => {
    const t = make(2, 2);
    expect(clipSummaryForTelegram(t)).toBe(t);
  });

  it('texto longo: ≤ limite, mantém TODAS as linhas de contagem e avisa quantas linhas ficaram de fora', () => {
    const t = make(60, 60);
    expect(t.length).toBeGreaterThan(TELEGRAM_SUMMARY_MAX);
    const c = clipSummaryForTelegram(t);
    expect(c.length).toBeLessThanOrEqual(TELEGRAM_SUMMARY_MAX);
    for (const l of cabecalho) expect(c).toContain(l);
    expect(c).toContain('Operações novas (deveriam ter aberto na pausa): 60');
    expect(c).toContain('Operações antigas que mudaram de estado: 60');
    expect(c).toContain('Operações abertas depois da recuperação (todas, mexidas ou não): 7');
    expect(c).toContain('Sinais novos: 55');
    expect(c).toMatch(/• … e mais \d+ linha\(s\) — lista completa no relatório da execução/);
    // As primeiras linhas de detalhe ficam (prefixo), as últimas saem.
    expect(c).toContain('SIMBOLO0USDT');
    expect(c).not.toContain('SIMBOLO59USDT');
  });

  it('o número omitido bate: linhas mantidas + omitidas = total de detalhes', () => {
    const t = make(80, 0);
    const c = clipSummaryForTelegram(t);
    const mantidas = (c.match(/^• SIMBOLO/gm) ?? []).length;
    const omitidas = Number(/e mais (\d+) linha/.exec(c)[1]);
    expect(mantidas + omitidas).toBe(80);
  });

  it('sem linhas de detalhe, só um texto gigante: corta duro sem passar do limite', () => {
    const c = clipSummaryForTelegram('x'.repeat(9000));
    expect(c.length).toBeLessThanOrEqual(TELEGRAM_SUMMARY_MAX);
    expect(c).toMatch(/cortado/);
  });
});
