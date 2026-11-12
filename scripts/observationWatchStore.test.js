// Modo de observação sem banco, fase O2b (docs/known-risks.md item 299): o armazenamento do VIGIA no Realtime Database.
// Lê o retrato e o episódio; grava só o episódio (e o livro de avisos dentro dele). Leitura é livre; QUALQUER gravação só acontece depois de conferir que as
// regras PUBLICADAS do RTDB deixam o nó `observation` fechado. Falha vira só um CÓDIGO (a mensagem de um erro do Firebase pode trazer a URL do projeto).
import { describe, it, expect } from 'vitest';
import { createObservationWatchStore, EPISODE_PATH } from './observationWatchStore.mjs';
import { SNAPSHOT_PATH, OBSERVATION_APP_NAME } from './observationStore.mjs';
import { createFakeRtdb, createFakeFirebase, REGRAS_SEGURAS, REGRAS_ABERTAS } from './__fixtures__/fakeRtdb.js';
import { encodeKeyPart } from './observationWatch.mjs';

const URL = 'https://projeto-default-rtdb.firebaseio.com';
const CRED = JSON.stringify({ type: 'service_account', project_id: 'p', private_key: 'k', client_email: 'e@p.iam.gserviceaccount.com' });
const EP = { started_at: '2026-11-12T10:00:00.000Z', snapshot_at: '2026-11-12T09:45:00.000Z', status: 'watching', alerts_sent: 0, start_notice_sent: false };

function montar({ rules = REGRAS_SEGURAS, initial = {}, fail = {}, env = {}, apps = [], timeoutMs = 50 } = {}) {
  const rtdb = createFakeRtdb({ rules, initial, fail });
  const fb = createFakeFirebase(rtdb, { apps });
  let inits = 0;
  const initArgs = [];
  const firebase = { ...fb, initializeApp: (...a) => { inits += 1; initArgs.push(a); return fb.initializeApp(...a); } };
  const store = createObservationWatchStore({ env: { OBSERVATION_DATABASE_URL: URL, FIREBASE_SERVICE_ACCOUNT_JSON: CRED, ...env }, firebase, timeoutMs });
  return { rtdb, store, inits: () => inits, initArgs };
}

describe('desligado (sem OBSERVATION_DATABASE_URL)', () => {
  it.each([[undefined], [''], ['   ']])('URL %j: nada é inicializado e todo método devolve "sem_url"', async (url) => {
    const m = montar({ env: { OBSERVATION_DATABASE_URL: url } });
    expect(m.store.enabled).toBe(false);
    for (const r of [await m.store.readSnapshot(), await m.store.readEpisode(), await m.store.setEpisode(EP), await m.store.patchEpisode({ ended_at: 'x' })]) {
      expect(r).toEqual({ ok: false, skipped: 'sem_url' });
    }
    expect(m.inits()).toBe(0);
    expect(m.rtdb.calls).toEqual([]);
  });
});

describe('leitura', () => {
  it('lê o retrato do nó fixo e o episódio do nó fixo', async () => {
    const m = montar({ initial: { observation: { snapshot: { version: 1, snapshot_at: 'a' }, episode: EP } } });
    expect(await m.store.readSnapshot()).toEqual({ ok: true, value: { version: 1, snapshot_at: 'a' } });
    expect(await m.store.readEpisode()).toEqual({ ok: true, value: EP });
    expect(SNAPSHOT_PATH).toBe('observation/snapshot');
    expect(EPISODE_PATH).toBe('observation/episode');
    expect(m.rtdb.calls.map((c) => c.path)).toEqual([SNAPSHOT_PATH, EPISODE_PATH]);
  });
  it('nó ausente => value null (não é erro)', async () => {
    const m = montar();
    expect(await m.store.readSnapshot()).toEqual({ ok: true, value: null });
    expect(await m.store.readEpisode()).toEqual({ ok: true, value: null });
  });
  it('LER não confere as regras publicadas (leitura não expõe nada) nem grava', async () => {
    const m = montar({ rules: REGRAS_ABERTAS });
    await m.store.readSnapshot();
    await m.store.readEpisode();
    expect(m.rtdb.rulesCalls()).toBe(0);
    expect(m.rtdb.writes()).toEqual([]);
  });
  it('erro de leitura vira só o código (nunca a mensagem, que pode ter a URL do projeto)', async () => {
    const m = montar({ fail: { get: () => Object.assign(new Error(`falhou em ${URL} com token SEGREDO`), { code: 'PERMISSION_DENIED' }) } });
    const r = await m.store.readSnapshot();
    expect(r).toEqual({ ok: false, erro: 'PERMISSION_DENIED' });
    expect(JSON.stringify(r)).not.toMatch(/SEGREDO|firebaseio/);
  });
  it('erro sem código vira só o NOME do erro (nunca a mensagem)', async () => {
    const m = montar({ fail: { get: () => new Error(`algo em ${URL}`) } });
    const r = await m.store.readEpisode();
    expect(r).toEqual({ ok: false, erro: 'Error' });
    expect(JSON.stringify(r)).not.toMatch(/firebaseio/);
  });
  it('leitura que não responde no prazo vira "timeout"', async () => {
    const m = montar();
    const lento = createObservationWatchStore({
      env: { OBSERVATION_DATABASE_URL: URL, FIREBASE_SERVICE_ACCOUNT_JSON: CRED },
      firebase: { ...createFakeFirebase(m.rtdb), getDatabaseWithUrl: () => ({ ref: () => ({ get: () => new Promise(() => {}) }), getRulesJSON: async () => REGRAS_SEGURAS }) },
      timeoutMs: 20,
    });
    expect(await lento.readSnapshot()).toEqual({ ok: false, erro: 'timeout' });
  });
});

