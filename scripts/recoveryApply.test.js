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
import { runApply, formatApplyMarkdown, formatOutOfScopeLine, diffEvents, LOCK_NAMES } from './recoveryApply.mjs';
import { findOutOfScopeOpenOps } from './recoveryDryRun.mjs';

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

async function preloadAll(assets = [ASSET]) {
  clearSeries();
  for (const a of assets) {
    for (const tf of RECOVERY_TIMEFRAMES) await preloadSeries(a.symbol, tf, START_4H - 400 * TIMEFRAME_MS['1d'], TO + 2 * FOUR_H, fetchSeries);
  }
}

// "Banco ao vivo" depois de o scan rodar até `untilMs` (o último scan antes da queda).
async function liveDb(untilMs, assets = [ASSET]) {
  getPineConfig.mockResolvedValue(CFG);
  await preloadAll(assets);
  const live = createFakeBackend();
  Object.assign(entitiesModule.backend, live);
  for (const a of assets) live._seed('MonitoredAsset', { ...a });
  live._seed('StrategyConfig', { id: 'current', tp1R: 1.5 });
  await runBacktest({ assets, backend: live, fromMs: FROM, toMs: untilMs, stepMs: FIFTEEN_M, pineConfig: CFG });
  for (const a of assets) await live.entities.MonitoredAsset.update(a.id, { last_scan_at: iso(untilMs) });
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

describe('achados do Codex no PR #524', () => {
  it('banco mexido ENTRE a 1ª conferência e os locks → para sem gravar nada da recuperação', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const [op] = await live.entities.TradeOperation.list();
    // Um scan do navegador grava e solta o lock bem na hora em que a recuperação pega os locks.
    let mexeu = false;
    live.locks.acquireScanLock = async () => {
      if (!mexeu) { mexeu = true; await live.entities.TradeOperation.update(op.id, { mfe_r: 9.99 }); }
      return true;
    };
    const before = byId(await live.entities.TradeOperation.list());
    const { deps: d, sent } = applyDeps(live, approved);
    const out = await runApply(d);
    expect(out).toMatchObject({ ok: false, code: 'snapshot_changed', wrote: false });
    // Só a escrita do "scan" (mfe_r); nenhuma escrita da recuperação.
    const onlyScan = before.map((o) => (o.id === op.id ? { ...o, mfe_r: 9.99 } : o));
    expect(byId(await live.entities.TradeOperation.list())).toEqual(onlyScan);
    expect(sent[0]).toMatch(/nada foi gravado/);
  }, 180000);

  it('sinal tocado fora dos 5.000 mais recentes não vira falsa "parou no meio" (lido pelo id)', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    // Depois de gravar, a leitura "dos mais recentes" não traz os sinais novos (simula a janela de 5.000);
    // a conferência precisa buscá-los pelo id.
    const sig = live.entities.SignalEvent;
    const rawList = sig.list;
    let gravando = false;
    const realTransition = live.tradeOps.transitionTradeOp;
    live.tradeOps.transitionTradeOp = async (...a) => { gravando = true; return realTransition(...a); };
    sig.list = async (...a) => (gravando && a.length ? [] : rawList(...a));
    sig.get = async (id) => (await rawList()).find((r) => r.id === id) ?? null;
    const out = await runApply(applyDeps(live, approved).deps);
    expect(out.ok).toBe(true);
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

// ───────────────────────────────────────────────────────────────────────────────────────────────
// PR-10 (auditoria de 31/10): blindagem do modo aplicar. Cada teste abaixo reproduz um defeito
// achado na auditoria; a prova por mutação de cada um está descrita no PR.
// ───────────────────────────────────────────────────────────────────────────────────────────────
const ASSET2 = { ...ASSET, id: 'asset2', symbol: 'TEST2USDT' };

describe('M1 — tempo da aplicação', () => {
  it('prazo acabando: para ENTRE ativos, confere só os concluídos e diz "parcial" (cursor só dos concluídos)', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M, [ASSET, ASSET2]);
    const approved = await approve(live);
    const before = byId(await live.entities.TradeOperation.list());
    // Relógio controlado: cada cursor gravado "gasta" 600 ms; prazo em 1500 → o 2º ativo não cabe.
    let t = 1000;
    const realUpdate = live.entities.MonitoredAsset.update;
    live.entities.MonitoredAsset.update = async (id, patch, ...r) => {
      if (patch.recovery_replayed_to) t += 600;
      return realUpdate(id, patch, ...r);
    };
    const { deps: d, sent } = applyDeps(live, approved, { clock: () => t, deadlineMs: 1500 });
    const out = await runApply(d);

    expect(out).toMatchObject({ ok: true, partial: true, pending: ['TEST2USDT'] });
    const assets = byId(await live.entities.MonitoredAsset.list());
    expect(assets.find((a) => a.id === 'asset1').recovery_replayed_to).toBe(new Date(TO).toISOString());
    expect(assets.find((a) => a.id === 'asset2').recovery_replayed_to).toBeUndefined();
    // Nada do 2º ativo foi tocado.
    const after = byId(await live.entities.TradeOperation.list());
    expect(after.filter((o) => o.asset_id === 'asset2')).toEqual(before.filter((o) => o.asset_id === 'asset2'));
    expect(after.some((o) => o.asset_id === 'asset1' && o.source === 'recovery')).toBe(true);
    // Mensagem única, avisando que falta ativo e que NÃO se religa o scan.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/PARCIAL/);
    expect(sent[0]).toMatch(/TEST2USDT/);
    expect(sent[0]).toMatch(/NÃO religue o scan/);
    expect(formatApplyMarkdown(out)).toMatch(/APLICADA PARCIALMENTE/);
    expect(formatApplyMarkdown(out)).toMatch(/NÃO religue o scan ainda/);

    // Um novo teste a seco recomeça só do que faltou.
    const second = JSON.parse(JSON.stringify(await runDryRun(deps(live, { nowMs: TO + 7 * 60 * 1000 }))));
    expect(second.assets.find((a) => a.symbol === 'TESTUSDT').skipped).toBe(true);
    expect(second.assets.find((a) => a.symbol === 'TEST2USDT').ticks).toBeGreaterThan(0);
  }, 180000);

  it('sem prazo apertado, os dois ativos são aplicados (parcial é só quando o tempo acaba)', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M, [ASSET, ASSET2]);
    const approved = await approve(live);
    const out = await runApply(applyDeps(live, approved).deps);
    expect(out).toMatchObject({ ok: true, partial: false, pending: [] });
  }, 180000);

  it('tempo máximo estourado ANTES de gravar: mensagem própria, nada gravado, 1 mensagem', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const before = byId(await live.entities.TradeOperation.list());
    const { deps: d, sent } = applyDeps(live, approved, { fetchSeries: () => new Promise(() => {}), timeoutMs: 50 });
    const out = await runApply(d);
    expect(out).toMatchObject({ ok: false, code: 'apply_timeout', wrote: false });
    expect(byId(await live.entities.TradeOperation.list())).toEqual(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/ANTES de gravar/);
    expect(sent[0]).toMatch(/Nada foi gravado/);
    expect(formatApplyMarkdown(out)).toMatch(/NÃO APLICADA \(tempo esgotado\)/);
  }, 180000);

  it('tempo máximo estourado NO MEIO de um ativo: manda NÃO rodar de novo, nomeia o ativo e gera relatório', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    // O cursor do ativo trava (rede presa): o replay já gravou operações, mas não termina.
    live.entities.MonitoredAsset.update = () => new Promise(() => {});
    const { deps: d, sent } = applyDeps(live, approved, { timeoutMs: 400 });
    const out = await runApply(d);
    expect(out).toMatchObject({ ok: false, code: 'apply_timeout', wrote: true });
    expect(out.summary).toMatch(/TEMPO ESGOTOU no meio/);
    expect(out.summary).toMatch(/NÃO rode de novo/);
    expect(out.summary).toMatch(/NÃO religue o scan/);
    expect(out.error.message).toMatch(/TESTUSDT/);
    expect(sent).toHaveLength(1);
    expect(formatApplyMarkdown(out)).toMatch(/TEMPO ESGOTADO NO MEIO/);
  }, 180000);
});

