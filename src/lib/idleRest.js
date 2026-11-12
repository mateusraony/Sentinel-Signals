// Repouso do painel por inatividade (docs/known-risks.md item 301, decisão do usuário no item 300).
//
// Por que existe: o Neon grátis só dorme depois de 5 min sem atividade, e QUALQUER aba do painel aberta consulta o banco a cada <= 2 min (o auto-scan do
// navegador e o monitor do logger rodam até com a aba escondida). Uma aba esquecida aberta mantém o banco acordado o dia todo (~3,6 CU-h/dia) e consome a
// folga do mês em ~10 dias. Este módulo decide QUANDO o painel está "parado": depois de IDLE_REST_MS sem mouse, teclado, toque, rolagem ou foco, entra em
// repouso; qualquer atividade acorda na hora.
//
// O que ESTE módulo faz: só o estado (repouso ou não) e os avisos de transição. Quem pausa de fato (o `useAutoScan`, o monitor do logger e as atualizações
// automáticas das telas) lê `isResting()`/`subscribeResting()` e vive nos seus próprios arquivos.
//
// Núcleo PURO e testável: relógio, temporizador e alvo de eventos entram por parâmetro; nada toca `window`/`document` no carregamento do módulo (o
// singleton é criado só no primeiro uso). Os eventos de atividade só gravam o instante (sem temporizador novo por evento): o único temporizador, quando
// dispara, confere quanto tempo passou de verdade, então uma rajada de `mousemove` custa uma atribuição por evento.

export const IDLE_REST_MS = 20 * 60 * 1000;

/** Eventos que contam como "o usuário está aqui". `scroll` não borbulha: o ouvinte é registrado em captura. */
export const ACTIVITY_EVENTS = Object.freeze(['mousemove', 'mousedown', 'pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll']);

/**
 * @param {{ idleMs?: number, target?: EventTarget|null, doc?: (EventTarget & { visibilityState?: string })|null,
 *           now?: () => number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (id: any) => void }} [opcoes]
 */
export function createIdleRest({
  idleMs = IDLE_REST_MS,
  target = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let running = false;
  let resting = false;
  let lastActivity = 0;
  let timerId = null;
  const subscribers = new Set();

  const notify = (value) => {
    for (const fn of [...subscribers]) {
      try { fn(value); } catch { /* um ouvinte com defeito não pode derrubar os outros nem a transição */ }
    }
  };

  const schedule = (ms) => {
    if (timerId !== null) clearTimer(timerId);
    timerId = setTimer(onTimer, ms);
  };

  function onTimer() {
    timerId = null;
    if (!running) return;
    const elapsed = now() - lastActivity;
    if (elapsed >= idleMs) {
      if (!resting) {
        resting = true;
        notify(true);
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
    lastActivity = now();
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
    if (resting) {
      resting = false;
      notify(false);
    }
  }

  /** Acorda por código (botão "Retomar agora"). Sem efeito se não está em repouso. */
  function wake() {
    if (!running || !resting) return;
    onActivity();
  }

  return {
    start,
    stop,
    wake,
    isResting: () => resting,
    subscribe(fn) {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
  };
}

// --- singleton do painel (criado só no primeiro uso: importar este módulo não toca window/document) -----------------------------------------------

let singleton = null;
const instance = () => (singleton ??= createIdleRest());

/** O painel está em repouso agora? Sem `startIdleRest()` nunca está (testes, scripts, SSR). */
export const isResting = () => (singleton ? singleton.isResting() : false);
export const subscribeResting = (fn) => instance().subscribe(fn);
export const startIdleRest = () => instance().start();
export const stopIdleRest = () => { if (singleton) singleton.stop(); };
export const wakeFromRest = () => { if (singleton) singleton.wake(); };
