// Modo de observação sem banco, fase O1 (item 299): o armazenamento do retrato no Realtime Database.
// Provas: usa um app NOMEADO (não mexe no app padrão do adminTelegram nem nos marcadores de alerta), grava UM nó fixo sob `observation/`, tem prazo,
// e qualquer falha vira só um CÓDIGO (a mensagem de um erro do Firebase pode trazer URL do projeto; o log do Actions é público).
import { describe, it, expect, vi } from 'vitest';
import { createObservationStore, SNAPSHOT_PATH, OBSERVATION_APP_NAME, writeTimeoutError } from './observationStore.mjs';
import { problemasDasRegrasDoRtdb } from './observationRules.mjs';

const URL = 'https://projeto-default-rtdb.firebaseio.com';
const CRED = JSON.stringify({ type: 'service_account', project_id: 'p', private_key: 'k', client_email: 'e@p.iam.gserviceaccount.com' });
const SNAPSHOT = { version: 1, snapshot_at: '2026-11-11T12:00:00.000Z', operations: [], assets: [], counts: { operations: 0, assets: 0 } };

// Regras PUBLICADAS "seguras": o nó observation não tem regra (negado por padrão); os outros nós seguem `auth != null`, como no projeto.
const REGRAS_SEGURAS = { rules: { assetStates: { '.read': 'auth != null', '.write': 'auth != null' }, systemAlerts: { '.read': 'auth != null', '.write': 'auth != null' } } };

function fakeFirebase({ apps = [], setImpl = async () => {}, rules = REGRAS_SEGURAS, rulesImpl = null } = {}) {
  const set = vi.fn(setImpl);
  const ref = vi.fn(() => ({ set }));
  const getRulesJSON = vi.fn(rulesImpl ?? (async () => rules));
  const db = { ref, getRulesJSON };
  const app = { name: OBSERVATION_APP_NAME };
  const fb = {
    getApps: vi.fn(() => apps),
    initializeApp: vi.fn(() => app),
    cert: vi.fn((j) => ({ __cert: j })),
    getDatabaseWithUrl: vi.fn(() => db),
  };
  return { fb, set, ref, db, app, getRulesJSON };
}
const mk = (f, env = {}) => createObservationStore({ env: { OBSERVATION_DATABASE_URL: URL, FIREBASE_SERVICE_ACCOUNT_JSON: CRED, ...env }, firebase: f.fb, timeoutMs: 50 });

describe('createObservationStore — desligado', () => {
  it.each([[undefined], [''], ['  ']])('sem URL (%j): não inicializa nada e o write devolve "sem_url"', async (url) => {
    const f = fakeFirebase();
    const store = mk(f, { OBSERVATION_DATABASE_URL: url });
    expect(store.enabled).toBe(false);
    await expect(store.write(SNAPSHOT)).resolves.toEqual({ ok: false, skipped: 'sem_url' });
    expect(f.fb.initializeApp).not.toHaveBeenCalled();
    expect(f.set).not.toHaveBeenCalled();
  });
});

describe('createObservationStore — gravação', () => {
  it('grava o retrato em UM nó fixo sob observation/, com app nomeado e a URL pedida', async () => {
    const f = fakeFirebase();
    const r = await mk(f).write(SNAPSHOT);
    expect(r).toEqual({ ok: true });
    expect(SNAPSHOT_PATH).toBe('observation/snapshot');
    expect(f.fb.initializeApp).toHaveBeenCalledTimes(1);
    expect(f.fb.initializeApp.mock.calls[0][0]).toMatchObject({ databaseURL: URL });
    expect(f.fb.initializeApp.mock.calls[0][1]).toBe(OBSERVATION_APP_NAME);
    expect(f.fb.getDatabaseWithUrl).toHaveBeenCalledWith(URL, f.app);
    expect(f.ref).toHaveBeenCalledTimes(1);
    expect(f.ref).toHaveBeenCalledWith('observation/snapshot');
    expect(f.set).toHaveBeenCalledWith(SNAPSHOT);
  });

  it('o app padrão NUNCA é tocado: só o app nomeado (os marcadores de alerta do adminTelegram seguem onde estão)', async () => {
    const f = fakeFirebase();
    await mk(f).write(SNAPSHOT);
    expect(OBSERVATION_APP_NAME).not.toBe('[DEFAULT]');
    for (const [, nome] of f.fb.initializeApp.mock.calls) expect(nome).toBeTruthy();
  });

  it('reaproveita o app nomeado se ele já existe (não inicializa duas vezes)', async () => {
    const existente = { name: OBSERVATION_APP_NAME };
    const f = fakeFirebase({ apps: [{ name: '[DEFAULT]' }, existente] });
    const store = mk(f);
    await store.write(SNAPSHOT);
    await store.write(SNAPSHOT);
    expect(f.fb.initializeApp).not.toHaveBeenCalled();
    expect(f.fb.getDatabaseWithUrl).toHaveBeenCalledWith(URL, existente);
  });

  it('inicializa só uma vez mesmo gravando várias vezes', async () => {
    const f = fakeFirebase();
    const store = mk(f);
    await store.write(SNAPSHOT);
    await store.write(SNAPSHOT);
    expect(f.fb.initializeApp).toHaveBeenCalledTimes(1);
    expect(f.set).toHaveBeenCalledTimes(2);
  });
});

