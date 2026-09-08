// Integração contra Postgres REAL — mesmo padrão de db/schema.test.js e
// db/concurrency.test.js (gated por TEST_DATABASE_URL). Este arquivo testa
// o ADAPTADOR de verdade (db/pgEntitiesCore.mjs), não SQL cru — a prova de
// que o mecanismo do banco funciona já está em db/concurrency.test.js; aqui
// é "createTradeOpIfNoneActive/transitionTradeOp REAIS produzem o resultado
// certo", incluindo concorrência com 2 conexões distintas de verdade.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { applySchema } from './migrate.mjs';
import { backend, getPool, closePool, bulkImportEntity } from './pgEntitiesCore.mjs';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('db/pgEntitiesCore.mjs', () => {
  beforeAll(async () => {
    await applySchema(TEST_DATABASE_URL);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    const pool = getPool(TEST_DATABASE_URL);
    await pool.query('TRUNCATE monitored_assets, asset_states, signal_events, trade_operations, price_alerts, system_logs, users, verification_tasks, strategy_config, telegram_filters, scanner_locks');
  });

  describe('CRUD genérico (entities.<Nome>)', () => {
    it('create + get devolvem o mesmo shape { id, ...campos }, com created_date preenchido', async () => {
      const created = await backend.entities.MonitoredAsset.create({ symbol: 'BTCUSDT', is_active: true });
      expect(created.symbol).toBe('BTCUSDT');
      expect(created.created_date).toBeTruthy();
      const fetched = await backend.entities.MonitoredAsset.get(created.id);
      expect(fetched).toEqual(created);
    });

    it('filter por igualdade usa a coluna tipada quando existe', async () => {
      await backend.entities.MonitoredAsset.create({ symbol: 'BTCUSDT', is_active: true });
      await backend.entities.MonitoredAsset.create({ symbol: 'ETHUSDT', is_active: false });
      const active = await backend.entities.MonitoredAsset.filter({ is_active: true });
      expect(active).toHaveLength(1);
      expect(active[0].symbol).toBe('BTCUSDT');
    });

    it('filter por campo NÃO tipado cai no fallback data->>campo, sem quebrar', async () => {
      await backend.entities.SignalEvent.create({ symbol: 'BTCUSDT', last_rejection_reason: 'no_trigger' });
      await backend.entities.SignalEvent.create({ symbol: 'BTCUSDT', last_rejection_reason: 'regime_rejected' });
      const rows = await backend.entities.SignalEvent.filter({ last_rejection_reason: 'no_trigger' });
      expect(rows).toHaveLength(1);
      expect(rows[0].last_rejection_reason).toBe('no_trigger');
    });

    it('filter com array vira IN', async () => {
      await backend.entities.VerificationTask.create({ priority: 'high', status: 'pending' });
      await backend.entities.VerificationTask.create({ priority: 'low', status: 'pending' });
      await backend.entities.VerificationTask.create({ priority: 'high', status: 'done' });
      const rows = await backend.entities.VerificationTask.filter({ status: ['pending'] });
      expect(rows).toHaveLength(2);
    });

    it('sort e limit funcionam (order -created_date)', async () => {
      await backend.entities.SystemLog.create({ level: 'info', created_date: '2026-01-01T00:00:00.000Z' });
      const middle = await backend.entities.SystemLog.create({ level: 'info', created_date: '2026-01-02T00:00:00.000Z' });
      const newest = await backend.entities.SystemLog.create({ level: 'info', created_date: '2026-01-03T00:00:00.000Z' });
      const rows = await backend.entities.SystemLog.list('-created_date', 2);
      expect(rows.map((r) => r.id)).toEqual([newest.id, middle.id]);
    });

    it('update faz merge raso, preservando campos não mencionados', async () => {
      const created = await backend.entities.TradeOperation.create({ symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED', tier: 'A' });
      const updated = await backend.entities.TradeOperation.update(created.id, { status: 'RUNNER_ACTIVE' });
      expect(updated.status).toBe('RUNNER_ACTIVE');
      const fetched = await backend.entities.TradeOperation.get(created.id);
      expect(fetched.tier).toBe('A'); // preservado
      expect(fetched.status).toBe('RUNNER_ACTIVE');
    });

    it('set faz merge PROFUNDO (deepMergeFirestore), preservando chaves irmãs em objeto aninhado', async () => {
      await backend.entities.TelegramFilters.set('current', { sources: { rf: true, macd: true } });
      await backend.entities.TelegramFilters.set('current', { sources: { macd: false } });
      const [doc] = await backend.entities.TelegramFilters.filter({});
      expect(doc.sources).toEqual({ rf: true, macd: false });
    });

    it('createUnique é create-if-absent atômico por id determinístico', async () => {
      const first = await backend.entities.TradeOperation.createUnique('trade_fixed_id', { symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' });
      expect(first.created).toBe(true);
      const second = await backend.entities.TradeOperation.createUnique('trade_fixed_id', { symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' });
      expect(second.created).toBe(false);
      expect(second.existing.id).toBe('trade_fixed_id');
    });

    it('delete remove o doc', async () => {
      const created = await backend.entities.PriceAlert.create({});
      await backend.entities.PriceAlert.delete(created.id);
      expect(await backend.entities.PriceAlert.get(created.id)).toBeNull();
    });

    it('bulkCreate cria todos e deleteMany devolve os docs deletados', async () => {
      const created = await backend.entities.VerificationTask.bulkCreate([
        { priority: 'high', status: 'pending' },
        { priority: 'low', status: 'pending' },
      ]);
      expect(created).toHaveLength(2);
      const deleted = await backend.entities.VerificationTask.deleteMany({ status: 'pending' });
      expect(deleted.map((d) => d.id).sort()).toEqual(created.map((d) => d.id).sort());
      expect(await backend.entities.VerificationTask.list()).toHaveLength(0);
    });

    it('rejeita undefined em qualquer profundidade, mesma mensagem do guard compartilhado', async () => {
      await expect(backend.entities.TradeOperation.create({ symbol: 'X', tier: undefined }))
        .rejects.toThrow(/Cannot use "undefined" as a Firestore value/);
    });

    // Achado do sentinel-security-review: `data->>'campo'` não tem
    // placeholder de NOME de coluna no Postgres — sem validar o field
    // antes de interpolar, um filtro malicioso vindo de
    // GET /api/entities/:collection?filters=... seria injeção de SQL de
    // verdade. Testado contra Postgres REAL — se a validação regredir, a
    // query mal-formada falharia de um jeito visível aqui, não silencioso.
    it('rejeita nome de campo malicioso num filtro em vez de interpolar na query SQL', async () => {
      await backend.entities.MonitoredAsset.create({ symbol: 'BTCUSDT' });
      await expect(backend.entities.MonitoredAsset.filter({ "x'); DROP TABLE monitored_assets;--": 1 }))
        .rejects.toThrow(/Nome de campo inválido/);
      // A tabela sobrevive — a proteção rejeitou ANTES de montar a query.
      expect(await backend.entities.MonitoredAsset.list()).toHaveLength(1);
    });

    it('rejeita nome de campo malicioso em sort', async () => {
      await expect(backend.entities.MonitoredAsset.list("x'); DROP TABLE monitored_assets;--"))
        .rejects.toThrow(/Nome de campo inválido/);
    });
  });

  // Fase 7 (scripts/migrate-firestore-to-postgres.mjs) — diferente de
  // bulkCreate() (testado acima), que sempre gera um id novo, esta função
  // PRESERVA o id de cada item (reaproveita o ID do documento Firestore) e
  // faz upsert (ON CONFLICT DO UPDATE), não insert-if-absent.
  describe('bulkImportEntity (migração — preserva id, upsert)', () => {
    it('preserva o id de cada item em vez de gerar um novo', async () => {
      await bulkImportEntity('MonitoredAsset', [
        { id: 'firestore-doc-id-1', symbol: 'BTCUSDT', is_active: true },
      ]);
      const fetched = await backend.entities.MonitoredAsset.get('firestore-doc-id-1');
      expect(fetched).toEqual({ id: 'firestore-doc-id-1', symbol: 'BTCUSDT', is_active: true });
    });

    it('rodar duas vezes com dados diferentes converge para o snapshot mais recente (upsert, não no-op)', async () => {
      await bulkImportEntity('TradeOperation', [{ id: 'op-1', asset_id: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' }]);
      await bulkImportEntity('TradeOperation', [{ id: 'op-1', asset_id: 'BTCUSDT', status: 'RUNNER_ACTIVE' }]);
      const fetched = await backend.entities.TradeOperation.get('op-1');
      expect(fetched.status).toBe('RUNNER_ACTIVE');
      expect(await backend.entities.TradeOperation.list()).toHaveLength(1);
    });

    it('lista vazia não toca o banco (0 upserts, sem erro)', async () => {
      const result = await bulkImportEntity('SignalEvent', []);
      expect(result).toEqual({ upserted: 0 });
      expect(await backend.entities.SignalEvent.list()).toHaveLength(0);
    });

    it('item sem id lança um erro claro em vez de silenciosamente gerar um novo', async () => {
      await expect(bulkImportEntity('MonitoredAsset', [{ symbol: 'BTCUSDT' }])).rejects.toThrow(/item sem id/);
    });

    // Prova a análise do comentário de bulkImportEntity: uma op ATIVA
    // migrada com active_ops_anchor NULL já bloqueia corretamente uma nova
    // criação para o mesmo ativo — o CAS lê status/asset_id, não a âncora.
    it('uma TradeOperation ativa migrada (active_ops_anchor NULL) bloqueia createTradeOpIfNoneActive para o mesmo ativo', async () => {
      await bulkImportEntity('TradeOperation', [
        { id: 'migrated-op-1', asset_id: 'BTCUSDT', symbol: 'BTCUSDT', status: 'RUNNER_ACTIVE', side: 'BUY' },
      ]);
      const result = await backend.tradeOps.createTradeOpIfNoneActive('BTCUSDT', 'new-op-2', { symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' });
      expect(result.created).toBe(false);
      expect(result.existingId).toBe('migrated-op-1');
      expect(await backend.entities.TradeOperation.list()).toHaveLength(1);
    });
  });

  describe('locks (acquireScanLock/releaseScanLock)', () => {
    it('só um chamador adquire por vez; libera corretamente', async () => {
      expect(await backend.locks.acquireScanLock('scan', 60_000, 'holder-a')).toBe(true);
      expect(await backend.locks.acquireScanLock('scan', 60_000, 'holder-b')).toBe(false);
      await backend.locks.releaseScanLock('scan', 'holder-a');
      expect(await backend.locks.acquireScanLock('scan', 60_000, 'holder-b')).toBe(true);
    });
  });

  describe('tradeOps — CAS real, incluindo concorrência com 2 conexões distintas', () => {
    it('createTradeOpIfNoneActive cria em slate limpo, bloqueia uma 2ª tentativa não-hierárquica', async () => {
      const first = await backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-a', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' });
      expect(first.created).toBe(true);
      const second = await backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-b', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' });
      expect(second.created).toBe(false);
      expect(second.existingId).toBe('op-a');
    });

    it('retry pelo MESMO docId (já ativo) resolve para reuse, nunca duplica', async () => {
      await backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-a', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' });
      const retry = await backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-a', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' });
      expect(retry.created).toBe(false);
      expect(retry.existing.id).toBe('op-a');
    });

    it('nunca reaponta pra op terminal — retry após STOP_HIT cria uma op nova', async () => {
      await backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-a', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' });
      await backend.tradeOps.transitionTradeOp('op-a', 'SIGNAL_CONFIRMED', { status: 'STOP_HIT' });
      const created = await backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-b', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' });
      expect(created.created).toBe(true);
    });

    it('CONCORRÊNCIA REAL: exatamente 1 de 2 chamadas simultâneas cria a op (25x)', async () => {
      for (let i = 0; i < 25; i++) {
        const assetId = `race-${i}`;
        const [a, b] = await Promise.all([
          backend.tradeOps.createTradeOpIfNoneActive(assetId, `op-${i}-a`, { asset_id: assetId, symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' }),
          backend.tradeOps.createTradeOpIfNoneActive(assetId, `op-${i}-b`, { asset_id: assetId, symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' }),
        ]);
        const createdCount = [a.created, b.created].filter(Boolean).length;
        expect(createdCount).toBe(1);
      }
    });

    it('transitionTradeOp aplica CAS por status, rejeita a partir de terminal, limpa active_ops_anchor', async () => {
      await backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-a', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED', side: 'BUY' });
      const applied = await backend.tradeOps.transitionTradeOp('op-a', 'SIGNAL_CONFIRMED', { status: 'STOP_HIT' });
      expect(applied.applied).toBe(true);
      const rejected = await backend.tradeOps.transitionTradeOp('op-a', 'SIGNAL_CONFIRMED', { status: 'RUNNER_ACTIVE' });
      expect(rejected.applied).toBe(false); // já terminal

      // Ativo liberado — uma nova op consegue ser criada.
      const created = await backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-b', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' });
      expect(created.created).toBe(true);
    });

    it('transitionTradeOp: current_stop nunca regride sob concorrência (clampMonotonicStop real)', async () => {
      await backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-a', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'RUNNER_ACTIVE', side: 'BUY', current_stop: 100 });
      const [workerA, workerB] = await Promise.all([
        backend.tradeOps.transitionTradeOp('op-a', 'RUNNER_ACTIVE', { status: 'RUNNER_ACTIVE', current_stop: 105 }),
        backend.tradeOps.transitionTradeOp('op-a', 'RUNNER_ACTIVE', { status: 'RUNNER_ACTIVE', current_stop: 102 }),
      ]);
      expect(workerA.applied).toBe(true);
      expect(workerB.applied).toBe(true); // status-only CAS deixa passar
      const final = await backend.entities.TradeOperation.get('op-a');
      expect(final.current_stop).toBe(105); // nunca regride pro pior valor
    });

    it('duas cascatas hierárquicas diferentes coexistem no mesmo ativo (concorrência real)', async () => {
      const [a, b] = await Promise.all([
        backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-4h15m', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED', hierarchical_cascade: true }, '4h_15m'),
        backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-1h5m', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED', hierarchical_cascade: true }, '1h_5m'),
      ]);
      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
    });

    it('clearActiveOp é no-op — não lança, não afeta nenhuma linha', async () => {
      await backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-a', { asset_id: 'asset-1', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' });
      await expect(backend.tradeOps.clearActiveOp('asset-1', 'op-a')).resolves.toBeUndefined();
      const stillThere = await backend.entities.TradeOperation.get('op-a');
      expect(stillThere.status).toBe('SIGNAL_CONFIRMED');
    });
  });
});