describe('gravação do episódio — só depois de conferir as regras publicadas', () => {
  it('setEpisode grava no nó fixo e confere as regras ANTES', async () => {
    const m = montar();
    expect(await m.store.setEpisode(EP)).toEqual({ ok: true });
    expect(m.rtdb.calls.map((c) => c.op)).toEqual(['rules', 'set']);
    expect(m.rtdb.read(EPISODE_PATH)).toEqual(EP);
  });
  it('patchEpisode atualiza só os campos pedidos', async () => {
    const m = montar({ initial: { observation: { episode: EP } } });
    const chave = `sent/${encodeKeyPart('op.1/x')}/stop`;
    expect(await m.store.patchEpisode({ [chave]: { at: 'x' }, alerts_sent: 1, announced: true })).toEqual({ ok: true });
    expect(m.rtdb.read(EPISODE_PATH)).toMatchObject({ ...EP, alerts_sent: 1, announced: true, sent: { [encodeKeyPart('op.1/x')]: { stop: { at: 'x' } } } });
  });
  it('regras abertas: NÃO grava e devolve "regras_abertas" (ao reler a cada tentativa)', async () => {
    const m = montar({ rules: REGRAS_ABERTAS });
    expect(await m.store.setEpisode(EP)).toEqual({ ok: false, erro: 'regras_abertas' });
    expect(await m.store.patchEpisode({ ended_at: 'x' })).toEqual({ ok: false, erro: 'regras_abertas' });
    expect(m.rtdb.writes()).toEqual([]);
    expect(m.rtdb.rulesCalls()).toBe(2); // resultado "aberto" nunca é lembrado
  });
  it('regras ilegíveis: NÃO grava (falha para o lado seguro)', async () => {
    const m = montar({ fail: { rules: () => new Error(`sem permissão em ${URL}`) } });
    expect(await m.store.setEpisode(EP)).toEqual({ ok: false, erro: 'regras_nao_verificadas' });
    expect(m.rtdb.writes()).toEqual([]);
  });
  it('só o resultado "seguro" é lembrado: as regras são lidas uma vez por processo', async () => {
    const m = montar();
    await m.store.setEpisode(EP);
    await m.store.patchEpisode({ alerts_sent: 1 });
    await m.store.patchEpisode({ alerts_sent: 2 });
    expect(m.rtdb.rulesCalls()).toBe(1);
  });
  it('regras corrigidas depois de recusadas liberam a gravação sozinhas', async () => {
    const rtdb = createFakeRtdb({ rules: REGRAS_ABERTAS });
    const store = createObservationWatchStore({ env: { OBSERVATION_DATABASE_URL: URL, FIREBASE_SERVICE_ACCOUNT_JSON: CRED }, firebase: createFakeFirebase(rtdb), timeoutMs: 50 });
    expect((await store.setEpisode(EP)).ok).toBe(false);
    // o usuário publica as regras certas
    rtdb.db.getRulesJSON = async () => REGRAS_SEGURAS;
    expect((await store.setEpisode(EP)).ok).toBe(true);
  });
  it('nó observation com regra própria aberta também é recusado', async () => {
    const m = montar({ rules: { rules: { observation: { '.read': true } } } });
    expect(await m.store.setEpisode(EP)).toEqual({ ok: false, erro: 'regras_abertas' });
  });
  it('erro de gravação vira só o código', async () => {
    const m = montar({ fail: { set: () => Object.assign(new Error(`url ${URL}`), { code: 'NETWORK_ERROR' }) } });
    expect(await m.store.setEpisode(EP)).toEqual({ ok: false, erro: 'NETWORK_ERROR' });
  });
});

