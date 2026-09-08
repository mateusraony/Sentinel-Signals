// Testa a tradução pura de src/api/entitiesPostgres.js — cada método vira UMA
// chamada a callBackend() (src/lib/apiBackend.js) com o path/método/corpo
// certos. `callBackend` é mockado aqui (não `global.fetch`): é o mesmo padrão
// já usado por src/lib/telegram.test.js para src/api/entities.js — mockar a
// dependência imediata, não a pilha inteira (fetch real exigiria também
// simular auth.currentUser.getIdToken() e VITE_BACKEND_URL, que já são
// responsabilidade de apiBackend.js, não deste arquivo). `callBackend` em si
// já é exercitado pelos consumidores reais de src/lib/apiBackend.js (rotas de
// backtest/telegram-notify) contra o servidor real em produção.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callBackendMock } = vi.hoisted(() => ({ callBackendMock: vi.fn() }));
vi.mock('@/lib/apiBackend', () => ({ callBackend: callBackendMock }));

const { backend } = await import('./entitiesPostgres.js');

beforeEach(() => {
  callBackendMock.mockReset();
  callBackendMock.mockResolvedValue({ ok: true });
});

describe('entitiesPostgres — backend.entities.<Nome>', () => {
  it('list() faz GET sem filtros, com sort/limit na querystring', async () => {
    await backend.entities.MonitoredAsset.list('-created_date', 10);
    expect(callBackendMock).toHaveBeenCalledWith(
      '/api/entities/MonitoredAsset?sort=-created_date&limit=10',
      undefined,
      { method: 'GET' },
    );
  });

  it('list() sem sort/limit não inclui querystring', async () => {
    await backend.entities.MonitoredAsset.list();
    expect(callBackendMock).toHaveBeenCalledWith('/api/entities/MonitoredAsset', undefined, { method: 'GET' });
  });

  it('filter() serializa o objeto de filtros como JSON em ?filters=', async () => {
    await backend.entities.SignalEvent.filter({ symbol: 'BTCUSDT', notified: false }, 'created_date', 5);
    const [path, body, options] = callBackendMock.mock.calls[0];
    expect(options).toEqual({ method: 'GET' });
    expect(body).toBeUndefined();
    expect(path).toContain('/api/entities/SignalEvent?');
    const qs = new URLSearchParams(path.split('?')[1]);
    expect(JSON.parse(qs.get('filters'))).toEqual({ symbol: 'BTCUSDT', notified: false });
    expect(qs.get('sort')).toBe('created_date');
    expect(qs.get('limit')).toBe('5');
  });

  it('filter() com objeto vazio omite ?filters=', async () => {
    await backend.entities.SignalEvent.filter({});
    expect(callBackendMock).toHaveBeenCalledWith('/api/entities/SignalEvent', undefined, { method: 'GET' });
  });

  it('get() encontrado devolve o documento (allow404 habilitado)', async () => {
    callBackendMock.mockResolvedValueOnce({ id: 'op-1', status: 'RUNNER_ACTIVE' });
    const result = await backend.entities.TradeOperation.get('op-1');
    expect(callBackendMock).toHaveBeenCalledWith('/api/entities/TradeOperation/op-1', undefined, { method: 'GET', allow404: true });
    expect(result).toEqual({ id: 'op-1', status: 'RUNNER_ACTIVE' });
  });

  it('get() de documento inexistente devolve null (não lança) — mesmo contrato do Firestore original', async () => {
    callBackendMock.mockResolvedValueOnce(null);
    const result = await backend.entities.TradeOperation.get('missing');
    expect(result).toBeNull();
  });

  it('set() faz POST em /:id/set com o corpo bruto', async () => {
    await backend.entities.StrategyConfig.set('current', { rf_period: 20 });
    expect(callBackendMock).toHaveBeenCalledWith('/api/entities/StrategyConfig/current/set', { rf_period: 20 });
  });

  it('create() faz POST na coleção com o corpo bruto', async () => {
    await backend.entities.SignalEvent.create({ symbol: 'ETHUSDT' });
    expect(callBackendMock).toHaveBeenCalledWith('/api/entities/SignalEvent', { symbol: 'ETHUSDT' });
  });

  it('createUnique() faz POST em /:id/unique', async () => {
    await backend.entities.SystemLog.createUnique('dedup-key', { level: 'warn' });
    expect(callBackendMock).toHaveBeenCalledWith('/api/entities/SystemLog/dedup-key/unique', { level: 'warn' });
  });

  it('update() faz PATCH em /:id', async () => {
    await backend.entities.TradeOperation.update('op-1', { current_stop: 100 });
    expect(callBackendMock).toHaveBeenCalledWith('/api/entities/TradeOperation/op-1', { current_stop: 100 }, { method: 'PATCH' });
  });

  it('delete() faz DELETE em /:id sem corpo', async () => {
    await backend.entities.PriceAlert.delete('alert-1');
    expect(callBackendMock).toHaveBeenCalledWith('/api/entities/PriceAlert/alert-1', undefined, { method: 'DELETE' });
  });

  it('bulkCreate() faz POST em /bulk com o array bruto', async () => {
    const items = [{ symbol: 'A' }, { symbol: 'B' }];
    await backend.entities.MonitoredAsset.bulkCreate(items);
    expect(callBackendMock).toHaveBeenCalledWith('/api/entities/MonitoredAsset/bulk', items);
  });

  it('deleteMany() faz POST em /delete-many com o objeto de filtros', async () => {
    await backend.entities.SystemLog.deleteMany({ level: 'debug' });
    expect(callBackendMock).toHaveBeenCalledWith('/api/entities/SystemLog/delete-many', { level: 'debug' });
  });
});

