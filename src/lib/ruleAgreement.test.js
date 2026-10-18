import { describe, it, expect } from 'vitest';
import { agreementLabel, AGREEMENT_HINT, STRENGTH_WORD } from './ruleAgreement.js';

// PR-B (item 277): "🔥 Forte / ⚡ Moderado / 〰 Fraco" soava como chance de
// acerto. O painel passa a usar o mesmo 🧩 "regras alinhadas" do Telegram.
describe('agreementLabel', () => {
  it('score numérico vira "🧩 N/100"', () => {
    expect(agreementLabel({ score: 85 })).toBe('🧩 85/100');
    expect(agreementLabel({ score: 0 })).toBe('🧩 0/100');
    expect(agreementLabel({ score: 100 })).toBe('🧩 100/100');
  });

  it('sem score, usa a força gravada pelo motor em palavras', () => {
    expect(agreementLabel({ strength: 'strong' })).toBe('🧩 concordância forte');
    expect(agreementLabel({ strength: 'moderate' })).toBe('🧩 concordância moderada');
    expect(agreementLabel({ strength: 'weak' })).toBe('🧩 concordância fraca');
  });

  it('score vence a força quando os dois existem', () => {
    expect(agreementLabel({ score: 70, strength: 'strong' })).toBe('🧩 70/100');
  });

  it('sem dado (ou dado inválido) não inventa rótulo', () => {
    expect(agreementLabel()).toBeNull();
    expect(agreementLabel({})).toBeNull();
    expect(agreementLabel({ score: NaN })).toBeNull();
    expect(agreementLabel({ score: '85' })).toBeNull();
    expect(agreementLabel({ strength: 'inventada' })).toBeNull();
  });

  it('nunca usa os emojis antigos de força', () => {
    for (const input of [{ score: 90 }, { strength: 'strong' }, { strength: 'moderate' }, { strength: 'weak' }]) {
      expect(agreementLabel(input)).not.toMatch(/🔥|⚡|〰|💪/);
    }
  });

  it('a dica diz que não é chance de acerto', () => {
    expect(AGREEMENT_HINT).toMatch(/não é chance de acerto/);
    expect(Object.keys(STRENGTH_WORD)).toEqual(expect.arrayContaining(['strong', 'moderate', 'weak']));
  });
});
