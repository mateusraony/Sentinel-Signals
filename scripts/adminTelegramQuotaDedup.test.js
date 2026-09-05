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

// docs/known-risks.md item 160 — o alerta dizia "está falhando" e NADA nunca
// dizia que voltou. O usuário ficava olhando um alarme velho sem forma de
// saber que já não valia (relatado em 2026-09-05: "ainda está com cota
// esgotada", com o scan já rodando verde havia 2h).
describe('notifyFirestoreQuotaRecovered — o "tudo certo" que faltava', () => {
  it('ciclo completo: queda alerta e abre episódio; recuperação avisa e fecha', async () => {
    rtdbGet.mockResolvedValueOnce(rtdbSnap(undefined));
    const { notifyFirestoreQuotaExhausted, notifyFirestoreQuotaRecovered } = await import('./adminTelegram.js');

    expect(await notifyFirestoreQuotaExhausted('Quota exceeded.')).toBe(true);
    const gravado = rtdbSet.mock.calls[0][0];
    expect(gravado.alert_active).toBe(true);
    expect(gravado.alert_started_at).toBeTruthy();

    // Passada seguinte já limpa: o episódio está aberto, então avisa.
    rtdbGet.mockResolvedValueOnce({ exists: () => true, val: () => gravado });
    expect(await notifyFirestoreQuotaRecovered()).toBe(true);
    expect(rtdbSet.mock.calls[1][0].alert_active).toBe(false);

    const texto = global.fetch.mock.calls[1][1].body;
    expect(texto).toContain('normalizada');
  });

  it('sem episódio aberto, não manda nada — é o caso normal, a cada 5min', async () => {
    rtdbGet.mockResolvedValue(rtdbSnap(undefined));
    const { notifyFirestoreQuotaRecovered } = await import('./adminTelegram.js');
    expect(await notifyFirestoreQuotaRecovered()).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(rtdbSet).not.toHaveBeenCalled();
  });

  it('não avisa duas vezes: depois de fechado, a próxima passada limpa fica calada', async () => {
    const fechado = { last_alert_at: '2026-09-05T04:00:00.000Z', alert_active: false };
    rtdbGet.mockResolvedValue({ exists: () => true, val: () => fechado });
    const { notifyFirestoreQuotaRecovered } = await import('./adminTelegram.js');
    expect(await notifyFirestoreQuotaRecovered()).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('informa quanto tempo durou a queda', async () => {
    const inicio = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h atrás
    rtdbGet.mockResolvedValue({
      exists: () => true,
      val: () => ({ last_alert_at: inicio, alert_active: true, alert_started_at: inicio }),
    });
    const { notifyFirestoreQuotaRecovered } = await import('./adminTelegram.js');
    await notifyFirestoreQuotaRecovered();
    expect(global.fetch.mock.calls[0][1].body).toContain('3h');
  });

  it('alerta repetido não reinicia a contagem — a duração é da queda inteira', async () => {
    const inicio = '2026-09-05T01:00:00.000Z';
    // Episódio aberto há tempo, já fora do cooldown: realerta.
    rtdbGet.mockResolvedValueOnce({
      exists: () => true,
      val: () => ({ last_alert_at: '2026-09-05T01:00:00.000Z', alert_active: true, alert_started_at: inicio }),
    });
    const { notifyFirestoreQuotaExhausted } = await import('./adminTelegram.js');
    await notifyFirestoreQuotaExhausted('Quota exceeded.');
    expect(rtdbSet.mock.calls[0][0].alert_started_at).toBe(inicio);
  });

  it('marcador ilegível fica calado — o oposto do alerta, de propósito', async () => {
    rtdbGet.mockImplementation(() => Promise.reject(new Error('rtdb fora do ar')));
    const { notifyFirestoreQuotaRecovered } = await import('./adminTelegram.js');
    expect(await notifyFirestoreQuotaRecovered()).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
