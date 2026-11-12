// Regressão do item 299 (fase O1), com o firebase-admin REAL: o scan registra o app NOMEADO `observation` para gravar o
// retrato, e o `adminTelegram.js` precisa continuar achando (ou criando) o app PADRÃO para os marcadores de alerta.
//
// Por que um arquivo à parte, sem mockar `firebase-admin/app`: o teste de unidade (`adminTelegram.test.js`) usa um `getApps`
// de mentira e só prova a lógica do guard. Foi a mentira que deixou o defeito passar: o SDK de verdade devolve o app
// nomeado na mesma lista do padrão, e o guard antigo (`getApps().length`) concluía "já existe um app". Aqui o registro de
// apps é o do SDK; só o `getFirestore` é trocado, por uma função que faz o que o SDK faz (exige o app padrão: lança
// "The default Firebase app does not exist" se ele não existir) mas não abre conexão nenhuma.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { getApps, getApp, deleteApp, initializeApp } from 'firebase-admin/app';

vi.mock('../src/lib/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

const { markerGetMock, markerSetMock } = vi.hoisted(() => ({ markerGetMock: vi.fn(), markerSetMock: vi.fn() }));

// Faz o que o `getFirestore()` real faz com o registro de apps (acha o app padrão ou lança), sem rede.
vi.mock('firebase-admin/firestore', async () => {
  const { getApp: getAppReal } = await import('firebase-admin/app');
  return {
    getFirestore: vi.fn(() => {
      getAppReal(); // lança "The default Firebase app does not exist..." se só houver app nomeado
      return { collection: () => ({ doc: () => ({ get: markerGetMock, set: markerSetMock }) }) };
    }),
  };
});

vi.mock('./adminEntities.js', () => ({
  backend: { entities: { TelegramFilters: { get: vi.fn().mockResolvedValue(null) }, SystemLog: { create: vi.fn().mockResolvedValue(undefined) } } },
}));

function chaveDeServicoDeMentira() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return JSON.stringify({
    type: 'service_account',
    project_id: 'sentinel-teste',
    client_email: 'teste@sentinel-teste.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
}

async function apagarTodosOsApps() {
  await Promise.all(getApps().map((app) => deleteApp(app)));
}

describe('adminTelegram × firebase-admin real — app nomeado `observation` registrado (item 299, O1)', () => {
  const guardado = {};

  beforeEach(async () => {
    await apagarTodosOsApps();
    for (const k of ['FIREBASE_DATABASE_URL', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) guardado[k] = process.env[k];
    delete process.env.FIREBASE_DATABASE_URL; // como no scan: sem RTDB, o marcador cai no Firestore
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = chaveDeServicoDeMentira();
    process.env.TELEGRAM_BOT_TOKEN = 'x';
    process.env.TELEGRAM_CHAT_ID = 'y';
    markerGetMock.mockReset();
    markerGetMock.mockResolvedValue({ exists: false, data: () => ({}) });
    markerSetMock.mockReset();
    markerSetMock.mockResolvedValue(undefined);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.resetModules();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(guardado)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await apagarTodosOsApps();
  });

  it('com SÓ o app nomeado registrado, o marcador cria o app padrão e funciona', async () => {
    initializeApp({ projectId: 'sentinel-teste' }, 'observation'); // o que o armazenamento do retrato faz
    expect(getApps().map((a) => a.name)).toEqual(['observation']);

    const { notifyStepTimeout } = await import('./adminTelegram.js');
    const entregue = await notifyStepTimeout('checkOneAsset:XYZUSDT', 300000);

    expect(entregue).toBe(true);
    expect(getApp().name).toBe('[DEFAULT]'); // o padrão existe agora (getApp() lançaria se não existisse)
    expect(getApps().map((a) => a.name).sort()).toEqual(['[DEFAULT]', 'observation']);
    expect(markerSetMock).toHaveBeenCalled(); // o marcador de cooldown foi gravado (antes: lançava e o aviso repetiria)
  });

  it('sem nenhum app registrado, continua criando o padrão (comportamento de sempre)', async () => {
    const { notifyStepTimeout } = await import('./adminTelegram.js');
    const entregue = await notifyStepTimeout('checkOneAsset:XYZUSDT', 300000);

    expect(entregue).toBe(true);
    expect(getApps().map((a) => a.name)).toEqual(['[DEFAULT]']);
    expect(markerSetMock).toHaveBeenCalled();
  });

  it('com o padrão já registrado, não cria outro (idempotente)', async () => {
    initializeApp({ projectId: 'sentinel-teste' }); // o padrão, de outro caminho
    initializeApp({ projectId: 'sentinel-teste' }, 'observation');

    const { notifyStepTimeout } = await import('./adminTelegram.js');
    await notifyStepTimeout('checkOneAsset:XYZUSDT', 300000);

    expect(getApps().map((a) => a.name).sort()).toEqual(['[DEFAULT]', 'observation']);
    expect(markerSetMock).toHaveBeenCalled();
  });
});
