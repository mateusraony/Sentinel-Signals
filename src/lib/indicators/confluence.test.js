import { describe, it, expect } from 'vitest';
import { calculateSignalStrength } from './confluence.js';

function baseArgs(overrides = {}) {
  return {
    rfResult: { signal: 'BUY', direction: 1 },
    rsiResult: { crossedBull50: false, crossedBear50: false },
    macdResult: { histogram: 0 },
    emaResult: { trend: 'neutral' },
    alignmentResult: {},
    timeframe: '4h',
    volumeData: null,
    minScore: 75,
    confirmed: null,
    rsiOnlyGateEnabled: false,
    ...overrides,
  };
}

function run(o) {
  const a = baseArgs(o);
  return calculateSignalStrength(a.rfResult, a.rsiResult, a.macdResult, a.emaResult, a.alignmentResult, a.timeframe, a.volumeData, a.minScore, a.confirmed, a.rsiOnlyGateEnabled);
}

// confirmBars feature: calculateSignalStrength's optional 9th param
// (`confirmed`, from rangeFilterConfirmation.js) must let the confirmBars-
// aware signal/follow-through override the raw rfResult ones — same Pine
// mechanism (buyFollowThrough) driving both the +25 score and the entry
// gate in scanner.js.
describe('calculateSignalStrength — legado (confirmed=null, todo chamador existente)', () => {
  it('deriva isBuy/followThrough do rfResult bruto quando confirmed não é passado', () => {
    const r = run({ rfResult: { signal: 'BUY', direction: 1 } });
    expect(r.reasons).toContain('Follow-through confirmado (+25)');
    expect(r.score).toBeGreaterThanOrEqual(25);
  });

  it('sem sinal bruto (NONE), nenhum lado conta como BUY/SELL', () => {
    const r = run({ rfResult: { signal: 'NONE', direction: 1 } });
    expect(r.reasons).not.toContain('Follow-through confirmado (+25)');
  });
});

describe('calculateSignalStrength — confirmBars (confirmed presente)', () => {
  it('usa confirmed.confirmedSignal em vez de rfResult.signal para decidir isBuy/isSell', () => {
    // Sinal bruto ainda não é BUY nesta barra (confirmBars>1 atrasa o flip),
    // mas o gate confirmado já disparou — o score deve tratar como BUY.
    const r = run({
      rfResult: { signal: 'NONE', direction: 1 },
      confirmed: { confirmedSignal: 'BUY', buyFollowThrough: true, sellFollowThrough: false, freshBuy: true, freshSell: false },
    });
    expect(r.reasons).toContain('Follow-through confirmado (+25)');
  });

  it('usa buyFollowThrough/sellFollowThrough da janela confirmBars, não o proxy de 1 barra', () => {
    // confirmedSignal fresh, mas a janela de confirmBars teve whipsaw —
    // buyFollowThrough vem false mesmo com rfResult.direction===1.
    const r = run({
      rfResult: { signal: 'BUY', direction: 1 },
      confirmed: { confirmedSignal: 'BUY', buyFollowThrough: false, sellFollowThrough: false, freshBuy: true, freshSell: false },
    });
    expect(r.reasons).not.toContain('Follow-through confirmado (+25)');
    // "Preço acima do filtro (+10)" ainda usa rfResult.direction diretamente
    // (não faz parte do mecanismo buyFollowThrough) — continua contando.
    expect(r.reasons).toContain('Preço acima do filtro (+10)');
  });

  it('confirmedSignal NONE: nem BUY nem SELL contam, mesmo com rfResult.signal bruto preenchido', () => {
    const r = run({
      rfResult: { signal: 'BUY', direction: 1 },
      confirmed: { confirmedSignal: 'NONE', buyFollowThrough: false, sellFollowThrough: false, freshBuy: false, freshSell: false },
    });
    expect(r.reasons).not.toContain('Follow-through confirmado (+25)');
    expect(r.reasons).not.toContain('Preço acima do filtro (+10)');
  });
});

// docs/known-risks.md item 111 — rsiOnlyGateEnabled substitui o gate de
// score pelo cruzamento de RSI sozinho. `score`/`strength`/`priority`
// continuam calculados normalmente (display/Telegram) — só `passed` muda.
describe('calculateSignalStrength — rsiOnlyGateEnabled (item 111, backtest-only)', () => {
  it('default (false) é byte-idêntico ao gate de score de sempre', () => {
    const r = run({ rsiResult: { crossedBull50: false, crossedBear50: false }, minScore: 0 });
    // score>=minScore(0) passaria pelo gate de score — mas sem
    // rsiOnlyGateEnabled o resultado não muda o comportamento default,
    // continua usando `passed = score >= minScore`.
    expect(r.passed).toBe(true);
  });

  it('RSI concorda (BUY) com score baixo (reprovaria no gate normal): passa', () => {
    const r = run({
      rfResult: { signal: 'BUY', direction: -1 }, // nega "Preço acima do filtro (+10)"
      macdResult: { histogram: -1 }, // nega MACD (+20)
      emaResult: { trend: 'bearish' }, // nega EMA (+20)
      rsiResult: { crossedBull50: true, crossedBear50: false },
      minScore: 75,
      rsiOnlyGateEnabled: true,
    });
    expect(r.score).toBeLessThan(75); // confirma que reprovaria no gate normal
    expect(r.passed).toBe(true); // mas passa — só RSI decide
  });

  it('RSI discorda (BUY) com score alto (passaria no gate normal): reprova', () => {
    const r = run({
      rfResult: { signal: 'BUY', direction: 1 },
      macdResult: { histogram: 1 },
      emaResult: { trend: 'bullish' },
      volumeData: { current: 10, ma: 5 },
      rsiResult: { crossedBull50: false, crossedBear50: false },
      minScore: 75,
      rsiOnlyGateEnabled: true,
    });
    expect(r.score).toBeGreaterThanOrEqual(75); // confirma que passaria no gate normal
    expect(r.passed).toBe(false); // mas reprova — RSI não concordou
  });

  it('SELL usa crossedBear50, não crossedBull50', () => {
    const r = run({
      rfResult: { signal: 'SELL', direction: -1 },
      confirmed: { confirmedSignal: 'SELL', buyFollowThrough: false, sellFollowThrough: true, freshBuy: false, freshSell: true },
      rsiResult: { crossedBull50: false, crossedBear50: true },
      rsiOnlyGateEnabled: true,
    });
    expect(r.passed).toBe(true);
  });

  it('sem BUY nem SELL confirmado, falha fechado mesmo com rsiOnlyGateEnabled', () => {
    const r = run({
      rfResult: { signal: 'NONE', direction: 0 },
      rsiResult: { crossedBull50: true, crossedBear50: true },
      rsiOnlyGateEnabled: true,
    });
    expect(r.passed).toBe(false);
  });
});
