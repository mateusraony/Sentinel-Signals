// Cobre o filtro de origem do sinal (RF/SMC/MACD/EMA/RSI, lido de
// TelegramFilters/'current') e o fallback de log no SystemLog — o espelho
// admin de src/lib/telegram.test.js's "shouldSend — filtro de origem do
// sinal". adminTelegram.js não tinha nenhum teste antes desta mudança (é um
// espelho fino, sem lógica própria); este arquivo nasce cobrindo
// especificamente a parte nova: a leitura memoizada por processo, e o
// fail-open em cada caminho de erro.
//
// Fase 10 do plano de migração Firestore→Neon: TelegramFilters/SystemLog
// migraram de Firestore direto pra backend (Postgres, scripts/
// adminEntities.js) — mockado abaixo via `./adminEntities.js`. O marcador
// de dedup de cota (notifyFirestoreQuotaExhausted, descrição no fim do
// arquivo) continua Firestore/RTDB, fora desta migração — mockado via
// `firebase-admin/firestore` como antes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { firestoreGetMock, firestoreSetMock, getFirestoreMock } = vi.hoisted(() => {
  const firestoreGetMock = vi.fn();
  const firestoreSetMock = vi.fn();
  const getFirestoreMock = vi.fn(() => ({
    collection: () => ({ doc: () => ({ get: firestoreGetMock, set: firestoreSetMock }) }),
  }));
  return { firestoreGetMock, firestoreSetMock, getFirestoreMock };
});
vi.mock('firebase-admin/firestore', () => ({ getFirestore: getFirestoreMock }));

const { telegramFiltersGetMock, systemLogCreateMock } = vi.hoisted(() => ({
  telegramFiltersGetMock: vi.fn(),
  systemLogCreateMock: vi.fn(),
}));
vi.mock('./adminEntities.js', () => ({
  backend: {
    entities: {
      TelegramFilters: { get: telegramFiltersGetMock },
      SystemLog: { create: systemLogCreateMock },
    },
  },
}));

// Postgres get() contrato: null = ausente, { id, ...campos } = presente —
// diferente do snapshot Firestore ({exists, data()}) que este arquivo usava
// antes da Fase 10.
function doc(sources) {
  return sources === undefined ? null : { id: 'current', sources };
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
  firestoreSetMock.mockReset();
  firestoreSetMock.mockResolvedValue(undefined);
  getFirestoreMock.mockReset();
  getFirestoreMock.mockImplementation(() => ({
    collection: () => ({ doc: () => ({ get: firestoreGetMock, set: firestoreSetMock }) }),
  }));
  telegramFiltersGetMock.mockReset();
  systemLogCreateMock.mockReset();
  systemLogCreateMock.mockResolvedValue(undefined);
  process.env.TELEGRAM_BOT_TOKEN = 'x';
  process.env.TELEGRAM_CHAT_ID = 'y';
  global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
});

