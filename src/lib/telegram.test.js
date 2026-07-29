// getTelegramFilters merges new default event IDs into filters saved BEFORE
// those events existed (Codex review, PR #60, known-risks.md item 29) — a
// saved `events` array missing invalidated/time_stop/chop_exit must not
// silently suppress those notifications forever.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

// setTelegramFilters syncs to Firestore (telegramFilters/current) via a
// dynamic import of '@/api/entities', mirroring pineParser.js's getPineConfig.
// vi.hoisted so the mock fn is assertable from test bodies below (a plain
// closure variable referenced inside vi.mock's factory would be hoisted out
// from under it).
const { telegramFiltersSetMock } = vi.hoisted(() => ({ telegramFiltersSetMock: vi.fn() }));
vi.mock('@/api/entities', () => ({
  backend: { entities: { TelegramFilters: { set: telegramFiltersSetMock } } },
}));

import { getTelegramFilters, notifyNewSignal, notifyTradeCreated, setTelegramFilters } from './telegram.js';

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  globalThis.localStorage = makeLocalStorage();
});

describe('getTelegramFilters', () => {
  it('returns DEFAULT_FILTERS (including the new events) when nothing is saved', () => {
    const filters = getTelegramFilters();
    expect(filters.events).toEqual(
      expect.arrayContaining(['invalidated', 'time_stop', 'chop_exit'])
    );
  });

  it('merges the new default events into a pre-existing saved filter set that predates them, and persists the migration', () => {
    localStorage.setItem('tg_filters', JSON.stringify({
      timeframes: ['1h', '4h', '1d'],
      min_priority: 'low',
      signal_types: ['BUY', 'SELL'],
      events: ['signal_detected', 'entry_confirmed', 'tp1_hit', 'tp2_hit', 'stop_hit'], // pre-2026-07-18 shape
      min_score: 0,
    }));

    const filters = getTelegramFilters();
    expect(filters.events).toEqual(
      expect.arrayContaining(['signal_detected', 'entry_confirmed', 'tp1_hit', 'tp2_hit', 'stop_hit', 'invalidated', 'time_stop', 'chop_exit'])
    );
    expect(filters.events).toHaveLength(8);

    // Migration must be written back — otherwise every future read would
    // treat the (still absent, by construction) new events as "old data"
    // again, forever re-adding them even after the user turns one off.
    const persisted = JSON.parse(localStorage.getItem('tg_filters'));
    expect(persisted._migratedEvents20260718).toBe(true);
  });

  it('does not re-add an event the user explicitly removed after the one-time migration ran', () => {
    localStorage.setItem('tg_filters', JSON.stringify({
      timeframes: ['1h', '4h', '1d'],
      min_priority: 'low',
      signal_types: ['BUY', 'SELL'],
      // Already migrated once; user has since deliberately turned time_stop off.
      events: ['signal_detected', 'entry_confirmed', 'tp1_hit', 'tp2_hit', 'stop_hit', 'invalidated', 'chop_exit'],
      min_score: 0,
      _migratedEvents20260718: true,
    }));

    const filters = getTelegramFilters();
    expect(filters.events).not.toContain('time_stop');
  });

  it('leaves non-array/malformed events untouched (falls through to the corrupted-JSON path is separate)', () => {
    localStorage.setItem('tg_filters', JSON.stringify({ min_priority: 'high' })); // no events key at all
    const filters = getTelegramFilters();
    expect(filters.events).toBeUndefined();
    expect(filters.min_priority).toBe('high');
  });
});