describe('pequenos defeitos do aplicar', () => {
  it('lock: erro de rede na 2ª trava solta a 1ª (não deixa presa por 40 min)', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const calls = [];
    live.locks.acquireScanLock = async (name, ttl, holder) => {
      calls.push(['acquire', name]);
      if (name === 'price-check') throw new Error('rede caiu');
      return true;
    };
    live.locks.releaseScanLock = async (name) => { calls.push(['release', name]); };
    const out = await runApply(applyDeps(live, approved).deps);
    expect(out).toMatchObject({ ok: false, wrote: false });
    expect(out.error.message).toBe('rede caiu');
    expect(calls).toContainEqual(['release', 'full-scan']);
  }, 180000);

  it('API do GitHub fora do ar NÃO vira "desative o scan": mensagem com a causa certa', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const out = await runApply(applyDeps(live, approved, { workflows: [], workflowsError: 'API do GitHub respondeu 502 ao listar workflows' }).deps);
    expect(out).toMatchObject({ ok: false, code: 'github_api', wrote: false });
    expect(out.summary).toMatch(/não consegui conferir/);
    expect(out.summary).toMatch(/502/);
    expect(out.summary).not.toMatch(/desative/i);
  }, 180000);

  it('"parou no meio" só quando houve escrita: trava perdida logo no início diz "nada foi gravado"', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    // Pega as duas travas e perde na renovação do 1º ativo — antes de qualquer escrita.
    let n = 0;
    live.locks.acquireScanLock = async () => { n += 1; return n <= LOCK_NAMES.length; };
    live.locks.releaseScanLock = async () => {};
    const before = byId(await live.entities.TradeOperation.list());
    const out = await runApply(applyDeps(live, approved).deps);
    expect(out).toMatchObject({ ok: false, code: 'lock_lost', wrote: false });
    expect(out.summary).toMatch(/nada foi gravado/);
    expect(out.summary).not.toMatch(/NO MEIO/);
    expect(byId(await live.entities.TradeOperation.list())).toEqual(before);
  }, 180000);

  it('só a etiqueta falhou: banco gravado e CONFERIDO — mensagem própria (não "parou no meio")', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const realUpdate = live.entities.TradeOperation.update;
    live.entities.TradeOperation.update = async (id, patch, ...r) => {
      if ('recovery_run_id' in patch) throw new Error('rede caiu na etiqueta');
      return realUpdate(id, patch, ...r);
    };
    const { deps: d, sent } = applyDeps(live, approved);
    const out = await runApply(d);
    expect(out).toMatchObject({ ok: false, code: 'tag_failed', wrote: true });
    expect(out.summary).toMatch(/GRAVADA e CONFERIDA/);
    expect(out.summary).toMatch(/Os dados estão certos/);
    expect(out.summary).toMatch(/NÃO religue o scan/);
    expect(out.summary).not.toMatch(/parou NO MEIO/);
    expect(sent).toHaveLength(1);
    expect(formatApplyMarkdown(out)).toMatch(/GRAVADA E CONFERIDA, FALTA ETIQUETAR/);
  }, 180000);

  it('divergência: operação que existe SÓ no banco real também é contada', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const real = live.tradeOps.transitionTradeOp;
    live.tradeOps.transitionTradeOp = async (...a) => {
      const out = await real(...a);
      // Algo (um scan do painel) cria uma operação durante a aplicação.
      await live.entities.TradeOperation.create({ symbol: 'EXTRAUSDT', asset_id: 'asset1', status: 'CLOSED', side: 'BUY' });
      return out;
    };
    const out = await runApply(applyDeps(live, approved).deps);
    expect(out).toMatchObject({ ok: false, code: 'verify_mismatch', wrote: true });
    expect(out.error.message).toMatch(/[1-9]\d* operação\(ões\)/); // antes: "0 operação(ões)"
    expect(out.error.details.diverge.length).toBeGreaterThan(0);
  }, 180000);

  it('relatório de sucesso manda religar os TRÊS (Scheduled scan, cron-job.org, Backfill check)', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const out = await runApply(applyDeps(live, approved).deps);
    const md = formatApplyMarkdown(out);
    expect(md).toMatch(/Scheduled scan/);
    expect(md).toMatch(/cron-job\.org/);
    expect(md).toMatch(/Backfill check/);
    expect(md).toMatch(/não são reprocessadas/);
  }, 180000);

  it('Telegram que não enviou: o relatório não culpa só os segredos', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    const out = await runApply(applyDeps(live, approved, { sendSummary: async () => false }).deps);
    expect(out.ok).toBe(true);
    const md = formatApplyMarkdown(out);
    expect(md).toMatch(/NÃO enviada/);
    expect(md).toMatch(/rede ou recusa do Telegram/);
    expect(md).not.toMatch(/\(confira os segredos do Telegram\)/);
  }, 180000);
});