describe('adminTelegram — filtro de origem do sinal (lido de TelegramFilters/current)', () => {
  it('não notifica quando a origem está fora do doc salvo', async () => {
    telegramFiltersGetMock.mockResolvedValue(doc(['range_filter']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('notifica quando a origem está dentro do doc salvo', async () => {
    telegramFiltersGetMock.mockResolvedValue(doc(['macd']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('doc ausente (usuário nunca abriu Configurações) = todas as 5 origens — fail-open', async () => {
    telegramFiltersGetMock.mockResolvedValue(doc(undefined));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    for (const source of ['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi']) {
      global.fetch.mockClear();
      await notifyNewSignal(baseSignal({ source }));
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('erro ao ler o backend nunca silencia o canal — fail-open para todas as origens', async () => {
    telegramFiltersGetMock.mockRejectedValue(new Error('offline'));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('origem DESCONHECIDA nunca é filtrada, mesmo com um doc restritivo salvo', async () => {
    telegramFiltersGetMock.mockResolvedValue(doc(['range_filter']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'um_source_futuro_que_ainda_nao_existe' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('memoiza por processo — duas notificações no mesmo import leem o backend uma vez só', async () => {
    telegramFiltersGetMock.mockResolvedValue(doc(['macd', 'rsi']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    await notifyNewSignal(baseSignal({ source: 'rsi' }));
    expect(telegramFiltersGetMock).toHaveBeenCalledTimes(1);
  });

  it('o filtro NÃO se aplica a eventos de operação — TradeOperation.source é vocabulário diferente', async () => {
    telegramFiltersGetMock.mockResolvedValue(doc(['range_filter']));
    const { notifyTradeCreated } = await import('./adminTelegram.js');
    await notifyTradeCreated({
      symbol: 'BTCUSDT', side: 'BUY', timeframe: '15m', signal_timeframe: '4h', entry_price: 100,
      initial_stop: 95, tp1: 105, tp2: 110, score: 80, source: 'manual',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // Confirma que nem chegou a consultar o backend para este evento —
    // o guard de evento (signal_detected) descarta antes disso.
    expect(telegramFiltersGetMock).not.toHaveBeenCalled();
  });
});

describe('adminTelegram — override por ativo (known-risks item 47)', () => {
  it('asset.notify_sources SUBSTITUI o filtro global, e evita ler o backend', async () => {
    telegramFiltersGetMock.mockResolvedValue(doc(['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi'])); // global libera tudo
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }), { notify_sources: ['range_filter'] });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(telegramFiltersGetMock).not.toHaveBeenCalled(); // override por ativo decide sozinho, sem precisar do doc global
  });

  it('asset.notify_sources pode LIBERAR uma origem que o filtro global bloqueia', async () => {
    telegramFiltersGetMock.mockResolvedValue(doc(['range_filter'])); // global só RF
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }), { notify_sources: ['macd'] });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('asset.notify_signal_types SUBSTITUI o filtro global de lado', async () => {
    telegramFiltersGetMock.mockResolvedValue(doc(['macd']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd', signal_type: 'BUY' }), { notify_signal_types: ['SELL'] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sem asset, continua herdando 100% do filtro global lido do backend — regressão', async () => {
    telegramFiltersGetMock.mockResolvedValue(doc(['macd']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal({ source: 'macd' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('array vazio silencia o ativo por completo — estado válido, não erro', async () => {
    telegramFiltersGetMock.mockResolvedValue(doc(['range_filter', 'smc_structure', 'macd', 'ema_cross', 'rsi']));
    const { notifyNewSignal } = await import('./adminTelegram.js');
    await notifyNewSignal(baseSignal(), { notify_sources: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// item 140: exit_ambiguous (stop e take tocados na mesma vela — política
// "stop vence", .claude/rules/trading-engine.md) some junto com STOP_HIT
// (sempre terminal), então isto é puramente informativo — nenhuma
// mudança de comportamento do motor, só texto extra na notificação.
describe('notifyStopHit — nota de ambiguidade stop/TP na mesma vela (item 140)', () => {
  function baseOp(overrides = {}) {
    return {
      symbol: 'BTCUSDT', side: 'BUY', timeframe: '4h',
      current_stop: 95, tp1_hit: false,
      ...overrides,
    };
  }

  it('inclui a nota de ambiguidade quando op.exit_ambiguous é true', async () => {
    const { notifyStopHit } = await import('./adminTelegram.js');
    await notifyStopHit(baseOp({ exit_ambiguous: true }), 95);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const text = JSON.parse(global.fetch.mock.calls[0][1].body).text;
    expect(text).toContain('tocou o stop e o take ao mesmo tempo');
  });

  it('não inclui a nota quando op.exit_ambiguous é falsy/ausente', async () => {
    const { notifyStopHit } = await import('./adminTelegram.js');
    await notifyStopHit(baseOp(), 95);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const text = JSON.parse(global.fetch.mock.calls[0][1].body).text;
    expect(text).not.toContain('tocou o stop e o take ao mesmo tempo');
  });
});

// send() (item 166 Fase 2, "falha silenciosa") só fazia console.warn quando
// o envio falhava — invisível pro Debug Log do painel e pro
// scripts/health-audit.mjs, que só lê SystemLog.
describe('send — falha de envio agora fica visível no SystemLog (item 166 Fase 2)', () => {
  function baseOp(overrides = {}) {
    return { symbol: 'BTCUSDT', side: 'BUY', timeframe: '4h', current_stop: 95, tp1_hit: false, ...overrides };
  }

  it('resposta não-ok do Telegram grava no SystemLog (não só console.warn)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    const { notifyStopHit } = await import('./adminTelegram.js');
    await notifyStopHit(baseOp(), 95);
    expect(systemLogCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn', module: 'telegram', details: expect.objectContaining({ status: 401 }),
    }));
  });

  it('exceção de rede no fetch também grava no SystemLog', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    const { notifyStopHit } = await import('./adminTelegram.js');
    await notifyStopHit(baseOp(), 95);
    expect(systemLogCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn', module: 'telegram', details: expect.objectContaining({ error: 'Failed to fetch' }),
    }));
  });

  it('um backend cujo SystemLog.create() lança síncrono nunca vira exceção não tratada (throw engolido)', async () => {
    // logTelegramFailure precisa engolir um throw SÍNCRONO do backend (não só
    // uma promise rejeitada) — mesmo raciocínio de safeMirrorCall
    // (src/lib/rtdbMirror.js).
    systemLogCreateMock.mockImplementation(() => { throw new Error('SystemLog.create is not a function'); });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'x' });
    const { notifyStopHit } = await import('./adminTelegram.js');
    // Se o throw síncrono escapasse do try/catch de logTelegramFailure, este
    // await rejeitaria e o teste falharia sozinho.
    await notifyStopHit(baseOp(), 95);
  });

  // Codex review (PR #318): run-scan.mjs/run-backfill-check.mjs chamam
  // forceExit() (process.exit()) logo depois de aguardar o alerta que
  // dispara send() — antes desta correção, logTelegramFailure era
  // fire-and-forget dentro de send(), então send() podia resolver (e o
  // processo sair) ANTES da escrita no SystemLog completar, perdendo
  // silenciosamente o próprio registro que o item 1 desta rodada existe pra
  // garantir. Prova que send() agora aguarda a escrita: com a escrita
  // travada, a promise de notifyStopHit ainda não resolveu.
  it('send() aguarda a escrita do SystemLog terminar antes de resolver (corrida com forceExit)', async () => {
    let resolveCreate;
    systemLogCreateMock.mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'x' });
    const { notifyStopHit } = await import('./adminTelegram.js');

    let settled = false;
    const pending = notifyStopHit(baseOp(), 95).then(() => { settled = true; });

    // setTimeout(0) só dispara depois que a fila de MICROtasks esvazia —
    // drena tudo que a cadeia fetch/shouldSend podia terminar sozinha, sem
    // depender da escrita no backend (ainda travada, resolveCreate não foi
    // chamado). 3 `await Promise.resolve()` soltos não bastam aqui: a
    // primeira versão deste teste passava com o código ANTIGO (fire-and-
    // forget) porque a cadeia de awaits internos de send()/shouldSend() por
    // si só já passa de 3 microtasks, então "settled ainda false" dava falso
    // positivo mesmo sem a correção.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    resolveCreate();
    await pending;
    expect(settled).toBe(true);
  });
});

// docs/known-risks.md item 142 addendum: notifyFirestoreQuotaExhausted é
// chamada exatamente quando a cota do Firestore JÁ deu match como esgotada —
// a janela de maior risco do cliente admin travar em retry de
// RESOURCE_EXHAUSTED por minutos (item 142). Sem o withTimeout ao redor do
// get()/set() de dedup, o alerta cujo propósito é avisar RÁPIDO vira o
// próprio travamento que scanTimeout.mjs foi criado para eliminar. Estes
// testes provam que um get()/set() que nunca resolve não trava a função —
// mesmo padrão de fake timers de scanTimeout.test.mjs.
//
// Fora da Fase 10: este marcador (readAlertMarker/writeAlertMarker) prefere
// RTDB e só cai pro Firestore como fallback — sem FIREBASE_DATABASE_URL no
// ambiente de teste, markerRef() devolve null e o código cai direto no
// caminho Firestore mockado abaixo, exatamente como antes desta rodada.
describe('notifyFirestoreQuotaExhausted — timeout no dedup (item 142 addendum)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ref.get() que nunca resolve não trava a função — timeout dispara e alerta mesmo assim (fail-open)', async () => {
    vi.useFakeTimers();
    firestoreGetMock.mockReturnValue(new Promise(() => {}));
    const { notifyFirestoreQuotaExhausted } = await import('./adminTelegram.js');
    const resultPromise = notifyFirestoreQuotaExhausted('8 RESOURCE_EXHAUSTED: Quota exceeded.');
    await vi.advanceTimersByTimeAsync(15_000);
    const delivered = await resultPromise;
    expect(delivered).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('ref.set() que nunca resolve não trava a função — o dedup é não-crítico', async () => {
    vi.useFakeTimers();
    firestoreGetMock.mockResolvedValue({ exists: false });
    firestoreSetMock.mockReturnValue(new Promise(() => {}));
    const { notifyFirestoreQuotaExhausted } = await import('./adminTelegram.js');
    const resultPromise = notifyFirestoreQuotaExhausted('Quota exceeded.');
    await vi.advanceTimersByTimeAsync(15_000);
    const delivered = await resultPromise;
    expect(delivered).toBe(true);
  });

  it('caminho feliz: dedup dentro do cooldown não reenvia', async () => {
    firestoreGetMock.mockResolvedValue({
      exists: true,
      data: () => ({ last_alert_at: new Date().toISOString() }),
    });
    const { notifyFirestoreQuotaExhausted } = await import('./adminTelegram.js');
    const delivered = await notifyFirestoreQuotaExhausted('Quota exceeded.');
    expect(delivered).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
