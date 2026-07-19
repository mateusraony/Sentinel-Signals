import { describe, it, expect } from 'vitest';
import { validateAssetConfig } from './assetConfigValidation';

function baseConfig(overrides = {}) {
  return {
    rf_period: 20,
    rf_multiplier: 3.5,
    rsi_period: 14,
    rsi_overbought: 70,
    rsi_oversold: 30,
    macd_fast: 12,
    macd_slow: 26,
    macd_signal: 9,
    ema_short: 20,
    ema_long: 50,
    alert_cooldown_minutes: 60,
    ...overrides,
  };
}

describe('validateAssetConfig', () => {
  it('returns no errors for a valid config', () => {
    expect(validateAssetConfig(baseConfig())).toEqual([]);
  });

  it('rejects a zero/negative/NaN period or multiplier (Number(\'\') === 0 from a cleared input)', () => {
    expect(validateAssetConfig(baseConfig({ rf_period: 0 }))).toContain('Range Filter: período deve ser um número inteiro positivo');
    expect(validateAssetConfig(baseConfig({ rf_multiplier: -1 }))).toContain('Range Filter: multiplicador deve ser um número positivo');
    expect(validateAssetConfig(baseConfig({ rsi_period: NaN }))).toContain('RSI: período deve ser um número inteiro positivo');
    expect(validateAssetConfig(baseConfig({ macd_fast: 0 }))).toContain('MACD: período fast deve ser um número inteiro positivo');
    expect(validateAssetConfig(baseConfig({ ema_short: -5 }))).toContain('EMA: período curto deve ser um número inteiro positivo');
  });

  // Codex review (PR #61): calculateRSI/calculateATR use `period` as an
  // array index/loop bound — a fractional period like 14.5 never touches an
  // integer index at or past that point, so the series silently stays at
  // its .fill() default (RSI reads 50/'neutral' forever) instead of
  // erroring. MACD/EMA/RangeFilter treat period as a smoothing constant
  // (harmless if fractional), but a fractional bar-count is meaningless
  // either way, so every period field rejects non-integers.
  it('rejects a fractional period on every period/bar-count field', () => {
    expect(validateAssetConfig(baseConfig({ rf_period: 20.5 }))).toContain('Range Filter: período deve ser um número inteiro positivo');
    expect(validateAssetConfig(baseConfig({ rsi_period: 14.5 }))).toContain('RSI: período deve ser um número inteiro positivo');
    expect(validateAssetConfig(baseConfig({ macd_fast: 12.5 }))).toContain('MACD: período fast deve ser um número inteiro positivo');
    expect(validateAssetConfig(baseConfig({ macd_slow: 26.5 }))).toContain('MACD: período slow deve ser um número inteiro positivo');
    expect(validateAssetConfig(baseConfig({ macd_signal: 9.5 }))).toContain('MACD: período signal deve ser um número inteiro positivo');
    expect(validateAssetConfig(baseConfig({ ema_short: 20.5 }))).toContain('EMA: período curto deve ser um número inteiro positivo');
    expect(validateAssetConfig(baseConfig({ ema_long: 50.5 }))).toContain('EMA: período longo deve ser um número inteiro positivo');
  });

  it('still allows a fractional rf_multiplier (a real multiplier, not a bar count)', () => {
    expect(validateAssetConfig(baseConfig({ rf_multiplier: 3.75 }))).toEqual([]);
  });

  it('rejects rsi_overbought <= rsi_oversold (inverted or equal)', () => {
    expect(validateAssetConfig(baseConfig({ rsi_overbought: 20, rsi_oversold: 80 }))).toContain('RSI: overbought deve ser maior que oversold');
    expect(validateAssetConfig(baseConfig({ rsi_overbought: 50, rsi_oversold: 50 }))).toContain('RSI: overbought deve ser maior que oversold');
  });

  it('rejects rsi thresholds >= 100', () => {
    expect(validateAssetConfig(baseConfig({ rsi_overbought: 100 }))).toContain('RSI: overbought deve ser menor que 100');
    expect(validateAssetConfig(baseConfig({ rsi_oversold: 100, rsi_overbought: 150 }))).toEqual(
      expect.arrayContaining(['RSI: overbought deve ser menor que 100', 'RSI: oversold deve ser menor que 100'])
    );
  });

  // known-risks item 31: macd_fast >= macd_slow doesn't crash calculateMACD,
  // it just produces an unusual (but not mislabeled-direction) histogram —
  // still worth rejecting at the form so a user doesn't save a nonsensical pair.
  it('rejects macd_fast >= macd_slow', () => {
    expect(validateAssetConfig(baseConfig({ macd_fast: 26, macd_slow: 12 }))).toContain('MACD: período fast deve ser menor que slow');
    expect(validateAssetConfig(baseConfig({ macd_fast: 12, macd_slow: 12 }))).toContain('MACD: período fast deve ser menor que slow');
  });

  // known-risks item 31 (the finding beyond the audit's own list): an
  // inverted ema_short/ema_long doesn't fail calculateEMAs — it fires a
  // cross with the golden/death label INVERTED, which scanner.js turns
  // straight into the wrong BUY/SELL signal_type. This is the UI-side half
  // of the guard; resolveIndicatorParams has the engine-side half.
  it('rejects ema_short >= ema_long', () => {
    expect(validateAssetConfig(baseConfig({ ema_short: 50, ema_long: 20 }))).toContain('EMA: período curto deve ser menor que o longo');
    expect(validateAssetConfig(baseConfig({ ema_short: 30, ema_long: 30 }))).toContain('EMA: período curto deve ser menor que o longo');
  });

  it('rejects a negative cooldown but allows zero', () => {
    expect(validateAssetConfig(baseConfig({ alert_cooldown_minutes: -1 }))).toContain('Cooldown de alertas: deve ser um número maior ou igual a zero');
    expect(validateAssetConfig(baseConfig({ alert_cooldown_minutes: 0 }))).toEqual([]);
  });

  it('accumulates multiple independent errors in one pass', () => {
    const errors = validateAssetConfig(baseConfig({ rf_period: 0, ema_short: 50, ema_long: 20, alert_cooldown_minutes: -5 }));
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
