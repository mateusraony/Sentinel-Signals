import { describe, it, expect } from 'vitest';
import { runQuickBacktest } from './quickBacktest';
import { goldenCandles } from './indicators/__fixtures__/candles.js';
import { isClosedOp } from './tradeMetrics';

const META = { symbol: 'BTCUSDT', timeframe: '4h' };

describe('runQuickBacktest', () => {
  it('rejeita candles insuficientes com erro claro', () => {
    expect(() => runQuickBacktest(goldenCandles(20), {}, META)).toThrow(/Candles insuficientes/);
  });

  it('produz operações fechadas em formato reaproveitável por tradeMetrics.js', () => {
    const candles = goldenCandles(500);
    const { ops, stillOpen } = runQuickBacktest(candles, {
      rfPeriod: 20, rfMult: 3.5, atrMult: 2, tp1R: 1.5, tp1QtyPercent: 50, minScore: 75, atrLen: 14,
    }, META);

    expect(Array.isArray(ops)).toBe(true);
    // Sanity real: sem isso, os asserts abaixo passariam trivialmente com
    // um array vazio e não provariam que a simulação realmente abre trade.
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(isClosedOp(op)).toBe(true);
      expect(['BUY', 'SELL']).toContain(op.side);
      expect(Number.isFinite(op.entry_price)).toBe(true);
      expect(Number.isFinite(op.initial_stop)).toBe(true);
      expect(Number.isFinite(op.exit_price)).toBe(true);
      expect(['STOP_HIT', 'TP2_HIT']).toContain(op.status);
      // Entradas em ordem cronológica não-decrescente (uma posição por vez).
    }
    for (let i = 1; i < ops.length; i++) {
      expect(new Date(ops[i].created_date).getTime()).toBeGreaterThanOrEqual(new Date(ops[i - 1].closed_at).getTime());
    }
    if (stillOpen) {
      expect(['BUY', 'SELL']).toContain(stillOpen.side);
    }
  });

  it('score mínimo mais alto nunca abre mais operações que um mais baixo (mesmo candles/parâmetros)', () => {
    const candles = goldenCandles(500);
    const base = { rfPeriod: 20, rfMult: 3.5, atrMult: 2, tp1R: 1.5, tp1QtyPercent: 50, atrLen: 14 };
    const lenient = runQuickBacktest(candles, { ...base, minScore: 50 }, META);
    const strict = runQuickBacktest(candles, { ...base, minScore: 95 }, META);
    expect(strict.ops.length).toBeLessThanOrEqual(lenient.ops.length);
  });
});

// ---- Auditoria do motor (22/11/2026): propriedades sobre MUITAS séries sintéticas, não só 1 caso. ----
function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function synth(n, seed, vol = 0.012) {
  const R = rng(seed); let p = 100; let drift = 0; const out = []; let t = 1700000000000;
  for (let i = 0; i < n; i++) {
    if (i % 60 === 0) drift = (R() - 0.5) * 0.006;
    const o = p; const c = o * (1 + drift + (R() - 0.5) * 2 * vol);
    out.push({ openTime: t, open: o, high: Math.max(o, c) * (1 + R() * vol * 0.6), low: Math.min(o, c) * (1 - R() * vol * 0.6), close: c, volume: 1000 + R() * 800, closeTime: t + 4 * 3600e3 - 1, isClosed: true });
    t += 4 * 3600e3; p = c;
  }
  return out;
}
const CFG = { rfPeriod: 20, rfMult: 3.5, atrMult: 2, tp1R: 1.5, tp1QtyPercent: 50, minScore: 60, atrLen: 14 };

