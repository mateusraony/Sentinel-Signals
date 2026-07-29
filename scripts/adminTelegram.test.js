// Cobre o filtro de origem do sinal (RF/SMC/MACD/EMA/RSI) lido do Firestore
// (telegramFilters/current) — o espelho admin de src/lib/telegram.test.js's
// "shouldSend — filtro de origem do sinal". adminTelegram.js não tinha
// nenhum teste antes desta mudança (é um espelho fino, sem lógica própria);
// este arquivo nasce cobrindo especificamente a parte nova: a leitura do
// Firestore, memoizada por processo, e o fail-open em cada caminho de erro.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { firestoreGetMock } = vi.hoisted(() => ({ firestoreGetMock: vi.fn() }));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: () => ({ doc: () => ({ get: firestoreGetMock }) }),
  }),
}));

function snap(sources) {
  return sources === undefined
    ? { exists: false }
    : { exists: true, data: () => ({ sources }) };
}

function baseSignal(overrides = {}) {
  return {
    symbol: 'BTCUSDT', timeframe: '1h', signal_type: 'BUY', source: 'macd',
    price_at_signal: 100, reason: 'x', context: {},
    ...overrides,
  };
}

beforeEach(() => {
  // vi.resetModules() + dynamic import por teste: sourcesPromise é memoizado
  // no escopo do módulo (de propósito — uma leitura por PROCESSO real do
  // scan), então cada teste precisa da sua própria instância do módulo para
  // não herdar o cache de um teste anterior.
  vi.resetModules();
  firestoreGetMock.mockReset();
  process.env.TELEGRAM_BOT_TOKEN = 'x';
  process.env.TELEGRAM_CHAT_ID = 'y';
  global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
});

describe('adminTelegram — filtro de origem do sinal (lido de telegramFilters/current)', () => {
  it('não notifica quando a origem está fora do doc salvo no Firestore', async () => {
    firestoreGetMock.mockResolvedValue(snap(['range_filter']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('notifica quando a origem está dentro do doc salvo', async () => {
    firestoreGetMock.mockResolvedValue(snap(['macd']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('doc ausente (usuário nunca abriu Configurações) = todas as 5 origens — fail-open', async () => {
    firestoreGetMock.mockResolvedValue(snap(undefined));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    for (const source of ['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi']) {
      global.fetch.mockClear();
      await notifyNewSignal(baseSignal({ source }));
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('erro ao ler o Firestore nunca silencia o canal — fail-open para todas as origens', async () => {
    firestoreGetMock.mockRejectedValue(new Error('offline'));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('origem DESCONHECIDA nunca é filtrada, mesmo com um doc restritivo salvo', async () => {
    firestoreGetMock.mockResolvedValue(snap(['range_filter']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'um_source_futuro_que_ainda_nao_existe' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('memoiza por processo — duas notificações no mesmo import leem o Firestore uma vez só', async () => {
    firestoreGetMock.mockResolvedValue(snap(['macd', 'rsi']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    await notifyNewSignal(baseSignal({ source: 'rsi' }));
    expect(firestoreGetMock).toHaveBeenCalledTimes(1);
  });

  it('o filtro NÃO se aplica a eventos de operação — TradeOperation.source é vocabulário diferente', async () => {
    firestoreGetMock.mockResolvedValue(snap(['range_filter']));
    const { notifyTradeCreated } = await import('./adminTelegram.js');
    await notifyTradeCreated({
      symbol: 'BTCUSDT', side: 'BUY', timeframe: '15m', signal_timeframe: '4h', entry_price: 100,
      initial_stop: 95, tp1: 105, tp2: 110, score: 80, source: 'manual',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // Confirma que nem chegou a consultar o Firestore para este evento —
    // o guard de evento (signal_detected) descarta antes disso.
    expect(firestoreGetMock).not.toHaveBeenCalled();
  });
});

describe('adminTelegram — override por ativo (known-risks item 47)', () => {
  it('asset.notify_sources SUBSTITUI o filtro global, e evita ler o Firestore', async () => {
    firestoreGetMock.mockResolvedValue(snap(['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi'])); // global libera tudo
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }), { notify_sources: ['range_filter'] });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(firestoreGetMock).not.toHaveBeenCalled(); // override por ativo decide sozinho, sem precisar do doc global
  });

  it('asset.notify_sources pode LIBERAR uma origem que o Firestore global bloqueia', async () => {
    firestoreGetMock.mockResolvedValue(snap(['range_filter'])); // global só RF
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }), { notify_sources: ['macd'] });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('asset.notify_signal_types SUBSTITUI o filtro global de lado', async () => {
    firestoreGetMock.mockResolvedValue(snap(['macd']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd', signal_type: 'BUY' }), { notify_signal_types: ['SELL'] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sem asset, continua herdando 100% do filtro global lido do Firestore — regressão', async () => {
    firestoreGetMock.mockResolvedValue(snap(['macd']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('array vazio silencia o ativo por completo — estado válido, não erro', async () => {
    firestoreGetMock.mockResolvedValue(snap(['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal(), { notify_sources: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

