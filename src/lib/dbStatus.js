// Estado "banco sem cota" visto pelo navegador (docs/known-risks.md item 282).
//
// Quando o Neon recusa tudo, a API responde 503 `db_quota` (server/
// dbErrorResponse.js) e o painel precisa dizer isso em vez de ficar carregando.
// Este módulo guarda só o suficiente para o aviso: se está sem cota, desde
// quando, e a hora da última resposta boa do banco. É uma store mínima
// (subscribe/getSnapshot) para `useSyncExternalStore` — sem dependência nova.
//
// O estado só muda de verdade em duas transições (sem cota ↔ ok); respostas boas
// repetidas só atualizam `lastOkAt` em silêncio, sem re-render.

let lastOkAt = null;
let state = Object.freeze({ quotaExhausted: false, since: null, lastOkAt: null });
const listeners = new Set();

function emit(next) {
  state = Object.freeze(next);
  listeners.forEach((fn) => fn());
}

export function getDbStatus() {
  return state;
}

export function subscribeDbStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A API respondeu 503 `db_quota`. */
export function reportDbQuotaExhausted(now = Date.now()) {
  if (state.quotaExhausted) return;
  emit({ quotaExhausted: true, since: now, lastOkAt });
}

/** O banco respondeu (qualquer resposta que prove que ele leu/gravou). */
export function reportDbReachable(now = Date.now()) {
  lastOkAt = now;
  if (state.quotaExhausted) emit({ quotaExhausted: false, since: null, lastOkAt });
}

/** Só para testes: volta ao estado de carga do módulo. */
export function resetDbStatusForTests() {
  lastOkAt = null;
  state = Object.freeze({ quotaExhausted: false, since: null, lastOkAt: null });
  listeners.clear();
}