describe('runQuickBacktest — invariantes (auditoria)', () => {
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1);

  it('níveis coerentes e saídas que TOCARAM de verdade a vela de saída; nenhuma operação fecha na vela de entrada', () => {
    let checked = 0;
    for (const seed of seeds) {
      const candles = synth(800, seed);
      const byClose = new Map(candles.map((c) => [c.closeTime, c]));
      const { ops } = runQuickBacktest(candles, CFG, META);
      for (const op of ops) {
        const buy = op.side === 'BUY';
        // ordem dos níveis
        if (buy) { expect(op.initial_stop).toBeLessThan(op.entry_price); expect(op.tp1).toBeGreaterThan(op.entry_price); }
        else { expect(op.initial_stop).toBeGreaterThan(op.entry_price); expect(op.tp1).toBeLessThan(op.entry_price); }
        // TP2 = 2x a distância do TP1 (mesma fórmula do scanner: tp1R * 2)
        expect(Math.abs(op.tp2 - op.entry_price)).toBeCloseTo(2 * Math.abs(op.tp1 - op.entry_price), 6);
        // saída em vela POSTERIOR à de entrada (sem candle retroativo)
        expect(op.closed_at).toBeGreaterThan(op.created_date);
        const exitCandle = byClose.get(op.closed_at);
        expect(exitCandle).toBeTruthy();
        // preço de saída coerente com o status
        if (op.status === 'TP2_HIT') { expect(op.exit_price).toBe(op.tp2); expect(buy ? exitCandle.high >= op.tp2 : exitCandle.low <= op.tp2).toBe(true); }
        else if (op.tp1_hit) { expect(op.exit_price).toBe(op.entry_price); expect(buy ? exitCandle.low <= op.entry_price : exitCandle.high >= op.entry_price).toBe(true); }
        else { expect(op.exit_price).toBe(op.initial_stop); expect(buy ? exitCandle.low <= op.initial_stop : exitCandle.high >= op.initial_stop).toBe(true); }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100); // não-vacuidade: a prova rodou sobre centenas de operações
  });

  it('uma posição por vez: toda entrada vem DEPOIS da saída anterior', () => {
    for (const seed of seeds.slice(0, 15)) {
      const { ops } = runQuickBacktest(synth(800, seed), CFG, META);
      for (let i = 1; i < ops.length; i++) expect(ops[i].created_date).toBeGreaterThanOrEqual(ops[i - 1].closed_at);
    }
  });

  it('SEM OLHAR O FUTURO: o que fechou até T é idêntico com a série inteira e com a série cortada em T', () => {
    let compared = 0;
    for (const seed of seeds.slice(0, 20)) {
      const candles = synth(800, seed);
      const cut = 560;
      const T = candles[cut - 1].closeTime;
      const full = runQuickBacktest(candles, CFG, META).ops.filter((o) => o.closed_at <= T);
      const part = runQuickBacktest(candles.slice(0, cut), CFG, META).ops;
      expect(part.map((o) => [o.created_date, o.closed_at, o.side, o.exit_price])).toEqual(full.map((o) => [o.created_date, o.closed_at, o.side, o.exit_price]));
      compared += full.length;
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('stats: todo sinal do Range Filter tem destino (aberto, barrado pelo score ou ignorado com posição aberta)', () => {
    for (const seed of seeds.slice(0, 15)) {
      const { ops, stillOpen, stats } = runQuickBacktest(synth(800, seed), CFG, META);
      expect(stats.signals).toBe(stats.taken + stats.rejectedByScore + stats.skippedWhileOpen);
      expect(stats.taken).toBe(ops.length + (stillOpen ? 1 : 0));
      expect(stats.startIndex).toBeGreaterThan(0);
      expect(stats.candlesTotal).toBe(800);
    }
  });

  it('REGRESSÃO: as EMAs do score são as do Pine (20/50), não 9/21 — e par inválido cai nos valores do Pine', () => {
    let differ = 0;
    for (const seed of seeds) {
      const c = synth(800, seed);
      const sig = (cfg) => JSON.stringify(runQuickBacktest(c, { ...CFG, ...cfg }, META).ops.map((o) => [o.created_date, o.closed_at]));
      if (sig({ emaFast: 9, emaSlow: 21 }) !== sig({})) differ += 1;
      expect(sig({ emaFast: 30, emaSlow: 20 })).toBe(sig({})); // rápida >= lenta: usa 20/50
      expect(sig({ emaFast: 20, emaSlow: 50 })).toBe(sig({})); // o padrão É 20/50
    }
    expect(differ).toBeGreaterThan(0); // 9/21 de fato muda o resultado: a correção importa
  });

  it('TP1 maior nunca cria operação nova: só muda os alvos (mesmas entradas até a 1ª saída)', () => {
    const c = synth(800, 7);
    const a = runQuickBacktest(c, { ...CFG, tp1R: 1.0 }, META).ops[0];
    const b = runQuickBacktest(c, { ...CFG, tp1R: 2.5 }, META).ops[0];
    expect(a.created_date).toBe(b.created_date);
    expect(a.initial_stop).toBe(b.initial_stop);
  });
});
