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
