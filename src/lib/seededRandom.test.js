// docs/known-risks.md item 264 — a moeda da entrada aleatória precisa ser
// reproduzível, depender só da vela e ter a taxa e o equilíbrio de lados
// declarados. Tolerâncias: 4 desvios-padrão da binomial (falso alarme
// desprezível, e determinístico de qualquer forma).
import { describe, it, expect } from 'vitest';
import { mulberry32, hashString, randomEntryDecision } from './seededRandom.js';

const H4 = 4 * 60 * 60 * 1000;
const T0 = Date.parse('2024-01-01T00:00:00.000Z');
const candleTime = (i) => new Date(T0 + i * H4).toISOString();

describe('seededRandom', () => {
  it('mulberry32 e hashString são determinísticos', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(hashString('1|BTCUSDT|x')).toBe(hashString('1|BTCUSDT|x'));
    expect(hashString('1|BTCUSDT|x')).not.toBe(hashString('2|BTCUSDT|x'));
  });

  it('mesma (seed, símbolo, vela) → mesma decisão, chamada quantas vezes for (o cron reavalia a mesma vela)', () => {
    const args = { seed: 7, symbol: 'ETHUSDT', candleTime: candleTime(10), prob: 0.5 };
    const first = randomEntryDecision(args);
    for (let k = 0; k < 5; k += 1) expect(randomEntryDecision(args)).toBe(first);
  });

  it('taxa de disparo ≈ prob e lado ≈ 50% numa série longa', () => {
    const n = 200000;
    const prob = 0.0075;
    let fired = 0;
    let buys = 0;
    for (let i = 0; i < n; i += 1) {
      const d = randomEntryDecision({ seed: 1, symbol: 'BTCUSDT', candleTime: candleTime(i), prob });
      if (d) { fired += 1; if (d === 'BUY') buys += 1; }
    }
    const sdFired = Math.sqrt(n * prob * (1 - prob));
    expect(Math.abs(fired - n * prob)).toBeLessThan(4 * sdFired);
    expect(Math.abs(buys - fired / 2)).toBeLessThan(4 * Math.sqrt(fired / 4));
  });

  it('seeds e símbolos diferentes dão sequências diferentes', () => {
    const seq = (seed, symbol) => Array.from({ length: 2000 }, (_, i) =>
      randomEntryDecision({ seed, symbol, candleTime: candleTime(i), prob: 0.05 }));
    expect(seq(1, 'BTCUSDT')).not.toEqual(seq(2, 'BTCUSDT'));
    expect(seq(1, 'BTCUSDT')).not.toEqual(seq(1, 'ETHUSDT'));
  });

  it('prob ausente, zero ou negativa nunca dispara', () => {
    for (const prob of [0, -1, undefined, NaN]) {
      expect(randomEntryDecision({ seed: 1, symbol: 'BTCUSDT', candleTime: candleTime(1), prob })).toBeNull();
    }
  });
});