// Codex review (PR #65): notifyNewSignal used to hardcode "Novo Sinal RF
// Detectado" and `context.score || 0` for EVERY signal source. Harmless
// while smc_structure signals almost never reached here (smc_enabled
// defaulted to false) — but PR #65 turns that cascade on by default for
// new assets, making this a real, frequent mislabeling: an smc_structure
// signal (which never carries a score) would show "Score: 0/100" under a
// header claiming it's an RF signal, reading as "bad signal" when it's
// really just a different, unscored signal type.
describe('notifyNewSignal — source-aware label and score (Codex review, PR #65)', () => {
  beforeEach(() => {
    // isTelegramConfigured()/send() need a configured bot to actually call
    // fetch — otherwise send() returns before ever building the message.
    localStorage.setItem('cryptoradar_telegram_cfg', JSON.stringify({ botToken: 'x', chatId: 'y' }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
  });

  function baseSignal(overrides = {}) {
    return {
      symbol: 'BTCUSDT', timeframe: '1h', signal_type: 'BUY',
      price_at_signal: 100, reason: 'test reason', context: {},
      ...overrides,
    };
  }

  async function sentText(signal) {
    const before = global.fetch.mock.calls.length;
    await notifyNewSignal(signal);
    expect(global.fetch.mock.calls.length).toBe(before + 1);
    return JSON.parse(global.fetch.mock.calls[before][1].body).text;
  }

  it('labels a range_filter signal as RF and shows its real score', async () => {
    const text = await sentText(baseSignal({ source: 'range_filter', strength: 'strong', context: { score: 82 } }));
    expect(text).toContain('Novo Sinal RF Detectado');
    expect(text).toContain('Score: 82/100');
  });

  it('labels an smc_structure signal as SMC and never shows a fake 0/100 score', async () => {
    const text = await sentText(baseSignal({ source: 'smc_structure', strength: 'medium', context: { structure_type: 'BOS', pd_zone: 'discount' } }));
    expect(text).toContain('Novo Sinal SMC Detectado');
    expect(text).not.toContain('RF Detectado');
    expect(text).not.toContain('Score: 0/100');
  });

  it('labels macd/ema_cross/rsi signals with their own source instead of RF', async () => {
    expect(await sentText(baseSignal({ source: 'macd' }))).toContain('Novo Sinal MACD Detectado');
    expect(await sentText(baseSignal({ source: 'ema_cross' }))).toContain('Novo Sinal EMA Detectado');
    expect(await sentText(baseSignal({ source: 'rsi' }))).toContain('Novo Sinal RSI Detectado');
  });

  it('falls back to RF for an unrecognized/legacy source instead of throwing', async () => {
    const text = await sentText(baseSignal({ source: 'something_new' }));
    expect(text).toContain('Novo Sinal RF Detectado');
  });
});

describe('shouldSend — filtro de origem do sinal (RF/SMC/MACD/EMA/RSI)', () => {
  beforeEach(() => {
    localStorage.setItem('cryptoradar_telegram_cfg', JSON.stringify({ botToken: 'x', chatId: 'y' }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
  });

  function baseSignal(overrides = {}) {
    return {
      symbol: 'BTCUSDT', timeframe: '1h', signal_type: 'BUY', source: 'macd',
      price_at_signal: 100, reason: 'x', context: {},
      ...overrides,
    };
  }

  function saveFilters(overrides = {}) {
    localStorage.setItem('tg_filters', JSON.stringify({
      timeframes: ['1h', '4h', '1d'], min_priority: 'low', signal_types: ['BUY', 'SELL'],
      events: ['signal_detected', 'entry_confirmed'], min_score: 0,
      ...overrides,
    }));
  }

  it('não envia quando a origem do sinal está fora do filtro salvo', async () => {
    saveFilters({ sources: ['range_filter', 'smc_structure'] });
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('envia quando a origem está dentro do filtro salvo', async () => {
    saveFilters({ sources: ['macd'] });
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('REGRESSÃO — config salva ANTES desta feature (sem a chave sources) continua notificando todas as origens', async () => {
    saveFilters(); // sem 'sources' — exatamente o formato salvo antes desta mudança
    for (const source of ['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi']) {
      global.fetch.mockClear();
      await notifyNewSignal(baseSignal({ source }));
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('sem NENHUM filtro salvo (DEFAULT_FILTERS), as 5 origens notificam', async () => {
    for (const source of ['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi']) {
      global.fetch.mockClear();
      await notifyNewSignal(baseSignal({ source }));
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('origem DESCONHECIDA nunca é filtrada, mesmo com um filtro restritivo salvo — fail-open, igual ao fallback de rótulo já existente', async () => {
    saveFilters({ sources: ['range_filter'] }); // só RF liberado
    await notifyNewSignal(baseSignal({ source: 'um_source_futuro_que_ainda_nao_existe' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('o filtro de origem NÃO se aplica a eventos de operação — TradeOperation.source é um vocabulário diferente', async () => {
    // op.source aqui é 'manual' (enum de TradeOperation) — não pode colidir
    // com um filtro de 'sources' pensado para SignalEvent.source.
    saveFilters({ sources: ['range_filter'], events: ['entry_confirmed'] });
    await notifyTradeCreated({
      symbol: 'BTCUSDT', side: 'BUY', timeframe: '15m', signal_timeframe: '4h', entry_price: 100,
      initial_stop: 95, tp1: 105, tp2: 110, score: 80, source: 'manual',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('setTelegramFilters — sincroniza a origem com o canal 24h via Firestore', () => {
  beforeEach(() => {
    telegramFiltersSetMock.mockReset();
    telegramFiltersSetMock.mockResolvedValue(undefined);
  });

  it('grava no localStorage e chama TelegramFilters.set com os sources', async () => {
    await setTelegramFilters({ timeframes: ['1h'], sources: ['macd', 'rsi'] });
    expect(JSON.parse(localStorage.getItem('tg_filters')).sources).toEqual(['macd', 'rsi']);
    expect(telegramFiltersSetMock).toHaveBeenCalledWith('current', { sources: ['macd', 'rsi'] });
  });

  it('usa o default (todas as 5 origens) quando filters.sources está ausente', async () => {
    await setTelegramFilters({ timeframes: ['1h'] });
    expect(telegramFiltersSetMock).toHaveBeenCalledWith('current', {
      sources: expect.arrayContaining(['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi']),
    });
  });

  it('falha ao sincronizar com o Firestore não impede o localStorage de ser gravado', async () => {
    telegramFiltersSetMock.mockRejectedValueOnce(new Error('offline'));
    await setTelegramFilters({ sources: ['rsi'] });
    expect(JSON.parse(localStorage.getItem('tg_filters')).sources).toEqual(['rsi']);
  });
});

describe('shouldSend — override por ativo (known-risks item 47)', () => {
  beforeEach(() => {
    localStorage.setItem('cryptoradar_telegram_cfg', JSON.stringify({ botToken: 'x', chatId: 'y' }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
  });

  function baseSignal(overrides = {}) {
    return {
      symbol: 'ETHUSDT', timeframe: '1h', signal_type: 'BUY', source: 'macd',
      price_at_signal: 100, reason: 'x', context: {},
      ...overrides,
    };
  }

  it('asset.notify_sources SUBSTITUI o filtro global (não combina) — global permite tudo, ativo restringe', async () => {
    // Filtro global: tudo liberado (default). O ativo restringe sozinho.
    await notifyNewSignal(baseSignal({ source: 'macd' }), { notify_sources: ['range_filter'] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('asset.notify_sources pode LIBERAR uma origem que o filtro global bloqueia', async () => {
    localStorage.setItem('tg_filters', JSON.stringify({
      timeframes: ['1h', '4h', '1d'], min_priority: 'low', signal_types: ['BUY', 'SELL'],
      events: ['signal_detected'], min_score: 0, sources: ['range_filter'], // global só RF
    }));
    await notifyNewSignal(baseSignal({ source: 'macd' }), { notify_sources: ['macd'] }); // ativo libera MACD
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('asset.notify_signal_types SUBSTITUI o filtro global de lado, também', async () => {
    await notifyNewSignal(baseSignal({ signal_type: 'BUY' }), { notify_signal_types: ['SELL'] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sem asset (ou sem os campos), continua herdando 100% do filtro global — regressão', async () => {
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    global.fetch.mockClear();
    await notifyNewSignal(baseSignal({ source: 'macd' }), {}); // asset existe mas sem os 2 campos
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('array vazio é um estado válido — silencia o ativo por completo, de propósito ("nada do ETH")', async () => {
    await notifyNewSignal(baseSignal(), { notify_sources: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('o override por ativo NÃO vaza para eventos de operação (entry/TP/stop) — só rege o alerta de novo sinal', async () => {
    localStorage.setItem('tg_filters', JSON.stringify({
      timeframes: ['1h', '4h', '1d'], min_priority: 'low', signal_types: ['BUY', 'SELL'],
      events: ['entry_confirmed'], min_score: 0,
    }));
    // asset.notify_signal_types restringe a BUY — mas isto é uma notificação
    // de operação (SELL), que deve ignorar o override do ativo por completo.
    await notifyTradeCreated({
      symbol: 'ETHUSDT', side: 'SELL', timeframe: '15m', signal_timeframe: '4h', entry_price: 100,
      initial_stop: 105, tp1: 95, tp2: 90, score: 80, source: 'manual',
    }, { notify_signal_types: ['BUY'] });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
