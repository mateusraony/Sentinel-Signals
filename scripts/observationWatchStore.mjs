// Modo de observação sem banco, fase O2b (docs/known-risks.md item 299): o armazenamento do VIGIA no Realtime Database.
//
// Lê o retrato (`observation/snapshot`, escrito pela O1 em scripts/observationStore.mjs) e lê/grava o episódio da queda (`observation/episode`, com o livro
// de avisos dentro). Regras desta camada (travadas por scripts/observationWatchTripwire.test.js):
//  - dois nós fixos, ambos sob `observation/`, sem regra em database.rules.json: o RTDB nega por padrão e só o Admin SDK alcança;
//  - LER não expõe nada, então leitura é livre; QUALQUER GRAVAÇÃO só acontece depois de conferir as regras PUBLICADAS (`getRulesJSON`) com a mesma análise
//    da O1 (scripts/observationRules.mjs). Regra aberta ou ilegível = não grava. Só o resultado "seguro" é lembrado no processo;
//  - o app é o NOMEADO `observation` (o mesmo da O1: se ela já o criou, é reaproveitado), nunca o padrão, que é do adminTelegram.js;
//  - a gravação do episódio só aceita um episódio de verdade e o `update` só aceita as chaves conhecidas (o livro de avisos tem a forma
//    `sent/<operação codificada>/<evento>`): um erro de código aqui não consegue apagar nem sobrescrever o retrato;
//  - prazo em toda chamada e falha só como CÓDIGO: o log do Actions é público e a mensagem de um erro do Firebase pode trazer a URL do projeto;
//  - nada aqui lança. Sem a URL não há efeito nenhum: nada é inicializado.
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getDatabaseWithUrl } from 'firebase-admin/database';
import { withTimeout } from './scanTimeout.mjs';
import { safeErrorCode } from './observationSnapshot.mjs';
import { problemasDasRegrasDoRtdb } from './observationRules.mjs';
import { SNAPSHOT_PATH, OBSERVATION_APP_NAME } from './observationStore.mjs';
import { WATCH_EVENTS } from './observationWatch.mjs';

export const EPISODE_PATH = 'observation/episode';
const DEFAULT_TIMEOUT_MS = 10_000;

const defaultFirebase = { initializeApp, getApps, cert, getDatabaseWithUrl };
const codeError = (code) => Object.assign(new Error(code), { code });

// As únicas chaves que o `update` do episódio aceita: campos escalares conhecidos e o livro de avisos `sent/<chave codificada>/<evento>`.
const SCALAR_KEYS = new Set(['alerts_sent', 'announced', 'start_notice_sent', 'ended_at']);
const LEDGER_KEY = new RegExp(`^sent/[A-Za-z0-9_~-]{1,200}/(?:${WATCH_EVENTS.join('|')})$`);
const validPatchKey = (k) => SCALAR_KEYS.has(k) || LEDGER_KEY.test(k);

/**
 * @param {{ env?: Record<string, string|undefined>, firebase?: object, timeoutMs?: number }} [opcoes]
 */
export function createObservationWatchStore({ env = process.env, firebase = defaultFirebase, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = typeof env?.OBSERVATION_DATABASE_URL === 'string' ? env.OBSERVATION_DATABASE_URL.trim() : '';
  let db = null;
  let regrasVerificadas = false; // só o resultado "seguro" é lembrado: corrigir as regras publicadas libera a gravação na tentativa seguinte

  function getDb() {
    if (db) return db;
    let app = firebase.getApps().find((a) => a.name === OBSERVATION_APP_NAME);
    if (!app) {
      let credencial;
      try {
        credencial = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
      } catch {
        throw codeError('credencial_invalida'); // sem repetir nada da credencial
      }
      if (!credencial || typeof credencial !== 'object') throw codeError('credencial_invalida');
      app = firebase.initializeApp({ credential: firebase.cert(credencial), databaseURL: url }, OBSERVATION_APP_NAME);
    }
    db = firebase.getDatabaseWithUrl(url, app);
    return db;
  }

  async function ensureRulesSafe(banco) {
    if (regrasVerificadas) return;
    let publicadas;
    try {
      publicadas = await withTimeout(banco.getRulesJSON(), timeoutMs, 'observationWatchRules');
    } catch {
      throw codeError('regras_nao_verificadas'); // sem repetir nada do erro (pode trazer a URL do projeto)
    }
    if (problemasDasRegrasDoRtdb(publicadas).length > 0) throw codeError('regras_abertas');
    regrasVerificadas = true;
  }

  async function read(path) {
    if (!url) return { ok: false, skipped: 'sem_url' };
    try {
      const snap = await withTimeout(getDb().ref(path).get(), timeoutMs, 'observationWatchRead');
      return { ok: true, value: snap.exists() ? snap.val() : null };
    } catch (err) {
      return { ok: false, erro: safeErrorCode(err) };
    }
  }

  async function setEpisode(episode) {
    if (!url) return { ok: false, skipped: 'sem_url' };
    try {
      if (!episode || typeof episode !== 'object' || Array.isArray(episode) || typeof episode.started_at !== 'string') throw codeError('episodio_invalido');
      const banco = getDb();
      await ensureRulesSafe(banco);
      await withTimeout(banco.ref(EPISODE_PATH).set(episode), timeoutMs, 'observationWatchSet');
      return { ok: true };
    } catch (err) {
      return { ok: false, erro: safeErrorCode(err) };
    }
  }

  async function patchEpisode(updates) {
    if (!url) return { ok: false, skipped: 'sem_url' };
    try {
      const keys = updates && typeof updates === 'object' && !Array.isArray(updates) ? Object.keys(updates) : [];
      if (keys.length === 0 || !keys.every(validPatchKey)) throw codeError('chave_invalida');
      const banco = getDb();
      await ensureRulesSafe(banco);
      await withTimeout(banco.ref(EPISODE_PATH).update(updates), timeoutMs, 'observationWatchUpdate');
      return { ok: true };
    } catch (err) {
      return { ok: false, erro: safeErrorCode(err) };
    }
  }

  return {
    enabled: Boolean(url),
    readSnapshot: () => read(SNAPSHOT_PATH),
    readEpisode: () => read(EPISODE_PATH),
    setEpisode,
    patchEpisode,
  };
}
