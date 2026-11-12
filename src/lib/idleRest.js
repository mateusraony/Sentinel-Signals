// Repouso do painel por inatividade (docs/known-risks.md item 301, decisão do usuário no item 300).
//
// Por que existe: o Neon grátis só dorme depois de 5 min sem atividade, e QUALQUER aba do painel aberta consulta o banco a cada <= 2 min (o auto-scan do
// navegador e o monitor do logger rodam até com a aba escondida). Uma aba esquecida aberta mantém o banco acordado o dia todo (~3,6 CU-h/dia) e consome a
// folga do mês em ~10 dias. Este módulo decide QUANDO o painel está "parado": depois de IDLE_REST_MS sem mouse, teclado, toque ou roda do mouse, entra em
// repouso; qualquer atividade acorda na hora.
//
// Dois modos além do normal:
//  - REPOUSO: não congela a tela (quem pausa e atualiza de tempos em tempos é o hook `useIdleRest`, a cada REST_REFRESH_MS).
//  - AO VIVO por tempo limitado (botão "Manter ao vivo"): durante LIVE_MS o painel NÃO entra em repouso mesmo sem ninguém mexendo. Acabado o prazo, volta à
//    regra normal: se já passou IDLE_REST_MS desde a última atividade, entra em repouso na hora. LIVE_MS é MAIOR que IDLE_REST_MS de propósito: com um prazo
//    menor o botão não mudaria nada (quem clica e sai já ficaria ao vivo IDLE_REST_MS de qualquer jeito).
//
// O que ESTE módulo faz: só o estado e os avisos de transição. Quem pausa de fato (o `useAutoScan`, o monitor do logger e as atualizações automáticas das
// telas) lê `isResting()`/`subscribeResting()` e vive nos seus próprios arquivos.
//
// Núcleo PURO e testável: relógio, temporizador e alvo de eventos entram por parâmetro; nada toca `window`/`document` no carregamento do módulo (o
// singleton é criado só no primeiro uso). Os eventos de atividade só gravam o instante (sem temporizador novo por evento): o único temporizador, quando
// dispara, confere quanto tempo passou de verdade, então uma rajada de `mousemove` custa uma atribuição por evento.

export const IDLE_REST_MS = 20 * 60 * 1000;
/** Em repouso a tela atualiza a cada tanto (o dado só muda a cada ~15 min, o scan); o banco dorme entre uma atualização e outra. */
export const REST_REFRESH_MS = 30 * 60 * 1000;
/** Duração do "Manter ao vivo". Maior que IDLE_REST_MS (ver o cabeçalho). */
export const LIVE_MS = 60 * 60 * 1000;

/**
 * Eventos que contam como "o usuário está aqui".
 * `scroll` NÃO está aqui de propósito: o navegador dispara `scroll` sozinho quando o conteúdo muda de altura (scroll anchoring: uma atualização de dados, uma
 * faixa que aparece) e isso acordaria o painel sem ninguém. Rolar de verdade já passa por `wheel` (roda/trackpad), `touchstart` (celular), `keydown` (setas,
 * Page Down) e `mousedown`/`pointerdown` (arrastar a barra de rolagem).
 */
export const ACTIVITY_EVENTS = Object.freeze(['mousemove', 'mousedown', 'pointerdown', 'keydown', 'touchstart', 'wheel']);

/**
 * @param {{ idleMs?: number, liveMs?: number, target?: EventTarget|null, doc?: (EventTarget & { visibilityState?: string })|null,
 *           now?: () => number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (id: any) => void }} [opcoes]
 */
