// docs/known-risks.md item 162 — antes deste alerta existir, QUALQUER etapa
// que travasse era anunciada como "Cota do Firestore esgotada", porque a
// mensagem de timeout carregava a palavra RESOURCE_EXHAUSTED como hipótese.
// Em 2026-09-05 o backfill travou num único ativo e o usuário recebeu alerta
// de cota — com o scan ao vivo rodando verde a cada 5 minutos.
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

const MARCADOR_ETAPA = 'systemAlerts/stepTimeout';
const MARCADOR_COTA = 'systemAlerts/firestoreQuota';

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

describe('notifyStepTimeout', () => {
  it('nomeia a etapa em português simples e NÃO fala em cota esgotada', async () => {
    const { notifyStepTimeout } = await import('./adminTelegram.js');
    expect(await notifyStepTimeout('checkOneAsset:LDOUSDT', 300_000)).toBe(true);

    const corpo = corpoEnviado();
    expect(corpo).toContain('Uma etapa travou');
    expect(corpo).toContain('a checagem retroativa do LDOUSDT');
    expect(corpo).toContain('5min');
    expect(corpo).not.toContain('Cota do Firestore esgotada');
    expect(corpo).not.toContain('RESOURCE_EXHAUSTED');
  });

  it('usa marcador PRÓPRIO — nunca o do alerta de cota', async () => {
    const { notifyStepTimeout } = await import('./adminTelegram.js');
    await notifyStepTimeout('scanAllAssets', 90_000);

    expect(rtdbRefs.get(MARCADOR_ETAPA).set).toHaveBeenCalledTimes(1);
    expect(rtdbRefs.has(MARCADOR_COTA)).toBe(false);
  });

  it('não spamma: a MESMA etapa dentro do cooldown fica calada', async () => {
    const { notifyStepTimeout } = await import('./adminTelegram.js');
    await notifyStepTimeout('scanAllAssets', 90_000);
    global.fetch.mockClear();

    rtdbRefs.get(MARCADOR_ETAPA).get.mockResolvedValue({
      exists: () => true,
      val: () => ({ last_alert_at: new Date().toISOString(), step: 'scanAllAssets' }),
    });
    expect(await notifyStepTimeout('scanAllAssets', 90_000)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uma etapa DIFERENTE é informação nova e avisa mesmo dentro do cooldown', async () => {
    rtdbRefs.set(MARCADOR_ETAPA, {
      get: vi.fn().mockResolvedValue({
        exists: () => true,
        val: () => ({ last_alert_at: new Date().toISOString(), step: 'scanAllAssets' }),
      }),
      set: vi.fn().mockResolvedValue(undefined),
    });
    const { notifyStepTimeout } = await import('./adminTelegram.js');
    expect(await notifyStepTimeout('checkOneAsset:LDOUSDT', 300_000)).toBe(true);
    expect(corpoEnviado()).toContain('a checagem retroativa do LDOUSDT');
  });

  it('marcador ilegível não engole o aviso — travamento é a hora de falar', async () => {
    rtdbRefs.set(MARCADOR_ETAPA, {
      get: vi.fn().mockRejectedValue(new Error('rtdb fora do ar')),
      set: vi.fn().mockResolvedValue(undefined),
    });
    const { notifyStepTimeout } = await import('./adminTelegram.js');
    expect(await notifyStepTimeout('scanAllAssets', 90_000)).toBe(true);
  });
});

// Achado do Codex (PR #311), item 167. `normalizarMensagem` da auditoria troca
// o símbolo do ativo por `<ativo>`; esse texto entrava CRU numa mensagem com
// parse_mode HTML, o Telegram rejeitava com 400, send() devolvia false e a
// auditoria ignorava — execução verde, alerta não entregue.
describe('notifyHealthAudit — escape de HTML', () => {
  it('escapa texto do usuário para o Telegram não rejeitar a mensagem', async () => {
    const { escaparHtml } = await import('./adminTelegram.js');
    expect(escaparHtml('<ativo> falhou')).toBe('&lt;ativo&gt; falhou');
    expect(escaparHtml('a & b')).toBe('a &amp; b');
    expect(escaparHtml(null)).toBe('');
  });

  it('REGRESSÃO: um achado com <ativo> não vaza tag crua para a API', async () => {
    const { notifyHealthAudit } = await import('./adminTelegram.js');
    await notifyHealthAudit('Auditoria achou algo', ['scanner · <ativo> falhou ao buscar'], null);

    const corpo = global.fetch.mock.calls.map((c) => c[1].body).join('\n');
    expect(corpo).toContain('&lt;ativo&gt;');
    // A tag crua derrubaria a mensagem inteira com "Unsupported start tag".
    expect(corpo).not.toContain('<ativo>');
  });

  it('as tags de formatação do PRÓPRIO template continuam funcionando', async () => {
    const { notifyHealthAudit } = await import('./adminTelegram.js');
    await notifyHealthAudit('Título', ['achado'], 'https://exemplo/run/1');

    const corpo = global.fetch.mock.calls.map((c) => c[1].body).join('\n');
    expect(corpo).toContain('<b>');   // só o texto dinâmico é escapado
    expect(corpo).toContain('<i>');
    expect(corpo).toContain('href=');
  });
});
