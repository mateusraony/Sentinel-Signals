// Extraído de server/index.js's estilo (tradeOpPatchGuard.test.js) só pra
// ser testável sem as credenciais do firebase-admin que index.js exige no
// carregamento.
import { describe, it, expect, vi } from 'vitest';
import { checkOwnerKey, requireOwner } from './requireOwner.js';

describe('checkOwnerKey', () => {
  it('aceita quando a chave enviada bate exatamente com a esperada', () => {
    expect(checkOwnerKey('minha-chave-secreta', 'minha-chave-secreta')).toBe(true);
  });

  it('rejeita chave diferente', () => {
    expect(checkOwnerKey('chave-errada', 'minha-chave-secreta')).toBe(false);
  });

  it('rejeita quando nenhuma chave foi enviada', () => {
    expect(checkOwnerKey(undefined, 'minha-chave-secreta')).toBe(false);
  });

  it('rejeita quando a chave esperada não está configurada no servidor', () => {
    expect(checkOwnerKey('qualquer-coisa', undefined)).toBe(false);
    expect(checkOwnerKey('qualquer-coisa', '')).toBe(false);
  });

  it('rejeita valor não-string sem lançar (Buffer.from não pode explodir)', () => {
    expect(checkOwnerKey(['array-nao-e-string'], 'minha-chave-secreta')).toBe(false);
    expect(checkOwnerKey(123, 'minha-chave-secreta')).toBe(false);
  });
});

describe('requireOwner middleware', () => {
  function makeReqRes(headerValue) {
    const req = { headers: headerValue !== undefined ? { 'x-owner-key': headerValue } : {} };
    const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    return { req, res };
  }

  it('chama next() quando a chave do header bate com OWNER_ACCESS_KEY', () => {
    process.env.OWNER_ACCESS_KEY = 'chave-do-dono';
    const { req, res } = makeReqRes('chave-do-dono');
    const next = vi.fn();
    requireOwner(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
    delete process.env.OWNER_ACCESS_KEY;
  });

  it('responde 403 sem chamar next() quando a chave não bate', () => {
    process.env.OWNER_ACCESS_KEY = 'chave-do-dono';
    const { req, res } = makeReqRes('chave-errada');
    const next = vi.fn();
    requireOwner(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    delete process.env.OWNER_ACCESS_KEY;
  });

  it('responde 403 quando nenhum header foi enviado', () => {
    process.env.OWNER_ACCESS_KEY = 'chave-do-dono';
    const { req, res } = makeReqRes(undefined);
    const next = vi.fn();
    requireOwner(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    delete process.env.OWNER_ACCESS_KEY;
  });
});
