// Cobre a lógica pura de veredito de scripts/analyze-shadow-rf1h.mjs
// (buildShadowComparison) — não precisa de Firestore: recebe os grupos de
// TradeOperation já separados por cascade (o mesmo shape que main() monta
// depois de ler experimentalRf1hShadowTradeOperations). O que importa testar
// aqui é o limiar/veredito em si (amostra mínima, alvo, correção de
// Bonferroni só na cascata experimental) — summarizeOps/expectancyCIAtZ já
// têm cobertura própria em tradeMetrics.test.js.
import { describe, it, expect } from 'vitest';
import { buildShadowComparison } from './analyze-shadow-rf1h.mjs';

function makeOp(id, overrides = {}) {
  return {
    id,
    side: 'BUY',
    status: 'STOP_HIT',
    entry_price: 100,
    initial_stop: 95,
    current_stop: 95,
    tp1: 107.5,
    tp2: 115,
    tp1_hit: false,
    partial_percent: 50,
    runner_percent: 50,
    closed_at: '2026-07-16T12:00:00.000Z',
    created_date: '2026-07-16T08:00:00.000Z',
    ...overrides,
  };
}

// ~+2.25R gross (TP2, half at TP1) — big enough to stay clearly positive
// even after real costs (fee/slippage/funding, the project's default cost
// model, docs/known-risks.md item 44), so the fixtures below don't need to
// hand-tune bps to get a deterministic verdict.
function bigWin(id, overrides = {}) {
  return makeOp(id, { status: 'TP2_HIT', tp1_hit: true, exit_price: 115, ...overrides });
}
// +1R gross (full position, no partial) — same magnitude as unitLoss below,
// used where the test needs win/loss to roughly cancel out (mean near zero)
// instead of bigWin's asymmetric +2.25R skewing the sample positive.
function unitWin(id) {
  return makeOp(id, { exit_price: 105 });
}
// -1R gross, same reasoning in the opposite direction.
function bigLoss(id) {
  return makeOp(id, { exit_price: 95 });
}

