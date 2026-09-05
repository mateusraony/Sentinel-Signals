// docs/known-risks.md item 158 — o marcador de dedup do alerta de cota morava
// DENTRO do Firestore. Quando a cota estourava, o get() dele falhava, o catch
// mantinha shouldAlert = true e o set() também falhava: o usuário recebia um
// alerta a CADA passada do scan (~5min), justamente quando o dedup deveria
// funcionar. Estes testes reproduzem esse cenário e provam a correção.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fsGet, fsSet, rtdbGet, rtdbSet, getDatabaseMock } = vi.hoisted(() => ({
  fsGet: vi.fn(), fsSet: vi.fn(), rtdbGet: vi.fn(), rtdbSet: vi.fn(), getDatabaseMock: vi.fn(),
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: () => ({ doc: () => ({ get: fsGet, set: fsSet }) }) }),
}));
vi.mock('firebase-admin/database', () => ({ getDatabase: getDatabaseMock }));

const QUOTA_OUT = () => Promise.reject(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.'));

beforeEach(() => {
  vi.resetModules();
  for (const m of [fsGet, fsSet, rtdbGet, rtdbSet, getDatabaseMock]) m.mockReset();
  fsSet.mockResolvedValue(undefined);
  rtdbSet.mockResolvedValue(undefined);
  getDatabaseMock.mockReturnValue({ ref: () => ({ get: rtdbGet, set: rtdbSet }) });
  process.env.TELEGRAM_BOT_TOKEN = 'x';
  process.env.TELEGRAM_CHAT_ID = 'y';
  process.env.FIREBASE_DATABASE_URL = 'https://exemplo.firebaseio.com';
  global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
});

const rtdbSnap = (lastAt) => (lastAt === undefined
  ? { exists: () => false, val: () => null }
  : { exists: () => true, val: () => ({ last_alert_at: lastAt }) });

describe('shouldAlertQuota — decisão pura', () => {
  it('alerta quando nunca alertou, ou quando o marcador é ilegível', async () => {
    const { shouldAlertQuota } = await import('./adminTelegram.js');
    expect(shouldAlertQuota(null)).toBe(true);
    expect(shouldAlertQuota('data-invalida')).toBe(true);
  });

  it('silencia dentro do cooldown e volta a alertar depois dele', async () => {
    const { shouldAlertQuota } = await import('./adminTelegram.js');
    const agora = Date.parse('2026-09-05T12:00:00.000Z');
    const cooldown = 60 * 60 * 1000;
    expect(shouldAlertQuota('2026-09-05T11:30:00.000Z', agora, cooldown)).toBe(false);
    expect(shouldAlertQuota('2026-09-05T10:30:00.000Z', agora, cooldown)).toBe(true);
  });
});

describe('notifyFirestoreQuotaExhausted — o cenário real do incidente', () => {
  it('regressão: com o Firestore SEM COTA, a segunda passada do scan não realerta', async () => {
    // É exatamente a situação do incidente: toda chamada ao Firestore falha.
    fsGet.mockImplementation(QUOTA_OUT);
    fsSet.mockImplementation(QUOTA_OUT);
    rtdbGet.mockResolvedValueOnce(rtdbSnap(undefined));           // 1ª: nunca alertou
    const { notifyFirestoreQuotaExhausted } = await import('./adminTelegram.js');

    expect(await notifyFirestoreQuotaExhausted('Quota exceeded.')).toBe(true);
    expect(rtdbSet).toHaveBeenCalledTimes(1);                     // marcador GRAVADO

    // 2ª passada, ~5min depois: o marcador continua legível porque vive no RTDB.
    rtdbGet.mockResolvedValueOnce(rtdbSnap(new Date().toISOString()));
    expect(await notifyFirestoreQuotaExhausted('Quota exceeded.')).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);                // UM alerta, não dois
  });

  it('o marcador nunca é lido nem gravado no Firestore quando há RTDB', async () => {
    rtdbGet.mockResolvedValue(rtdbSnap(undefined));
    const { notifyFirestoreQuotaExhausted } = await import('./adminTelegram.js');
    await notifyFirestoreQuotaExhausted('Quota exceeded.');
    expect(fsGet).not.toHaveBeenCalled();
    expect(fsSet).not.toHaveBeenCalled();
  });

  it('sem RTDB configurado, mantém o comportamento anterior no Firestore', async () => {
    delete process.env.FIREBASE_DATABASE_URL;
    fsGet.mockResolvedValue({ exists: false });
    const { notifyFirestoreQuotaExhausted } = await import('./adminTelegram.js');
    expect(await notifyFirestoreQuotaExhausted('Quota exceeded.')).toBe(true);
    expect(fsGet).toHaveBeenCalled();
    expect(rtdbGet).not.toHaveBeenCalled();
  });

  it('RTDB ilegível não engole o primeiro aviso de uma queda real', async () => {
    rtdbGet.mockImplementation(() => Promise.reject(new Error('rtdb fora do ar')));
    const { notifyFirestoreQuotaExhausted } = await import('./adminTelegram.js');
    expect(await notifyFirestoreQuotaExhausted('Quota exceeded.')).toBe(true);
  });
});