describe('entitiesPostgres — backend.locks', () => {
  it('acquireScanLock() desembrulha { acquired } do corpo da resposta', async () => {
    callBackendMock.mockResolvedValueOnce({ acquired: true });
    const acquired = await backend.locks.acquireScanLock('full-scan', 60000, 'holder-1');
    expect(callBackendMock).toHaveBeenCalledWith('/api/locks/acquire', { lockName: 'full-scan', ttlMs: 60000, holder: 'holder-1' });
    expect(acquired).toBe(true);
  });

  it('releaseScanLock() faz POST e não devolve nada', async () => {
    const result = await backend.locks.releaseScanLock('full-scan', 'holder-1');
    expect(callBackendMock).toHaveBeenCalledWith('/api/locks/release', { lockName: 'full-scan', holder: 'holder-1' });
    expect(result).toBeUndefined();
  });
});

describe('entitiesPostgres — backend.tradeOps', () => {
  it('createTradeOpIfNoneActive() repassa os 4 argumentos posicionais no corpo', async () => {
    const data = { symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' };
    await backend.tradeOps.createTradeOpIfNoneActive('asset-1', 'op-1', data, 'rf');
    expect(callBackendMock).toHaveBeenCalledWith('/api/trade-ops/create-if-none-active', {
      assetId: 'asset-1', docId: 'op-1', data, cascade: 'rf',
    });
  });

  it('transitionTradeOp() repassa opId na URL e o resto no corpo, incluindo as options', async () => {
    const patch = { status: 'TP2_HIT' };
    await backend.tradeOps.transitionTradeOp('op-1', 'RUNNER_ACTIVE', patch, {
      assetId: 'asset-1', stopAdvanceMarkerField: 'runner_stop_advanced_candle_time', cascade: 'rf',
    });
    expect(callBackendMock).toHaveBeenCalledWith('/api/trade-ops/op-1/transition', {
      fromStatus: 'RUNNER_ACTIVE',
      patch,
      assetId: 'asset-1',
      stopAdvanceMarkerField: 'runner_stop_advanced_candle_time',
      cascade: 'rf',
    });
  });

  it('transitionTradeOp() funciona sem options (todas as chaves opcionais viram undefined)', async () => {
    await backend.tradeOps.transitionTradeOp('op-1', 'SIGNAL_CONFIRMED', { status: 'STOP_HIT' });
    expect(callBackendMock).toHaveBeenCalledWith('/api/trade-ops/op-1/transition', {
      fromStatus: 'SIGNAL_CONFIRMED',
      patch: { status: 'STOP_HIT' },
      assetId: undefined,
      stopAdvanceMarkerField: undefined,
      cascade: undefined,
    });
  });

  it('clearActiveOp() faz POST em /clear-active', async () => {
    await backend.tradeOps.clearActiveOp('asset-1', 'op-1', 'rf');
    expect(callBackendMock).toHaveBeenCalledWith('/api/trade-ops/clear-active', { assetId: 'asset-1', tradeOpId: 'op-1', cascade: 'rf' });
  });
});

describe('entitiesPostgres — backend.quota', () => {
  it('getAndResetOpCounts() é um stub local — nunca chama a rede', () => {
    expect(backend.quota.getAndResetOpCounts()).toEqual({ reads: 0, writes: 0 });
    expect(callBackendMock).not.toHaveBeenCalled();
  });
});
