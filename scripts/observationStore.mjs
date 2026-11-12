// Modo de observação sem banco, fase O1 (docs/known-risks.md item 299): grava o retrato no Realtime Database (RTDB).
//
// Regras desta camada (travadas por scripts/observationTripwire.test.js):
//  - UM nó fixo, `observation/snapshot`. O nó não tem regra em database.rules.json: o RTDB nega por padrão e só o Admin SDK (que ignora as regras)
//    alcança. As regras do RTDB do projeto são abertas a qualquer visitante anônimo; abrir este nó expõe entrada, stop e alvos de operações reais
//    (travado por scripts/databaseRulesTripwire.test.js).
//  - App NOMEADO (`observation`), nunca o app padrão: o `adminTelegram.js` usa o padrão para os marcadores de alerta e continua onde está.
//  - A URL vem de OBSERVATION_DATABASE_URL, NÃO de FIREBASE_DATABASE_URL: com esta última no scan, os marcadores de alerta passariam do Firestore
//    para o RTDB (e um RTDB fora do ar sem cooldown faria o alerta de cota repetir a cada passada).
//  - Prazo na gravação e falha só como CÓDIGO: o log do Actions é público e a mensagem de um erro do Firebase pode trazer a URL do projeto.
//  - ANTES da 1ª gravação de cada processo lê as regras PUBLICADAS no Firebase (`getRulesJSON`) e SÓ grava se elas deixam o nó fechado (mesma análise de
//    scripts/observationRules.mjs que confere o arquivo do repositório). O arquivo pode divergir do publicado (o deploy das regras é manual; um projeto
//    novo do Firebase nasce em "modo de teste", com leitura aberta). Se as regras expõem o nó, ou não dá para lê-las, NÃO grava (falha para o lado seguro).
//  - Sem a URL não há efeito nenhum: nada é inicializado, nada é gravado.
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getDatabaseWithUrl } from 'firebase-admin/database';
import { withTimeout } from './scanTimeout.mjs';
import { safeErrorCode, isTimeoutError } from './observationSnapshot.mjs';
import { problemasDasRegrasDoRtdb } from './observationRules.mjs';

export const OBSERVATION_APP_NAME = 'observation';
export const SNAPSHOT_PATH = 'observation/snapshot';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Reexportado com o nome que o teste do armazenamento usa. */
export const writeTimeoutError = isTimeoutError;

const defaultFirebase = { initializeApp, getApps, cert, getDatabaseWithUrl };

const codeError = (code) => Object.assign(new Error(code), { code });

/**
 * @param {{ env?: Record<string, string|undefined>, firebase?: object, timeoutMs?: number }} [opcoes]
 * @returns {{ enabled: boolean, write: (snapshot: object) => Promise<{ ok: boolean, skipped?: string, erro?: string }> }}
 */
export function createObservationStore({ env = process.env, firebase = defaultFirebase, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = typeof env?.OBSERVATION_DATABASE_URL === 'string' ? env.OBSERVATION_DATABASE_URL.trim() : '';
  let db = null;
  let regrasVerificadas = false; // só o resultado "seguro" é lembrado: corrigir as regras publicadas libera a gravação na tentativa seguinte

  function getDb() {
    if (db) return db;
    const existente = firebase.getApps().find((a) => a.name === OBSERVATION_APP_NAME);
    let app = existente;
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

  async function write(snapshot) {
    if (!url) return { ok: false, skipped: 'sem_url' };
    try {
      if (!snapshot || typeof snapshot !== 'object') throw codeError('retrato_invalido');
      const banco = getDb();
      if (!regrasVerificadas) {
        let publicadas;
        try {
          publicadas = await withTimeout(banco.getRulesJSON(), timeoutMs, 'observationRules');
        } catch {
          throw codeError('regras_nao_verificadas'); // sem repetir nada do erro (pode trazer a URL do projeto)
        }
        if (problemasDasRegrasDoRtdb(publicadas).length > 0) throw codeError('regras_abertas');
        regrasVerificadas = true;
      }
      await withTimeout(banco.ref(SNAPSHOT_PATH).set(snapshot), timeoutMs, 'observationSnapshot');
      return { ok: true };
    } catch (err) {
      return { ok: false, erro: safeErrorCode(err) };
    }
  }

  return { enabled: Boolean(url), write };
}