export function createIdleRest({
  idleMs = IDLE_REST_MS,
  liveMs = LIVE_MS,
  target = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let running = false;
  let resting = false;
  /** @type {number|null} */
  let liveUntil = null;
  let lastActivity = 0;
  let timerId = null;
  /** @type {{ resting: boolean, liveUntil: number|null }} */
  let state = Object.freeze({ resting: false, liveUntil: null });
  const subscribers = new Set();
  const stateSubscribers = new Set();

  const call = (set, value) => {
    for (const fn of [...set]) {
      try { fn(value); } catch { /* um ouvinte com defeito não pode derrubar os outros nem a transição */ }
    }
  };
  const notify = (value) => call(subscribers, value);
  /** Fotografia imutável (nova só quando algo mudou, para `useSyncExternalStore`). */
  const emitState = () => {
    if (state.resting === resting && state.liveUntil === liveUntil) return;
    state = Object.freeze({ resting, liveUntil });
    call(stateSubscribers, state);
  };

  const schedule = (ms) => {
    if (timerId !== null) clearTimer(timerId);
    timerId = setTimer(onTimer, ms);
  };

  function onTimer() {
    timerId = null;
    if (!running) return;
    const t = now();
    if (liveUntil !== null) {
      if (t < liveUntil) { schedule(liveUntil - t); return; } // ao vivo: nada a decidir antes do fim do prazo
      liveUntil = null; // o prazo acabou: volta à regra normal (abaixo), que pode entrar em repouso já
      emitState();
    }
    const elapsed = t - lastActivity;
    if (elapsed >= idleMs) {
      if (!resting) {
        resting = true;
        notify(true);
        emitState();
      }
    } else {
      schedule(idleMs - elapsed); // disparou cedo: reagenda só o que falta
    }
  }

  function onActivity() {
    if (!running) return;
    lastActivity = now();
    if (resting) {
      resting = false;
      notify(false);
      emitState();
      schedule(idleMs);
    }
  }

  function onVisibility() {
    // Só "voltou a ficar visível" conta: esconder a aba NÃO é atividade (uma aba esquecida tem que ir para o repouso).
    if (doc?.visibilityState === 'visible') onActivity();
  }

  function start() {
    if (running) return;
    running = true;
    resting = false;
    liveUntil = null;
    lastActivity = now();
    emitState();
    if (target?.addEventListener) {
      for (const tipo of ACTIVITY_EVENTS) target.addEventListener(tipo, onActivity, { passive: true, capture: true });
      target.addEventListener('focus', onActivity);
    }
    doc?.addEventListener?.('visibilitychange', onVisibility);
    if (target) schedule(idleMs); // sem alvo de eventos (SSR/teste sem DOM) nunca haveria como acordar: nunca entra em repouso
  }

  function stop() {
    if (!running) return;
    running = false;
    if (target?.removeEventListener) {
      for (const tipo of ACTIVITY_EVENTS) target.removeEventListener(tipo, onActivity, { capture: true });
      target.removeEventListener('focus', onActivity);
    }
    doc?.removeEventListener?.('visibilitychange', onVisibility);
    if (timerId !== null) {
      clearTimer(timerId);
      timerId = null;
    }
    const estavaEmRepouso = resting;
    resting = false;
    liveUntil = null;
    if (estavaEmRepouso) notify(false);
    emitState();
  }

  /** Acorda por código. Sem efeito se não está em repouso. */
  function wake() {
    if (!running || !resting) return;
    onActivity();
  }

  /** "Manter ao vivo": durante `ms` (padrão LIVE_MS) o painel não entra em repouso. Acorda se estava em repouso. Chamar de novo renova o prazo. */
  function startLive(ms = liveMs) {
    if (!running || !(ms > 0)) return;
    const t = now();
    lastActivity = t;
    liveUntil = t + ms;
    if (resting) {
      resting = false;
      notify(false);
    }
    emitState();
    schedule(ms);
  }

  return {
    start,
    stop,
    wake,
    startLive,
    isResting: () => resting,
    isLive: () => liveUntil !== null,
    getState: () => state,
    subscribe(fn) {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
    subscribeState(fn) {
      stateSubscribers.add(fn);
      return () => { stateSubscribers.delete(fn); };
    },
  };
}

// --- singleton do painel (criado só no primeiro uso: importar este módulo não toca window/document) -----------------------------------------------

let singleton = null;
const instance = () => (singleton ??= createIdleRest());
const ESTADO_INICIAL = Object.freeze({ resting: false, liveUntil: null });

/** O painel está em repouso agora? Sem `startIdleRest()` nunca está (testes, scripts, SSR). */
export const isResting = () => (singleton ? singleton.isResting() : false);
/** Fotografia `{ resting, liveUntil }` (a MESMA referência enquanto nada muda). */
export const getRestState = () => (singleton ? singleton.getState() : ESTADO_INICIAL);
export const subscribeResting = (fn) => instance().subscribe(fn);
export const subscribeRestState = (fn) => instance().subscribeState(fn);
export const startIdleRest = () => instance().start();
export const stopIdleRest = () => { if (singleton) singleton.stop(); };
export const wakeFromRest = () => { if (singleton) singleton.wake(); };
export const keepLive = (ms) => { if (singleton) singleton.startLive(ms); };
