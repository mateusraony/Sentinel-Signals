// Extraído de server/index.js's estilo (rateLimit.js) só pra ser testável
// sem as credenciais do firebase-admin que index.js exige no carregamento.
import { describe, it, expect } from 'vitest';
import { validateTradeOpPatch, FORBIDDEN_PATCH_FIELDS } from './tradeOpPatchGuard.js';

describe('validateTradeOpPatch', () => {
  it('aceita um patch de negócio normal', () => {
    expect(validateTradeOpPatch({ status: 'RUNNER_ACTIVE', current_stop: 105, tier: 'A' })).toBeNull();
  });

  it('rejeita cada campo proibido, um por um', () => {
    for (const field of FORBIDDEN_PATCH_FIELDS) {
      const error = validateTradeOpPatch({ [field]: 'malicious' });
      expect(error).toMatch(new RegExp(`"${field}"`));
    }
  });

  it('rejeita patch que não é um objeto simples', () => {
    expect(validateTradeOpPatch(null)).toMatch(/objeto/);
    expect(validateTradeOpPatch('status')).toMatch(/objeto/);
    expect(validateTradeOpPatch(['status'])).toMatch(/objeto/);
  });

  it('não confunde um campo de negócio com nome parecido a um proibido', () => {
    // 'asset_id' é proibido, mas nada bloqueia um campo diferente que só
    // contém a substring — a checagem é por chave exata.
    expect(validateTradeOpPatch({ related_asset_id_note: 'x' })).toBeNull();
  });
});
