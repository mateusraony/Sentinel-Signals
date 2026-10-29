// docs/known-risks.md item 288 — a loja em memória do teste a seco. Cada teste abaixo
// fecha uma lacuna de fidelidade entre o backend falso dos testes e o Postgres real,
// e prova (contra o falso cru) que a lacuna existia.
import { describe, it, expect } from 'vitest';
import { createFakeBackend } from '../__fixtures__/fakeBackend.js';
import { createSnapshotBackend, exportSnapshot, readOnlyProxy } from './snapshotBackend.js';

const liveOp = (over = {}) => ({
  id: 'trade_old', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY', status: 'SIGNAL_CONFIRMED',
  entry_price: 100, current_stop: 95, created_date: '2026-10-18T00:00:00.000Z', ...over,
});

describe('createSnapshotBackend', () => {
  it('operação ativa vinda do retrato BLOQUEIA uma 2ª no mesmo ativo (o falso cru deixava)', async () => {
    const { backend } = createSnapshotBackend({ TradeOperation: [liveOp()] });
    const res = await backend.tradeOps.createTradeOpIfNoneActive('a1', 'trade_new', { asset_id: 'a1', status: 'SIGNAL_CONFIRMED', side: 'BUY' });
    expect(res).toEqual({ created: false, existingId: 'trade_old' });

    // Prova de que a lacuna existia: o falso cru, semeado do mesmo jeito, cria a 2ª.
    const raw = createFakeBackend();
    raw._seed('TradeOperation', liveOp());
    const rawRes = await raw.tradeOps.createTradeOpIfNoneActive('a1', 'trade_new', { asset_id: 'a1', status: 'SIGNAL_CONFIRMED', side: 'BUY' });
    expect(rawRes.created).toBe(true);
  });

  it('operação encerrada no retrato não bloqueia; o mesmo id é reaproveitado, nunca revivido', async () => {
    const { backend } = createSnapshotBackend({ TradeOperation: [liveOp({ status: 'STOP_HIT' })] });
    const again = await backend.tradeOps.createTradeOpIfNoneActive('a1', 'trade_old', { asset_id: 'a1', status: 'SIGNAL_CONFIRMED' });
    expect(again.created).toBe(false);
    expect((await backend.entities.TradeOperation.get('trade_old')).status).toBe('STOP_HIT');
    const fresh = await backend.tradeOps.createTradeOpIfNoneActive('a1', 'trade_new', { asset_id: 'a1', status: 'SIGNAL_CONFIRMED' });
    expect(fresh.created).toBe(true);
  });

  it('retrato com 2 operações ativas no mesmo ativo é recusado (exceto convivência hierárquica)', () => {
    expect(() => createSnapshotBackend({ TradeOperation: [liveOp(), liveOp({ id: 'trade_dup' })] })).toThrow(/2 operações ativas/);
    expect(() => createSnapshotBackend({ TradeOperation: [
      liveOp({ hierarchical_cascade: true, cascade: '4h_15m' }),
      liveOp({ id: 'trade_smc', hierarchical_cascade: true, cascade: '1h_5m' }),
    ] })).not.toThrow();
  });

  it('update de id inexistente LANÇA, como no Postgres (o falso cru criava a linha)', async () => {
    const { backend } = createSnapshotBackend({});
    await expect(backend.entities.TradeOperation.update('nao_existe', { status: 'CLOSED' })).rejects.toThrow(/inexistente/);
    const raw = createFakeBackend();
    await raw.entities.TradeOperation.update('nao_existe', { status: 'CLOSED' });
    expect(raw._get('TradeOperation', 'nao_existe')).toBeTruthy();
  });

  it('leituras devolvem CÓPIAS (mexer no resultado não muda a loja)', async () => {
    const { backend } = createSnapshotBackend({ TradeOperation: [liveOp()] });
    const [op] = await backend.entities.TradeOperation.filter({ asset_id: 'a1' });
    op.status = 'CLOSED';
    expect((await backend.entities.TradeOperation.get('trade_old')).status).toBe('SIGNAL_CONFIRMED');
  });

  it('o retrato de entrada nunca é alterado', async () => {
    const snapshot = { TradeOperation: [liveOp()] };
    const copy = structuredClone(snapshot);
    const { backend } = createSnapshotBackend(snapshot);
    await backend.tradeOps.transitionTradeOp('trade_old', 'SIGNAL_CONFIRMED', { status: 'STOP_HIT' }, { assetId: 'a1' });
    expect(snapshot).toEqual(copy);
  });

  it('id gerado para linha nova NUNCA sobrescreve uma linha do retrato', async () => {
    // O banco real gera ids que não colidem; o contador do falso recomeça do zero
    // e podia sobrescrever "SystemLog_1" que veio do retrato.
    const seeded = { id: 'SystemLog_1', message: 'do banco' };
    const { backend } = createSnapshotBackend({ SystemLog: [seeded], AssetState: [{ id: 'AssetState_1', asset_id: 'x', timeframe: '4h' }] });
    const created = await backend.entities.SystemLog.create({ message: 'novo' });
    const bulk = await backend.entities.SystemLog.bulkCreate([{ message: 'novo2' }]);
    expect(created.id).not.toBe('SystemLog_1');
    expect(bulk[0].id).not.toBe('SystemLog_1');
    expect((await backend.entities.SystemLog.get('SystemLog_1')).message).toBe('do banco');
    const st = await backend.assetStates.upsert('outro', '4h', { direction: 1 });
    expect(st.id).not.toBe('AssetState_1');
    expect((await backend.entities.AssetState.get('AssetState_1')).asset_id).toBe('x');
  });

  it('o diário registra toda escrita e nenhuma leitura', async () => {
    const { backend, journal } = createSnapshotBackend({ TradeOperation: [liveOp()] });
    await backend.entities.TradeOperation.filter({});
    await backend.entities.TradeOperation.get('trade_old');
    expect(journal).toEqual([]);
    await backend.tradeOps.transitionTradeOp('trade_old', 'SIGNAL_CONFIRMED', { status: 'STOP_HIT' }, { assetId: 'a1' });
    await backend.entities.SignalEvent.createUnique('s1', { asset_id: 'a1' });
    expect(journal.map((j) => j.op)).toEqual(['transitionTradeOp', 'createUnique']);
    // Transição recusada pelo CAS não entra no diário (não escreveu nada).
    await backend.tradeOps.transitionTradeOp('trade_old', 'SIGNAL_CONFIRMED', { status: 'CLOSED' }, { assetId: 'a1' });
    expect(journal).toHaveLength(2);
  });

  it('entidade desconhecida ou linha sem id no retrato é recusada', () => {
    expect(() => createSnapshotBackend({ Coisa: [] })).toThrow(/desconhecida/);
    expect(() => createSnapshotBackend({ TradeOperation: [{ status: 'X' }] })).toThrow(/sem id/);
  });
});

