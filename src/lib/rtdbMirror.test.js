// Pure module — no firebase/database or firebase-admin/database mock needed,
// see src/lib/rtdbMirror.js's header comment for why. Covers the invariants
// that entitiesRtdbTripwire.test.js / scripts/adminEntitiesRtdbTripwire.test.js
// then verify structurally against the real adapters (docs/known-risks.md
// item 152).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RTDB_MIRRORED_ENTITIES, toRtdbKey, createRtdbMirrorHelpers } from './rtdbMirror.js';

describe('toRtdbKey', () => {
  it('sanitiza o caso real do landmine — dedup_key com timestamp ISO bruto', () => {
    const id = 'trade_BTCUSDT_4h_BUY_raw_2026-09-03T12:00:00.000Z';
    const key = toRtdbKey(id);
    expect(key).not.toMatch(/[.#$/[\]]/);
    // Determinístico e idempotente.
    expect(toRtdbKey(id)).toBe(key);
  });

  it('não mexe em ids já seguros (assetStates, auto-gerados)', () => {
    expect(toRtdbKey('aBcD123xyz')).toBe('aBcD123xyz');
  });

  it('sanitiza cada caractere proibido individualmente', () => {
    expect(toRtdbKey('a.b#c$d[e]f/g')).toBe('a_b_c_d_e_f_g');
  });
});

describe('createRtdbMirrorHelpers', () => {
  let mirrorSet;
  let mirrorUpdate;
  let mirrorRemove;
  let helpers;

  beforeEach(() => {
    mirrorSet = vi.fn();
    mirrorUpdate = vi.fn();
    mirrorRemove = vi.fn();
    helpers = createRtdbMirrorHelpers({ mirrorSet, mirrorUpdate, mirrorRemove });
  });

  describe('withRtdbMirror', () => {
    it('entidade fora de RTDB_MIRRORED_ENTITIES é passthrough puro — nenhum mirror* é chamado', async () => {
      const real = {
        create: vi.fn().mockResolvedValue({ id: 'x1', foo: 'bar' }),
        update: vi.fn().mockResolvedValue({ id: 'x1', foo: 'baz' }),
      };
      const wrapped = helpers.withRtdbMirror('SignalEvent', real);
      expect(wrapped).toBe(real);
      await wrapped.create({ foo: 'bar' });
      expect(mirrorSet).not.toHaveBeenCalled();
    });

    it('AssetState.create espelha o doc criado (com id) na chave sanitizada', async () => {
      const real = { create: vi.fn().mockResolvedValue({ id: 'BTCUSDT::4h', asset_id: 'BTCUSDT', timeframe: '4h' }) };
      const wrapped = helpers.withRtdbMirror('AssetState', real);
      const created = await wrapped.create({ asset_id: 'BTCUSDT', timeframe: '4h' });
      expect(created).toEqual({ id: 'BTCUSDT::4h', asset_id: 'BTCUSDT', timeframe: '4h' });
      expect(mirrorSet).toHaveBeenCalledWith('assetStates', 'BTCUSDT::4h', created);
    });

    it('TradeOperation.update espelha só o patch (não o doc completo) na chave sanitizada', async () => {
      const real = { update: vi.fn().mockResolvedValue({ id: 'trade_x', status: 'CLOSED' }) };
      const wrapped = helpers.withRtdbMirror('TradeOperation', real);
      await wrapped.update('trade_x', { status: 'CLOSED' });
      expect(mirrorUpdate).toHaveBeenCalledWith('tradeOperations', 'trade_x', { status: 'CLOSED' });
    });

    it('bulkCreate espelha cada item criado individualmente', async () => {
      const real = { bulkCreate: vi.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]) };
      const wrapped = helpers.withRtdbMirror('AssetState', real);
      await wrapped.bulkCreate([{}, {}]);
      expect(mirrorSet).toHaveBeenCalledWith('assetStates', 'a', { id: 'a' });
      expect(mirrorSet).toHaveBeenCalledWith('assetStates', 'b', { id: 'b' });
    });

    it('deleteMany remove do RTDB cada doc deletado no Firestore', async () => {
      const real = { deleteMany: vi.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]) };
      const wrapped = helpers.withRtdbMirror('AssetState', real);
      await wrapped.deleteMany({ asset_id: 'BTCUSDT' });
      expect(mirrorRemove).toHaveBeenCalledWith('assetStates', 'a');
      expect(mirrorRemove).toHaveBeenCalledWith('assetStates', 'b');
    });

    it('deleteMany sem retorno (backend ainda não migrado) não lança nem chama mirrorRemove', async () => {
      const real = { deleteMany: vi.fn().mockResolvedValue(undefined) };
      const wrapped = helpers.withRtdbMirror('AssetState', real);
      await expect(wrapped.deleteMany({})).resolves.toBeUndefined();
      expect(mirrorRemove).not.toHaveBeenCalled();
    });

    it('devolve exatamente o que o adaptador real devolveria — mirror nunca altera o valor de retorno', async () => {
      const realDoc = { id: 'x1', foo: 'bar' };
      const real = { create: vi.fn().mockResolvedValue(realDoc) };
      const wrapped = helpers.withRtdbMirror('AssetState', real);
      const result = await wrapped.create({ foo: 'bar' });
      expect(result).toBe(realDoc);
    });
  });

  describe('withCreateOpMirror', () => {
    it('espelha só quando created && doc estão presentes', async () => {
      const fn = vi.fn().mockResolvedValue({ created: true, doc: { id: 'trade_x', symbol: 'BTCUSDT' } });
      const wrapped = helpers.withCreateOpMirror(fn);
      const res = await wrapped('BTCUSDT', 'trade_x', {}, undefined);
      expect(res).toEqual({ created: true, doc: { id: 'trade_x', symbol: 'BTCUSDT' } });
      expect(mirrorSet).toHaveBeenCalledWith('tradeOperations', 'trade_x', { id: 'trade_x', symbol: 'BTCUSDT' });
    });

    it('não espelha quando bloqueado (created: false)', async () => {
      const fn = vi.fn().mockResolvedValue({ created: false, existingId: 'trade_x' });
      const wrapped = helpers.withCreateOpMirror(fn);
      await wrapped('BTCUSDT', 'trade_x', {}, undefined);
      expect(mirrorSet).not.toHaveBeenCalled();
    });

    it('não espelha em reuse (created: false, existing presente)', async () => {
      const fn = vi.fn().mockResolvedValue({ created: false, existing: { id: 'trade_x' } });
      const wrapped = helpers.withCreateOpMirror(fn);
      await wrapped('BTCUSDT', 'trade_x', {}, undefined);
      expect(mirrorSet).not.toHaveBeenCalled();
    });
  });

  describe('withTransitionOpMirror', () => {
    it('espelha só o patch aplicado quando applied && patch estão presentes', async () => {
      const fn = vi.fn().mockResolvedValue({ applied: true, patch: { status: 'STOP_HIT', current_stop: 100 } });
      const wrapped = helpers.withTransitionOpMirror(fn);
      await wrapped('trade_x', 'RUNNER_ACTIVE', { status: 'STOP_HIT' }, { assetId: 'BTCUSDT' });
      expect(mirrorUpdate).toHaveBeenCalledWith('tradeOperations', 'trade_x', { status: 'STOP_HIT', current_stop: 100 });
    });

    it('não espelha quando o CAS rejeita (applied: false)', async () => {
      const fn = vi.fn().mockResolvedValue({ applied: false, currentStatus: 'STOP_HIT' });
      const wrapped = helpers.withTransitionOpMirror(fn);
      await wrapped('trade_x', 'RUNNER_ACTIVE', { status: 'STOP_HIT' }, {});
      expect(mirrorUpdate).not.toHaveBeenCalled();
    });

    it('um throw síncrono da primitiva mirrorUpdate nunca propaga nem muda o retorno ao chamador (defesa em profundidade)', async () => {
      mirrorUpdate.mockImplementation(() => { throw new Error('RTDB indisponível'); });
      const fn = vi.fn().mockResolvedValue({ applied: true, patch: { status: 'STOP_HIT' } });
      const wrapped = helpers.withTransitionOpMirror(fn);
      // Mesmo que a primitiva injetada se comporte mal (lance síncrono em vez
      // do .catch() próprio esperado), o helper puro protege o chamador —
      // safeMirrorCall garante isso independente da disciplina de cada backend.
      await expect(wrapped('trade_x', 'RUNNER_ACTIVE', { status: 'STOP_HIT' }, {}))
        .resolves.toEqual({ applied: true, patch: { status: 'STOP_HIT' } });
    });
  });

  it('RTDB_MIRRORED_ENTITIES trava exatamente no escopo desta rodada', () => {
    expect(RTDB_MIRRORED_ENTITIES).toEqual({ AssetState: 'assetStates', TradeOperation: 'tradeOperations' });
  });
});