describe('createObservationStore — só grava se as regras PUBLICADAS no Firebase fecham o nó do retrato', () => {
  // O arquivo database.rules.json do repositório pode divergir do que está publicado no console (o deploy das regras é manual). As regras do projeto
  // são abertas a qualquer visitante anônimo: gravar entrada, stop e alvos num nó alcançado por uma regra aberta os exporia a qualquer pessoa.
  it('regras seguras: lê as regras ANTES de gravar e grava', async () => {
    const f = fakeFirebase();
    const r = await mk(f).write(SNAPSHOT);
    expect(r).toEqual({ ok: true });
    expect(f.getRulesJSON).toHaveBeenCalledTimes(1);
    expect(f.getRulesJSON.mock.invocationCallOrder[0]).toBeLessThan(f.set.mock.invocationCallOrder[0]);
  });

  const ABERTAS = [
    ['raiz aberta (.read auth != null)', { rules: { '.read': 'auth != null' } }],
    ['raiz aberta (.write true)', { rules: { '.write': true } }],
    ['modo de teste do Firebase (raiz .read e .write true)', { rules: { '.read': true, '.write': true } }],
    ['curinga de 1º nível aberto', { rules: { $qualquer: { '.read': 'auth != null' } } }],
    ['curinga com filho aberto', { rules: { $node: { snapshot: { '.read': 'auth != null' } } } }],
    ['nó observation aberto', { rules: { observation: { '.read': 'auth != null' } } }],
    ['neto de observation aberto', { rules: { observation: { snapshot: { operations: { '.write': true } } } } }],
  ];

  it.each(ABERTAS)('regras PUBLICADAS abertas (%s): NÃO grava e devolve "regras_abertas"', async (_nome, rules) => {
    const f = fakeFirebase({ rules });
    const r = await mk(f).write(SNAPSHOT);
    expect(r).toEqual({ ok: false, erro: 'regras_abertas' });
    expect(f.set).not.toHaveBeenCalled();
  });

  it('não consegue ler as regras (permissão, rede, prazo): NÃO grava, falha para o lado seguro, só o código', async () => {
    for (const impl of [
      async () => { throw Object.assign(new Error('Permission denied https://projeto.firebaseio.com/.settings/rules.json'), { code: 'PERMISSION_DENIED' }); },
      () => new Promise(() => {}), // não responde: estoura o prazo
      async () => 'não é um objeto de regras',
      async () => ({}),
    ]) {
      const f = fakeFirebase({ rulesImpl: impl });
      const r = await mk(f).write(SNAPSHOT);
      expect(r.ok).toBe(false);
      expect(['regras_nao_verificadas', 'regras_abertas']).toContain(r.erro);
      expect(JSON.stringify(r)).not.toContain('firebaseio');
      expect(f.set).not.toHaveBeenCalled();
    }
  });

  it('o resultado "seguro" é lembrado no processo (1 leitura de regras para várias gravações)', async () => {
    const f = fakeFirebase();
    const store = mk(f);
    await store.write(SNAPSHOT);
    await store.write(SNAPSHOT);
    await store.write(SNAPSHOT);
    expect(f.getRulesJSON).toHaveBeenCalledTimes(1);
    expect(f.set).toHaveBeenCalledTimes(3);
  });

  it('o resultado "aberto" NÃO é lembrado: corrigir as regras publicadas libera a gravação na tentativa seguinte', async () => {
    let regras = { rules: { '.read': 'auth != null' } };
    const f = fakeFirebase({ rulesImpl: async () => regras });
    const store = mk(f);
    expect((await store.write(SNAPSHOT)).erro).toBe('regras_abertas');
    // 2ª tentativa com as regras AINDA abertas: tem que recusar de novo (lembrar o "aberto" deixaria o retrato passar)
    expect((await store.write(SNAPSHOT)).erro).toBe('regras_abertas');
    expect(f.set).not.toHaveBeenCalled();
    regras = REGRAS_SEGURAS;
    expect(await store.write(SNAPSHOT)).toEqual({ ok: true });
    expect(f.set).toHaveBeenCalledTimes(1);
  });

  it('as REGRAS REAIS do repositório (database.rules.json) passam na mesma análise que o armazenamento usa', async () => {
    const { readFileSync } = await import('node:fs');
    const real = JSON.parse(readFileSync(`${process.cwd()}/database.rules.json`, 'utf8'));
    expect(problemasDasRegrasDoRtdb(real)).toEqual([]);
    const f = fakeFirebase({ rules: real });
    expect(await mk(f).write(SNAPSHOT)).toEqual({ ok: true });
  });
});

