// docs/known-risks.md item 282 — alerta próprio de cota do BANCO (Neon).
// Antes dele, o usuário só recebia "Lock do scanner degradado" a CADA passada
// (~5 min), porque o cooldown daquele alerta é em memória e o cron é um
// processo novo por passada; e o texto nem dizia que o banco estava sem cota.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { rtdbRefs, refFactory, getDatabaseMock } = vi.hoisted(() => {
  const rtdbRefs = new Map();
  const refFactory = vi.fn((path) => {
    if (!rtdbRefs.has(path)) {
      rtdbRefs.set(path, {
        get: vi.fn().mockResolvedValue({ exists: () => false, val: () => null }),
        set: vi.fn().mockResolvedValue(undefined),
      });
    }
    return rtdbRefs.get(path);
  });
  return { rtdbRefs, refFactory, getDatabaseMock: vi.fn() };
});

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: () => ({ doc: () => ({ get: vi.fn(), set: vi.fn() }) }) }),
}));
vi.mock('firebase-admin/database', () => ({ getDatabase: getDatabaseMock }));

const MARCADOR_BANCO = 'systemAlerts/dbQuota';
const MARCADOR_FIRESTORE = 'systemAlerts/firestoreQuota';
const MENSAGEM = 'error: Your account or project has exceeded the quota. Upgrade your plan to increase limits.';

beforeEach(() => {
  vi.resetModules();
  rtdbRefs.clear();
  refFactory.mockClear();
  getDatabaseMock.mockReturnValue({ ref: refFactory });
  process.env.TELEGRAM_BOT_TOKEN = 'x';
  process.env.TELEGRAM_CHAT_ID = 'y';
  process.env.FIREBASE_DATABASE_URL = 'https://exemplo.firebaseio.com';
  global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
});

const corpoEnviado = () => global.fetch.mock.calls.map((c) => c[1].body).join('\n');

describe('notifyDatabaseQuotaExhausted', () => {
  it('diz que o banco está sem cota, manda olhar o painel do Neon e NÃO chuta qual cota', async () => {
    const { notifyDatabaseQuotaExhausted } = await import('./adminTelegram.js');
    expect(await notifyDatabaseQuotaExhausted(MENSAGEM)).toBe(true);

    const corpo = corpoEnviado();
    expect(corpo).toContain('Banco de dados sem cota (Neon)');
    expect(corpo).toContain('console.neon.tech');
    expect(corpo).toContain('Compute, Network transfer ou Storage');
    expect(corpo).not.toContain('Lock do scanner');
    expect(corpo).not.toContain('Firestore');
  });

  it('usa marcador PRÓPRIO — nunca o da cota do Firestore', async () => {
    const { notifyDatabaseQuotaExhausted } = await import('./adminTelegram.js');
    await notifyDatabaseQuotaExhausted(MENSAGEM);

    expect(rtdbRefs.get(MARCADOR_BANCO).set).toHaveBeenCalledTimes(1);
    expect(rtdbRefs.get(MARCADOR_BANCO).set.mock.calls[0][0]).toMatchObject({ alert_active: true });
    expect(rtdbRefs.has(MARCADOR_FIRESTORE)).toBe(false);
  });

  it('regressão: a passada seguinte (processo novo, ~5 min depois) NÃO realerta dentro do cooldown de 1 h', async () => {
    const { notifyDatabaseQuotaExhausted } = await import('./adminTelegram.js');
    await notifyDatabaseQuotaExhausted(MENSAGEM);
    global.fetch.mockClear();

    rtdbRefs.get(MARCADOR_BANCO).get.mockResolvedValue({
      exists: () => true,
      val: () => ({ last_alert_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), alert_active: true }),
    });
    expect(await notifyDatabaseQuotaExhausted(MENSAGEM)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('depois do cooldown volta a avisar, mantendo o início do episódio', async () => {
    const { notifyDatabaseQuotaExhausted } = await import('./adminTelegram.js');
    const comecou = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    rtdbRefs.set(MARCADOR_BANCO, {
      get: vi.fn().mockResolvedValue({
        exists: () => true,
        val: () => ({ last_alert_at: new Date(Date.now() - 61 * 60 * 1000).toISOString(), alert_active: true, alert_started_at: comecou }),
      }),
      set: vi.fn().mockResolvedValue(undefined),
    });

    expect(await notifyDatabaseQuotaExhausted(MENSAGEM)).toBe(true);
    expect(rtdbRefs.get(MARCADOR_BANCO).set.mock.calls[0][0]).toMatchObject({ alert_active: true, alert_started_at: comecou });
  });
});

describe('notifyDatabaseQuotaRecovered', () => {
  it('sem episódio aberto, fica calado (o caso normal de toda passada limpa)', async () => {
    const { notifyDatabaseQuotaRecovered } = await import('./adminTelegram.js');
    expect(await notifyDatabaseQuotaRecovered()).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('com episódio aberto, avisa que voltou com a duração e fecha o marcador', async () => {
    const { notifyDatabaseQuotaRecovered } = await import('./adminTelegram.js');
    const comecou = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    rtdbRefs.set(MARCADOR_BANCO, {
      get: vi.fn().mockResolvedValue({ exists: () => true, val: () => ({ alert_active: true, alert_started_at: comecou, last_alert_at: comecou }) }),
      set: vi.fn().mockResolvedValue(undefined),
    });

    expect(await notifyDatabaseQuotaRecovered()).toBe(true);
    expect(corpoEnviado()).toContain('Banco de dados voltou (Neon)');
    expect(rtdbRefs.get(MARCADOR_BANCO).set.mock.calls[0][0]).toMatchObject({ alert_active: false });
  });
});