describe('M3 — mensagem do Telegram cabe no limite', () => {
  it('resumo enorme é cortado em ≤ 3.800 caracteres; o relatório completo continua inteiro', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    const approved = await approve(live);
    // Falha com uma causa gigante (a mesma classe de texto longo que a lista de operações geraria).
    const longa = 'x'.repeat(9000);
    const { deps: d, sent } = applyDeps(live, approved, { workflows: [], workflowsError: longa });
    const out = await runApply(d);
    expect(out.summary.length).toBeGreaterThan(8000);
    expect(sent).toHaveLength(1);
    expect(sent[0].length).toBeLessThanOrEqual(3800);
  }, 180000);
});

describe('operações abertas que ficam fora da recuperação', () => {
  const snap = {
    MonitoredAsset: [
      { id: 'on', symbol: 'ONUSDT', is_active: true },
      { id: 'off', symbol: 'OFFUSDT', is_active: false },
      { id: 'pend', symbol: 'PENDUSDT', is_active: true, backfill_check_status: 'pending' },
    ],
    TradeOperation: [
      { id: 'o1', asset_id: 'on', symbol: 'ONUSDT', status: 'RUNNER_ACTIVE' },
      { id: 'o2', asset_id: 'off', symbol: 'OFFUSDT', status: 'SIGNAL_CONFIRMED' },
      { id: 'o3', asset_id: 'pend', symbol: 'PENDUSDT', status: 'RUNNER_ACTIVE' },
      { id: 'o4', asset_id: 'off', symbol: 'OFFUSDT', status: 'STOP_HIT' },
    ],
  };

  it('lista só as ABERTAS de ativo desativado ou com checagem retroativa pendente, com o motivo', () => {
    const list = findOutOfScopeOpenOps(snap, [snap.MonitoredAsset[0]]);
    expect(list).toEqual([
      { id: 'o2', symbol: 'OFFUSDT', status: 'SIGNAL_CONFIRMED', reason: 'ativo desativado' },
      { id: 'o3', symbol: 'PENDUSDT', status: 'RUNNER_ACTIVE', reason: 'checagem retroativa pendente' },
    ]);
  });

  it('vira uma linha de aviso (e nada quando não há)', () => {
    const list = findOutOfScopeOpenOps(snap, [snap.MonitoredAsset[0]]);
    expect(formatOutOfScopeLine(list)).toMatch(/2 operação\(ões\) ABERTA\(S\) ficaram FORA/);
    expect(formatOutOfScopeLine(list)).toMatch(/OFFUSDT SIGNAL_CONFIRMED \(ativo desativado\)/);
    expect(formatOutOfScopeLine([])).toBeNull();
  });

  it('ponta a ponta: o teste a seco avisa e o resumo da aplicação traz a linha', async () => {
    const live = await liveDb(FLIP + FIFTEEN_M);
    live._seed('MonitoredAsset', { id: 'dead', symbol: 'DEADUSDT', is_active: false, created_date: iso(START_4H) });
    live._seed('TradeOperation', { id: 'op_dead', asset_id: 'dead', symbol: 'DEADUSDT', status: 'RUNNER_ACTIVE', side: 'BUY', created_date: iso(START_4H) });
    const approved = await approve(live);
    expect(approved.outOfScopeOpen).toEqual([{ id: 'op_dead', symbol: 'DEADUSDT', status: 'RUNNER_ACTIVE', reason: 'ativo desativado' }]);
    const out = await runApply(applyDeps(live, approved).deps);
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/ATENÇÃO — 1 operação\(ões\) ABERTA\(S\) ficaram FORA/);
    expect(out.summary).toMatch(/DEADUSDT/);
  }, 180000);
});