describe('createObservationStore — falhas viram só um código', () => {
  it('credencial ausente ou ilegível: "credencial_invalida", sem trecho da credencial', async () => {
    for (const cred of [undefined, '', 'isto não é json {{{', '{"private_key":"SEGREDO-NA-CREDENCIAL" quebrado']) {
      const f = fakeFirebase();
      const r = await mk(f, { FIREBASE_SERVICE_ACCOUNT_JSON: cred }).write(SNAPSHOT);
      expect(r).toEqual({ ok: false, erro: 'credencial_invalida' });
      expect(JSON.stringify(r)).not.toContain('SEGREDO');
      expect(f.set).not.toHaveBeenCalled();
    }
  });

  it('erro do Firebase: só o código, nunca a mensagem (pode trazer a URL do projeto e o token)', async () => {
    const f = fakeFirebase({ setImpl: async () => { throw Object.assign(new Error('PERMISSION_DENIED: https://projeto-default-rtdb.firebaseio.com token=abc123'), { code: 'PERMISSION_DENIED' }); } });
    const r = await mk(f).write(SNAPSHOT);
    expect(r).toEqual({ ok: false, erro: 'PERMISSION_DENIED' });
    expect(JSON.stringify(r)).not.toContain('abc123');
    expect(JSON.stringify(r)).not.toContain('firebaseio');
  });

  it('erro sem código: o nome do erro; com nome estranho: "erro_desconhecido"', async () => {
    const a = fakeFirebase({ setImpl: async () => { throw new TypeError('x'); } });
    expect(await mk(a).write(SNAPSHOT)).toEqual({ ok: false, erro: 'TypeError' });
    const b = fakeFirebase({ setImpl: async () => { throw Object.assign(new Error('x'), { name: 'texto livre com espaços e https://x' }); } });
    expect(await mk(b).write(SNAPSHOT)).toEqual({ ok: false, erro: 'erro_desconhecido' });
  });

  it('falha ao inicializar o app (credencial recusada pelo SDK) também vira código', async () => {
    const f = fakeFirebase();
    f.fb.initializeApp = vi.fn(() => { throw new Error('Failed to parse private key: SEGREDO-NA-CHAVE'); });
    const r = await mk(f).write(SNAPSHOT);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('SEGREDO');
  });

  it('tem prazo: um RTDB que não responde vira "timeout" e não prende o scan', async () => {
    const f = fakeFirebase({ setImpl: () => new Promise(() => {}) });
    const r = await mk(f).write(SNAPSHOT);
    expect(r).toEqual({ ok: false, erro: 'timeout' });
  });

  it('nunca lança, nem com o retrato quebrado', async () => {
    const f = fakeFirebase();
    await expect(mk(f).write(undefined)).resolves.toMatchObject({ ok: false });
    await expect(mk(f).write(null)).resolves.toMatchObject({ ok: false });
  });

  it('o erro de prazo interno é reconhecido pelo código "timeout"', () => {
    expect(writeTimeoutError(new Error('Timeout: observationSnapshot não retornou em 50ms'))).toBe(true);
    expect(writeTimeoutError(new Error('outro erro'))).toBe(false);
  });
});
