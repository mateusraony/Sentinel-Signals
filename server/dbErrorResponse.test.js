// sendDbError (server/dbErrorResponse.js) — item 282: cota do banco esgotada vira
// 503 `db_quota`; qualquer outro erro mantém o status/corpo que a rota já tinha.
import { describe, it, expect, vi } from 'vitest';
import { sendDbError } from './dbErrorResponse.js';

function fakeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('sendDbError', () => {
  it('cota do Neon esgotada → 503 com code db_quota (mensagem real do Neon)', async () => {
    const res = fakeRes();
    await sendDbError(res, new Error('Your account or project has exceeded the quota. Upgrade your plan to increase limits.'), { status: 500, error: 'Erro interno.' });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'Banco de dados sem cota.', code: 'db_quota' });
  });

  it('variante com o nome da cota também é reconhecida, e vale para rotas que antes devolviam 400', async () => {
    const res = fakeRes();
    await sendDbError(res, new Error('exceeded the compute time quota'), { status: 400, error: 'qualquer' });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('erro comum mantém o fallback da rota (500 genérico)', async () => {
    const res = fakeRes();
    await sendDbError(res, new Error('connection terminated'), { status: 500, error: 'Erro interno.' });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Erro interno.' });
  });

  it('erro comum mantém o fallback da rota (400 com a mensagem)', async () => {
    const res = fakeRes();
    await sendDbError(res, new Error('valor inválido'), { status: 400, error: 'valor inválido' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'valor inválido' });
  });

  it('erro sem mensagem/undefined nunca lança e cai no fallback', async () => {
    const res = fakeRes();
    await sendDbError(res, undefined, { status: 500, error: 'Erro interno.' });
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