describe('buildShadowComparison', () => {
  it('sample below the floor (0 ops) -> INCONCLUSIVO, no Bonferroni CI computed', () => {
    const result = buildShadowComparison({ rf1h_cond4h_15m: [], '4h_15m': [] });
    expect(result.rf1h_cond4h_15m.total).toBe(0);
    expect(result.rf1h_cond4h_15m.verdict).toBe('INCONCLUSIVO (amostra < mínimo)');
    expect(result.rf1h_cond4h_15m.bonferroniCI).toBeNull();
  });

  it('n=35 all wins (>=30 floor, <100 target) -> signal reported but flagged as below the decision-grade target', () => {
    const ops = Array.from({ length: 35 }, (_, i) => bigWin(`w${i}`));
    const result = buildShadowComparison({ rf1h_cond4h_15m: ops });
    expect(result.rf1h_cond4h_15m.counted).toBe(35);
    expect(result.rf1h_cond4h_15m.verdict).toMatch(/^SINAL \(positivo\), mas amostra ainda abaixo do alvo \(100\)$/);
  });

  // Codex review (PR #129, P2): a cascade EXPERIMENTAL nunca recebe o
  // rótulo "decisão-grade" isolado — amostra+IC só provam significância
  // estatística, não o critério de volume que known-risks item 56 também
  // exige. O veredito tem que dizer explicitamente que falta essa 2ª parte.
  it('n=105 all wins (>=100 target) -> statistically positive, but NEVER labeled decisão-grade alone (volume condition still unconfirmed)', () => {
    const ops = Array.from({ length: 105 }, (_, i) => bigWin(`w${i}`));
    const result = buildShadowComparison({ rf1h_cond4h_15m: ops });
    expect(result.rf1h_cond4h_15m.counted).toBe(105);
    expect(result.rf1h_cond4h_15m.verdict).toContain('SINAL ESTATÍSTICO POSITIVO');
    expect(result.rf1h_cond4h_15m.verdict).not.toBe('SINAL POSITIVO (decisão-grade)');
    expect(result.rf1h_cond4h_15m.verdict).toMatch(/volume\/mês/);
    expect(result.rf1h_cond4h_15m.expectancyR).toBeGreaterThan(0);
  });

  it('volumeComparison reports operations/month for both cascades over a shared observation window, with no hard-coded "meaningfully higher" threshold', () => {
    // 30-day span: experimental produces 2x the operations of native within
    // the SAME window (10 vs 5) — the function must report the 2 rates and
    // their ratio as data, never collapse it into a boolean verdict.
    const spread = (id, dayOffset) => bigWin(id, { created_date: new Date(Date.UTC(2026, 0, 1 + dayOffset)).toISOString() });
    const experimental = Array.from({ length: 10 }, (_, i) => spread(`e${i}`, i * 3)); // day 0..27
    const native = Array.from({ length: 5 }, (_, i) => spread(`n${i}`, i * 6)); // day 0..24
    const result = buildShadowComparison({ rf1h_cond4h_15m: experimental, '4h_15m': native });

    expect(result.rf1h_cond4h_15m.operationsPerMonth).not.toBeNull();
    expect(result['4h_15m'].operationsPerMonth).not.toBeNull();
    expect(result.volumeComparison.experimentalOperationsPerMonth).toBe(result.rf1h_cond4h_15m.operationsPerMonth);
    expect(result.volumeComparison.nativeOperationsPerMonth).toBe(result['4h_15m'].operationsPerMonth);
    expect(result.volumeComparison.ratio).toBeCloseTo(2, 1); // 10 vs 5 over the same window
  });

  it('volumeComparison.ratio is null when either side lacks a measurable window (all identical created_date, or empty)', () => {
    const ops = Array.from({ length: 35 }, (_, i) => bigWin(`w${i}`)); // fixture default: same created_date for all
    const result = buildShadowComparison({ rf1h_cond4h_15m: ops, '4h_15m': [] });
    expect(result.volumeComparison.ratio).toBeNull();
  });

  it('n=105 evenly split +1R/-1R (near-zero mean, symmetric magnitude) -> CI straddles zero -> INCONCLUSIVO, even at n>=target', () => {
    const ops = [
      ...Array.from({ length: 53 }, (_, i) => unitWin(`w${i}`)),
      ...Array.from({ length: 52 }, (_, i) => bigLoss(`l${i}`)),
    ];
    const result = buildShadowComparison({ rf1h_cond4h_15m: ops });
    expect(result.rf1h_cond4h_15m.counted).toBe(105);
    expect(result.rf1h_cond4h_15m.verdict).toBe('INCONCLUSIVO (IC cruza zero)');
  });

  it('Bonferroni CI is computed ONLY for the experimental cascade, never for the native control', () => {
    const ops = Array.from({ length: 105 }, (_, i) => bigWin(`w${i}`));
    const result = buildShadowComparison({ rf1h_cond4h_15m: ops, '4h_15m': ops });
    expect(result.rf1h_cond4h_15m.bonferroniCI).not.toBeNull();
    expect(result.rf1h_cond4h_15m.bonferroniZ).toBe(2.24);
    expect(result['4h_15m'].bonferroniCI).toBeNull();
    expect(result['4h_15m'].bonferroniZ).toBeNull();
    // Native cascade still gets a verdict — the standard (non-Bonferroni)
    // 95% CI decides it, since it's the control, not the hypothesis under
    // multiple-comparisons scrutiny.
    expect(result['4h_15m'].verdict).toBe('SINAL POSITIVO (decisão-grade)');
  });

  it('the Bonferroni CI is strictly wider than the standard 95% CI for the same sample', () => {
    // Mixed magnitudes (unitWin +1R, bigWin +2.25R) so the sample has real
    // variance — an all-identical-R sample gives stdErr=0, where any z
    // multiplier produces the same zero-width interval and this assertion
    // would be vacuous.
    const ops = [
      ...Array.from({ length: 20 }, (_, i) => unitWin(`u${i}`)),
      ...Array.from({ length: 15 }, (_, i) => bigWin(`b${i}`)),
    ];
    const result = buildShadowComparison({ rf1h_cond4h_15m: ops });
    const [lo95, hi95] = result.rf1h_cond4h_15m.expectancyRCI95;
    const [loBonf, hiBonf] = result.rf1h_cond4h_15m.bonferroniCI;
    expect(loBonf).toBeLessThan(lo95);
    expect(hiBonf).toBeGreaterThan(hi95);
  });
});
