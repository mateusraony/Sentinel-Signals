// docs/known-risks.md item 281 — `targetMode` (BACKTEST-ONLY) no replay
// INTEIRO, contra o scanAsset/persistScanResults reais e o backend falso.
// Mesmo harness do bloco da Fibonacci 15m em backtestEngine.test.js (entrada
// aleatória para gerar muitas operações sem depender da RF). Prova:
// - chave ausente e 'r_multiple' dão operações idênticas, sem campo novo
//   (a produção não muda);
// - nos braços estruturais, entrada e stop são os do controle e só TP1/TP2
//   mudam, com os níveis que structuralTargets.js calcula das mesmas velas;
// - alvo inválido cai exatamente no alvo do controle (1,5R/3R);
// - o replay é determinístico.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFakeBackend } from './__fixtures__/fakeBackend.js';

vi.mock('@/api/entities', () => ({ backend: {} }));
vi.mock('./telegram', () => ({
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
vi.mock('./logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock('./marketDataProvider', () => ({
  fetchCandles: vi.fn(),
  fetchCurrentPrice: vi.fn(),
  MARKET_SOURCE: 'futures',
  DATA_EXCHANGE: 'binance',
  EXECUTOR: 'browser',
}));
vi.mock('./pineParser', () => ({
  getPineConfig: vi.fn(),
  getPineConfigStatus: vi.fn(() => ({ source: 'postgres', version: null, hash: null, degraded: false })),
}));

import * as entitiesModule from '@/api/entities';
import { fetchCandles } from './marketDataProvider';
import { getPineConfig } from './pineParser';
import { restoreClock, simNow, sliceClosedAsOf, runBacktest } from './backtestEngine.js';
import { TARGET_RULES, fibLevels, swingLevels, resolveTarget } from './indicators/structuralTargets.js';

afterEach(() => restoreClock());

const M15 = 15 * 60 * 1000;
const START = new Date('2026-01-01T00:00:00.000Z').getTime();
const N15 = 40 * 96;
const FROM = START + 30 * 24 * 60 * 60 * 1000;
const TO = START + 40 * 24 * 60 * 60 * 1000 - 1;

function series15m() {
  let a = 12345;
  const rand = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let price = 100;
  const out = [];
  for (let i = 0; i < N15; i += 1) {
    const open = price;
    price *= Math.exp(0.004 * Math.sin(i / 40) + (rand() - 0.5) * 0.012);
    const close = price;
    const high = Math.max(open, close) * (1 + rand() * 0.003);
    const low = Math.min(open, close) * (1 - rand() * 0.003);
    out.push({ openTime: START + i * M15, closeTime: START + (i + 1) * M15 - 1, open, high, low, close, volume: 100 });
  }
  return out;
}
function aggregate4h(c15) {
  const out = [];
  for (let i = 0; i + 16 <= c15.length; i += 16) {
    const g = c15.slice(i, i + 16);
    out.push({ openTime: g[0].openTime, closeTime: g[15].closeTime, open: g[0].open, close: g[15].close,
      high: Math.max(...g.map((c) => c.high)), low: Math.min(...g.map((c) => c.low)), volume: 1600 });
  }
  return out;
}
const C15 = series15m();
const C4H = aggregate4h(C15);

const makeAsset = () => ({
  id: 'asset1', symbol: 'TESTUSDT', is_active: true, smc_enabled: false, smc_confirm_4h15m: false,
  timeframes_enabled: { '1h': false, '4h': true, '1d': false }, rf_period: 20, rf_multiplier: 3.5,
});

async function run(extra = {}, { failWhen = null } = {}) {
  const pineConfig = {
    minScore: 0, tp1R: 1.5, tp1QtyPercent: 50, trailAtrMult: 2.0,
    useADX: false, useChop: false, useTimeStop: true, useChopExit: false, useInvalidation: false, invalidRFBars: 2,
    randomEntryEnabled: true, randomEntrySeed: 7, randomEntryProb: 0.5, skip15mConfirmationEnabled: true,
    ...extra,
  };
  getPineConfig.mockResolvedValue(pineConfig);
  fetchCandles.mockImplementation(async (sym, tf, limit) => {
    if (failWhen?.(tf, limit)) throw new Error(`fetch falhou (${tf}, ${limit})`);
    return sliceClosedAsOf(tf === '4h' ? C4H : tf === '15m' ? C15 : [], simNow(), limit);
  });
  const backend = createFakeBackend();
  Object.assign(entitiesModule.backend, backend);
  const report = await runBacktest({ assets: [makeAsset()], backend, fromMs: FROM, toMs: TO, stepMs: M15, pineConfig });
  const ops = structuredClone(await backend.entities.TradeOperation.filter({}));
  const signals = structuredClone(await backend.entities.SignalEvent.filter({}));
  return { ops, signals, report };
}

const controlTargets = (op) => {
  const risk = Math.abs(op.entry_price - op.initial_stop);
  const sign = op.side === 'BUY' ? 1 : -1;
  return { tp1: op.entry_price + sign * 1.5 * risk, tp2: op.entry_price + sign * 3 * risk };
};
const NEW_FIELDS = ['target_mode', 'target_near_policy', 'target_basis', 'target_fallback_reason', 'rr_at_entry_target', 'target_first_level_r'];

describe('runBacktest — alvo estrutural (targetMode, item 281)', () => {
  it("chave ausente = 'r_multiple': operações idênticas e nenhum campo novo", async () => {
    const off = await run();
    const explicit = await run({ targetMode: 'r_multiple' });
    expect(off.ops.length).toBeGreaterThan(0);
    expect(explicit.ops).toEqual(off.ops);
    for (const op of off.ops) for (const f of NEW_FIELDS) expect(op[f], f).toBeUndefined();
  }, 60000);

  const ARMS = [['fib_ext_15m', 'FIB_EXT_15M'], ['swing_4h', 'SWING_4H']]
    .flatMap(([mode, basis]) => TARGET_RULES.nearPolicies.map((policy) => [mode, basis, policy]));
  for (const [mode, basis, policy] of ARMS) {
    it(`${mode}/${policy}: mesma entrada e stop, só TP1/TP2 mudam, pelos níveis das mesmas velas`, async () => {
      const control = await run();
      const arm = await run({ targetMode: mode, targetNearPolicy: policy });
      const controlById = new Map(control.ops.map((op) => [op.id, op]));
      const signalByKey = new Map(arm.signals.map((s) => [s.dedup_key, s]));
      let structural = 0;
      let shared = 0;
      for (const op of arm.ops) {
        expect(op.target_mode).toBe(mode);
        expect(op.target_near_policy).toBe(policy);
        // O que o gate R:R mediu (alvo do controle) continua descrito igual.
        expect(op.rr_target_basis).toBe('R_MULTIPLE');
        expect(op.rr_at_entry).toBeCloseTo(1.5, 9);
        expect([basis, 'R_MULTIPLE_FALLBACK']).toContain(op.target_basis);
        const same = controlById.get(op.id);
        if (same) {
          shared += 1;
          expect(op.entry_price).toBe(same.entry_price);
          expect(op.initial_stop).toBe(same.initial_stop);
        }
        if (op.target_basis === 'R_MULTIPLE_FALLBACK') {
          expect(op.target_fallback_reason).toEqual(expect.any(String));
          const ref = controlTargets(op);
          expect(op.tp1).toBeCloseTo(ref.tp1, 9);
          expect(op.tp2).toBeCloseTo(ref.tp2, 9);
          continue;
        }
        structural += 1;
        const sign = op.side === 'BUY' ? 1 : -1;
        expect((op.tp1 - op.entry_price) * sign).toBeGreaterThan(0);
        expect((op.tp2 - op.tp1) * sign).toBeGreaterThan(0);
        if (policy !== 'literal') expect(op.rr_at_entry_target).toBeGreaterThanOrEqual(TARGET_RULES.minTargetR - 1e-9);
        // Recalcula das mesmas velas, no mesmo instante: o motor não inventa nível.
        const sig = signalByKey.get(op.id.replace(/^trade_/, ''));
        const nowMs = new Date(op.created_date).getTime();
        const candidate = mode === 'fib_ext_15m'
          ? fibLevels({ candles15m: C15, direction: op.side, signalCloseMs: new Date(sig.candle_time).getTime() })
          : swingLevels({ candles4h: sliceClosedAsOf(C4H, nowMs, TARGET_RULES.swingFetch4h), direction: op.side, nowMs });
        const expected = resolveTarget({ mode, policy, direction: op.side, entry: op.entry_price, stop: op.initial_stop, candidate });
        expect(op.tp1).toBeCloseTo(expected.tp1, 9);
        expect(op.tp2).toBeCloseTo(expected.tp2, 9);
      }
      // Não-vacuidade: o braço mexe no alvo de verdade. No min_r_fallback, com
      // o stop largo do 4h, a Fibonacci sintética cai toda no controle (o
      // achado que motivou as três políticas) — ali basta a regra ter agido.
      const belowMin = arm.ops.filter((op) => op.target_fallback_reason === 'target_below_min_r').length;
      expect(policy === 'min_r_fallback' ? structural + belowMin : structural).toBeGreaterThan(0);
      expect(shared).toBeGreaterThan(0);
      expect(arm.ops.some((op) => ['STOP_HIT', 'TP2_HIT', 'CLOSED'].includes(op.status))).toBe(true);
      const again = await run({ targetMode: mode, targetNearPolicy: policy });
      expect(again.ops).toEqual(arm.ops);
    }, 120000);
  }

  it('falha ao buscar as velas do alvo invalida o replay, nunca vira fallback em silêncio', async () => {
    // Só a busca do alvo pede 200 velas de 15m (TARGET_RULES.fibFetch15m).
    const failTargetFetch = (tf, limit) => tf === '15m' && limit === TARGET_RULES.fibFetch15m;
    const bad = await run({ targetMode: 'fib_ext_15m', targetNearPolicy: 'literal' }, { failWhen: failTargetFetch });
    expect(bad.ops).toEqual([]);
    expect(bad.report.dataIntegrity.valid).toBe(false);
    // Topo 4h: só a busca do alvo pede 160 velas de 4h (TARGET_RULES.swingFetch4h).
    const badSwing = await run({ targetMode: 'swing_4h', targetNearPolicy: 'literal' }, { failWhen: (tf, limit) => tf === '4h' && limit === TARGET_RULES.swingFetch4h });
    expect(badSwing.ops).toEqual([]);
    expect(badSwing.report.dataIntegrity.valid).toBe(false);
  }, 60000);

  // O replay registra a falha e invalida o relatório (nenhuma operação nasce
  // com alvo errado); run-backtest.mjs recusa o valor antes, em
  // setPineConfigOverrides.
  it('valor inválido invalida o replay em vez de abrir operação com alvo errado', async () => {
    for (const extra of [{ targetMode: 'topo', targetNearPolicy: 'literal' }, { targetMode: 'swing_4h', targetNearPolicy: 'perto' }]) {
      const bad = await run(extra);
      expect(bad.ops).toEqual([]);
      expect(bad.report.dataIntegrity.valid).toBe(false);
    }
  }, 60000);
});
