// Cobre a validação de allowedSide (docs/known-risks.md item 71, Codex
// review PR #156): um valor inválido não pode passar incólume até
// scanner.js, onde bloquearia os DOIS lados silenciosamente em vez de
// falhar alto e cedo.
import { describe, it, expect, afterEach } from 'vitest';
import { setPineConfigOverrides, getPineConfig } from './backtestPineConfig.js';

describe('setPineConfigOverrides — validação de allowedSide', () => {
  afterEach(() => { setPineConfigOverrides({}); }); // não vaza overrides entre testes

  it('aceita ausente/null/undefined (default, sem filtro de lado)', async () => {
    expect(() => setPineConfigOverrides({})).not.toThrow();
    expect((await getPineConfig()).allowedSide).toBeNull();
    expect(() => setPineConfigOverrides({ allowedSide: null })).not.toThrow();
  });

  it("aceita 'BUY'/'SELL' exatos", async () => {
    setPineConfigOverrides({ allowedSide: 'SELL' });
    expect((await getPineConfig()).allowedSide).toBe('SELL');
    setPineConfigOverrides({ allowedSide: 'BUY' });
    expect((await getPineConfig()).allowedSide).toBe('BUY');
  });

  it('rejeita caixa errada, typo ou valor não-string — falha alto e cedo em vez de bloquear os dois lados em silêncio', () => {
    expect(() => setPineConfigOverrides({ allowedSide: 'sell' })).toThrow(/allowedSide inválido/);
    expect(() => setPineConfigOverrides({ allowedSide: 'Sell' })).toThrow(/allowedSide inválido/);
    expect(() => setPineConfigOverrides({ allowedSide: true })).toThrow(/allowedSide inválido/);
    expect(() => setPineConfigOverrides({ allowedSide: 'BOTH' })).toThrow(/allowedSide inválido/);
  });
});

// docs/known-risks.md item 281 — alvo estrutural (backtest-only): valor errado
// tem que falhar antes do replay, nunca rodar com o alvo de hoje em silêncio.
describe('setPineConfigOverrides — validação de targetMode/targetNearPolicy (item 281)', () => {
  afterEach(() => { setPineConfigOverrides({}); });

  it("padrão = hoje ('r_multiple'/'literal')", async () => {
    const cfg = await getPineConfig();
    expect(cfg.targetMode).toBe('r_multiple');
    expect(cfg.targetNearPolicy).toBe('literal');
  });

  it('aceita os 2 modos estruturais × 3 políticas, e o controle sem política', async () => {
    setPineConfigOverrides({ targetMode: 'r_multiple' });
    expect((await getPineConfig()).targetMode).toBe('r_multiple');
    for (const targetMode of ['fib_ext_15m', 'swing_4h']) {
      for (const targetNearPolicy of ['literal', 'min_r_fallback', 'next_level']) {
        setPineConfigOverrides({ targetMode, targetNearPolicy });
        expect(await getPineConfig()).toMatchObject({ targetMode, targetNearPolicy });
      }
    }
  });

  it('rejeita modo/política fora da lista e a combinação com a Fibonacci do item 267', () => {
    expect(() => setPineConfigOverrides({ targetMode: 'topo' })).toThrow(/targetMode inválido/);
    expect(() => setPineConfigOverrides({ targetMode: 'Swing_4h' })).toThrow(/targetMode inválido/);
    expect(() => setPineConfigOverrides({ targetNearPolicy: 'perto' })).toThrow(/targetNearPolicy inválido/);
    // null explícito passaria por `!= null` e quebraria no meio do replay (review)
    expect(() => setPineConfigOverrides({ targetMode: null })).toThrow(/targetMode inválido/);
    expect(() => setPineConfigOverrides({ targetMode: 'swing_4h', targetNearPolicy: null })).toThrow(/targetNearPolicy inválido/);
    expect(() => setPineConfigOverrides({ targetMode: 'fib_ext_15m', fibEntryEnabled: true })).toThrow(/não combina com fibEntryEnabled/);
    expect(() => setPineConfigOverrides({ targetMode: 'r_multiple', fibEntryEnabled: true })).not.toThrow();
    // braço pela metade: política sem modo estrutural rodaria igual ao controle (2ª revisão)
    expect(() => setPineConfigOverrides({ targetNearPolicy: 'next_level' })).toThrow(/sem targetMode estrutural/);
    expect(() => setPineConfigOverrides({ targetMode: 'r_multiple', targetNearPolicy: 'literal' })).toThrow(/sem targetMode estrutural/);
  });
});