describe('o que pode ser gravado (defesa em profundidade)', () => {
  it('setEpisode recusa o que não parece um episódio', async () => {
    const m = montar();
    for (const lixo of [null, undefined, 'x', 5, [], {}, { started_at: 5 }]) {
      expect(await m.store.setEpisode(lixo)).toEqual({ ok: false, erro: 'episodio_invalido' });
    }
    expect(m.rtdb.writes()).toEqual([]);
  });
  it('patchEpisode só aceita as chaves conhecidas', async () => {
    const m = montar({ initial: { observation: { episode: EP } } });
    const boas = [
      { alerts_sent: 2 }, { announced: true }, { start_notice_sent: true }, { ended_at: '2026-11-12T12:00:00.000Z' },
      { [`sent/${encodeKeyPart('op1')}/stop`]: { at: 'x' } }, { [`sent/${encodeKeyPart('a.b#c')}/tp1_full`]: { at: 'x' } },
    ];
    for (const b of boas) expect(await m.store.patchEpisode(b), JSON.stringify(b)).toEqual({ ok: true });
    const ruins = [
      {}, null, 'x', { status: 'watching' }, { 'sent/../x': 1 }, { '../snapshot': null }, { sent: null }, { 'sent/op1/qualquer': 1 }, { 'sent/a.b/stop': 1 },
      { 'sent//stop': 1 }, { 'sent/op1/stop/extra': 1 }, { '/': 1 }, { 'observation/snapshot': null },
    ];
    for (const r of ruins) expect(await m.store.patchEpisode(r), JSON.stringify(r)).toEqual({ ok: false, erro: 'chave_invalida' });
  });
  it('nunca toca fora de observation/snapshot (leitura) e observation/episode', async () => {
    const m = montar({ initial: { observation: { snapshot: { version: 1 }, episode: EP } } });
    await m.store.readSnapshot();
    await m.store.readEpisode();
    await m.store.setEpisode(EP);
    await m.store.patchEpisode({ alerts_sent: 1 });
    const caminhos = new Set(m.rtdb.calls.filter((c) => c.path).map((c) => c.path));
    expect([...caminhos].sort()).toEqual([EPISODE_PATH, SNAPSHOT_PATH]);
    // e a gravação NUNCA toca o retrato (quem o escreve é o armazenamento da O1)
    expect(m.rtdb.writes().every((w) => w.path === EPISODE_PATH)).toBe(true);
  });
});

describe('app do Firebase', () => {
  it('usa o app NOMEADO e nunca o padrão', async () => {
    const m = montar();
    await m.store.readSnapshot();
    expect(m.inits()).toBe(1);
    expect(OBSERVATION_APP_NAME).toBe('observation');
    expect(m.initArgs[0][0]).toMatchObject({ databaseURL: URL });
    expect(m.initArgs[0][1]).toBe('observation'); // 2º argumento = nome; sem ele o Firebase criaria o app PADRÃO (do adminTelegram)
  });
  it('reaproveita o app nomeado se a gravação do retrato (O1) já o criou', async () => {
    const m = montar({ apps: [{ name: '[DEFAULT]' }, { name: OBSERVATION_APP_NAME }] });
    await m.store.readSnapshot();
    await m.store.setEpisode(EP);
    expect(m.inits()).toBe(0);
  });
  it('credencial ilegível vira "credencial_invalida", sem repetir nada dela', async () => {
    const m = montar({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: '{ não é json SEGREDO' } });
    const r = await m.store.readSnapshot();
    expect(r).toEqual({ ok: false, erro: 'credencial_invalida' });
    expect(JSON.stringify(r)).not.toMatch(/SEGREDO/);
  });
  it('credencial ausente também', async () => {
    const m = montar({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: undefined } });
    expect(await m.store.readSnapshot()).toEqual({ ok: false, erro: 'credencial_invalida' });
  });
  it('nenhum método lança, mesmo com o Firebase quebrando ao inicializar', async () => {
    const rtdb = createFakeRtdb();
    const store = createObservationWatchStore({
      env: { OBSERVATION_DATABASE_URL: URL, FIREBASE_SERVICE_ACCOUNT_JSON: CRED },
      firebase: { ...createFakeFirebase(rtdb), initializeApp: () => { throw Object.assign(new Error(`boom ${URL}`), { code: 'app/duplicate-app' }); } },
      timeoutMs: 50,
    });
    // o código tem "/", que não passa no filtro de códigos seguros: cai no nome do erro
    expect(await store.readSnapshot()).toEqual({ ok: false, erro: 'Error' });
    expect(await store.setEpisode(EP)).toEqual({ ok: false, erro: 'Error' });
  });
});