describe('readOnlyProxy e exportSnapshot', () => {
  it('o proxy deixa ler e LANÇA em qualquer escrita', async () => {
    const raw = createFakeBackend();
    raw._seed('TradeOperation', liveOp());
    const ro = readOnlyProxy(raw);
    expect(await ro.entities.TradeOperation.list()).toHaveLength(1);
    for (const call of [
      () => ro.entities.TradeOperation.update('trade_old', { status: 'CLOSED' }),
      () => ro.entities.TradeOperation.create({}),
      () => ro.entities.SystemLog.bulkCreate([{}]),
      () => ro.tradeOps.transitionTradeOp('trade_old', 'SIGNAL_CONFIRMED', {}),
      () => ro.tradeOps.createTradeOpIfNoneActive('a1', 'x', {}),
      () => ro.assetStates.upsert('a1', '4h', {}),
      () => ro.locks.acquireScanLock('full-scan'),
    ]) await expect(call()).rejects.toThrow(/escrita proibida/);
    expect(raw._get('TradeOperation', 'trade_old').status).toBe('SIGNAL_CONFIRMED');
  });

  it('exportSnapshot lê todas as entidades do retrato só com list()', async () => {
    const raw = createFakeBackend();
    raw._seed('TradeOperation', liveOp());
    const snap = await exportSnapshot(readOnlyProxy(raw));
    expect(snap.TradeOperation).toHaveLength(1);
    expect(snap.SignalEvent).toEqual([]);
  });
});
