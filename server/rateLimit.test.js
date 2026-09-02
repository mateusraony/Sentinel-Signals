// docs/known-risks.md item 145: server/index.js chaveava seus freios de
// cortesia (/api/telegram-notify, /api/backtest/status, /api/backtest/
// artifact) por req.uid — mas a auth é só anônima (item 1), então
// re-autenticar (signInAnonymously de novo) dá um uid NOVO de graça,
// zerando o cooldown sem custo. createCooldown foi extraído de index.js
// pra este arquivo justamente pra poder testar isso sem precisar das
// credenciais do firebase-admin que index.js exige no carregamento do
// módulo (JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) +
// process.exit(1) se faltar).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCooldown } from './rateLimit.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createCooldown', () => {
  it('bloqueia a 2a chamada dentro da janela, mesmo com uid DIFERENTE — fecha o bypass de reautenticação anônima (item 145)', () => {
    const check = createCooldown(10_000);
    const reqA = { ip: '203.0.113.5', uid: 'anon-uid-1' };
    const reqB = { ip: '203.0.113.5', uid: 'anon-uid-2' }; // mesmo IP, uid novo (re-auth anônima)
    expect(check(reqA)).toBe(true);
    expect(check(reqB)).toBe(false);
  });

  it('não bloqueia requisições de IPs diferentes entre si', () => {
    const check = createCooldown(10_000);
    const reqA = { ip: '203.0.113.5', uid: 'x' };
    const reqB = { ip: '198.51.100.9', uid: 'y' };
    expect(check(reqA)).toBe(true);
    expect(check(reqB)).toBe(true);
  });

  it('libera de novo depois que a janela passa', () => {
    vi.useFakeTimers();
    const check = createCooldown(10_000);
    const req = { ip: '203.0.113.5', uid: 'anon-uid-1' };
    expect(check(req)).toBe(true);
    expect(check(req)).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(check(req)).toBe(true);
  });

  it('keyOf customizado é respeitado (assinatura genérica usada pelos 3 limiters de index.js)', () => {
    const check = createCooldown(5_000, (req) => req.customKey);
    const reqA = { ip: '203.0.113.5', customKey: 'k1' };
    const reqB = { ip: '198.51.100.9', customKey: 'k1' }; // IP diferente, mesma customKey
    expect(check(reqA)).toBe(true);
    expect(check(reqB)).toBe(false);
  });
});
