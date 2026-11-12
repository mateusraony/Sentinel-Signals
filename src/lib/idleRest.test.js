// Repouso do painel por inatividade (docs/known-risks.md item 301): o núcleo PURO, sem React, com relógio e alvo de eventos injetados.
// Regras provadas aqui: só entra em repouso depois de IDLE_REST_MS SEM atividade; qualquer atividade acorda na hora e reinicia a contagem; aba que volta a ficar
// visível conta como atividade; cada transição avisa uma vez; parar remove todos os ouvintes; não depende de `window` no carregamento do módulo.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIdleRest, IDLE_REST_MS, REST_REFRESH_MS, LIVE_MS, ACTIVITY_EVENTS } from './idleRest.js';

const MIN = 60_000;

function montar(extra = {}) {
  const target = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const idle = createIdleRest({ target, doc, ...extra });
  return { idle, target, doc };
}
const atividade = (target, tipo = 'mousemove') => target.dispatchEvent(new Event(tipo));

describe('idleRest — constantes', () => {
  it('20 minutos, a decisão do usuário (item 300, opção 1)', () => {
    expect(IDLE_REST_MS).toBe(20 * MIN);
  });
  it('os eventos de atividade cobrem mouse, teclado, toque e roda do mouse', () => {
    for (const e of ['mousemove', 'mousedown', 'pointerdown', 'keydown', 'touchstart', 'wheel']) expect(ACTIVITY_EVENTS).toContain(e);
  });
  it('`scroll` NÃO é atividade: o navegador o dispara sozinho (scroll anchoring) e acordaria o painel sem ninguém', () => {
    expect(ACTIVITY_EVENTS).not.toContain('scroll');
  });
  it('em repouso a tela atualiza a cada 30 min (não congela); "Manter ao vivo" dura 60 min, MAIS que os 20 min do repouso (senão o botão não mudaria nada)', () => {
    expect(REST_REFRESH_MS).toBe(30 * MIN);
    expect(LIVE_MS).toBe(60 * MIN);
    expect(LIVE_MS).toBeGreaterThan(IDLE_REST_MS);
  });
});

describe('idleRest — entra e sai do repouso', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('começa ativo', () => {
    const { idle } = montar();
    idle.start();
    expect(idle.isResting()).toBe(false);
    idle.stop();
  });
  it('entra em repouso depois de 20 min sem atividade, e não antes', async () => {
    const { idle } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(20 * MIN - 1000);
    expect(idle.isResting()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('atividade no meio reinicia a contagem', async () => {
    const { idle, target } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    atividade(target);
    await vi.advanceTimersByTimeAsync(15 * MIN); // 30 min desde o início, 15 desde a atividade
    expect(idle.isResting()).toBe(false);
    await vi.advanceTimersByTimeAsync(6 * MIN); // 21 min desde a atividade
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('atividade em repouso acorda na hora', async () => {
    const { idle, target } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(idle.isResting()).toBe(true);
    atividade(target, 'keydown');
    expect(idle.isResting()).toBe(false);
    idle.stop();
  });
  it('depois de acordar, a contagem recomeça do zero (volta ao repouso só 20 min depois)', async () => {
    const { idle, target } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    atividade(target);
    await vi.advanceTimersByTimeAsync(19 * MIN);
    expect(idle.isResting()).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it.each(ACTIVITY_EVENTS)('o evento %s conta como atividade', async (tipo) => {
    const { idle, target } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(idle.isResting()).toBe(true);
    atividade(target, tipo);
    expect(idle.isResting()).toBe(false);
    idle.stop();
  });
  it('rajada de eventos (mousemove) não cria um temporizador por evento', async () => {
    const setTimer = vi.fn((fn, ms) => setTimeout(fn, ms));
    const { idle, target } = montar({ setTimer });
    idle.start();
    const antes = setTimer.mock.calls.length;
    for (let i = 0; i < 500; i += 1) atividade(target);
    expect(setTimer.mock.calls.length - antes).toBeLessThanOrEqual(1);
    idle.stop();
  });
});

describe('idleRest — visibilidade da aba', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aba que volta a ficar VISÍVEL conta como atividade (o usuário voltou)', async () => {
    const { idle, doc } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(idle.isResting()).toBe(true);
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(idle.isResting()).toBe(false);
    idle.stop();
  });
  it('aba que ESCONDE não conta como atividade (aba esquecida continua indo para o repouso)', async () => {
    const { idle, doc } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(11 * MIN);
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('foco da janela conta como atividade', async () => {
    const { idle, target } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    target.dispatchEvent(new Event('focus'));
    expect(idle.isResting()).toBe(false);
    idle.stop();
  });
  it('no instante EXATO do prazo (20 min redondos) já entra em repouso', () => {
    let agora = 0;
    const timers = [];
    const { idle } = montar({ now: () => agora, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
    idle.start();
    agora = 20 * MIN;
    timers.shift().fn();
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('a máquina que dormiu (o temporizador atrasou muito) entra em repouso no 1º disparo, não antes do prazo', async () => {
    let agora = 0;
    const timers = [];
    const { idle } = montar({ now: () => agora, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
    idle.start();
    agora = 5 * MIN;
    timers.shift().fn(); // disparou cedo demais: ainda não são 20 min sem atividade
    expect(idle.isResting()).toBe(false);
    expect(timers[0].ms).toBeGreaterThan(0); // reagendou o que faltava
    expect(timers[0].ms).toBeLessThanOrEqual(15 * MIN);
    agora = 3 * 60 * MIN; // 3 h depois (laptop dormiu)
    timers.shift().fn();
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
});

describe('idleRest — avisos de transição', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('avisa UMA vez ao entrar e UMA vez ao sair, com o valor novo', async () => {
    const { idle, target } = montar();
    const ouvinte = vi.fn();
    idle.subscribe(ouvinte);
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(ouvinte).toHaveBeenCalledTimes(1);
    expect(ouvinte).toHaveBeenLastCalledWith(true);
    atividade(target);
    atividade(target);
    atividade(target);
    expect(ouvinte).toHaveBeenCalledTimes(2);
    expect(ouvinte).toHaveBeenLastCalledWith(false);
    idle.stop();
  });
  it('atividade enquanto ativo não avisa ninguém', () => {
    const { idle, target } = montar();
    const ouvinte = vi.fn();
    idle.subscribe(ouvinte);
    idle.start();
    atividade(target);
    atividade(target, 'keydown');
    expect(ouvinte).not.toHaveBeenCalled();
    idle.stop();
  });
  it('cancelar a inscrição para de avisar', async () => {
    const { idle } = montar();
    const ouvinte = vi.fn();
    const cancelar = idle.subscribe(ouvinte);
    cancelar();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(ouvinte).not.toHaveBeenCalled();
    idle.stop();
  });
  it('um ouvinte que lança não impede os outros nem a transição', async () => {
    const { idle } = montar();
    const ruim = vi.fn(() => { throw new Error('boom'); });
    const bom = vi.fn();
    idle.subscribe(ruim);
    idle.subscribe(bom);
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(bom).toHaveBeenCalledWith(true);
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('wake() acorda por código (botão "Retomar agora")', async () => {
    const { idle } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    idle.wake();
    expect(idle.isResting()).toBe(false);
    idle.stop();
  });
  it('wake() sem estar em repouso não faz nada nem avisa', () => {
    const { idle } = montar();
    const ouvinte = vi.fn();
    idle.subscribe(ouvinte);
    idle.start();
    idle.wake();
    expect(ouvinte).not.toHaveBeenCalled();
    idle.stop();
  });
});

describe('idleRest — ciclo de vida', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('start() duas vezes não duplica ouvintes nem temporizadores', async () => {
    const { idle } = montar();
    const ouvinte = vi.fn();
    idle.subscribe(ouvinte);
    idle.start();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(ouvinte).toHaveBeenCalledTimes(1);
    idle.stop();
  });
  it('start() chamado de novo em repouso NÃO acorda nem reinicia a contagem', async () => {
    const { idle } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(idle.isResting()).toBe(true);
    idle.start();
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('stop() remove os ouvintes de atividade e o temporizador, e volta ao estado ativo', async () => {
    const { idle, target } = montar();
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');
    idle.start();
    expect(add.mock.calls.length).toBe(ACTIVITY_EVENTS.length + 1); // + 'focus'
    idle.stop();
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(40 * MIN);
    expect(idle.isResting()).toBe(false);
  });
  it('stop() estando em repouso volta a ativo e avisa', async () => {
    const { idle } = montar();
    const ouvinte = vi.fn();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    idle.subscribe(ouvinte);
    idle.stop();
    expect(idle.isResting()).toBe(false);
    expect(ouvinte).toHaveBeenCalledWith(false);
  });
  it('depois de parado, atividade não faz nada e start() recomeça do zero', async () => {
    const { idle, target } = montar();
    idle.start();
    idle.stop();
    atividade(target);
    idle.start();
    await vi.advanceTimersByTimeAsync(19 * MIN);
    expect(idle.isResting()).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('prazo personalizado', async () => {
    const { idle } = montar({ idleMs: 5 * MIN });
    idle.start();
    await vi.advanceTimersByTimeAsync(5 * MIN + 1000);
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('sem alvo de eventos (SSR/teste sem DOM) não lança e nunca entra em repouso', async () => {
    const idle = createIdleRest({ target: null, doc: null });
    expect(() => idle.start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(idle.isResting()).toBe(false);
    expect(() => idle.stop()).not.toThrow();
  });
});

describe('idleRest — o módulo não faz trabalho ao ser importado', () => {
  it('importar não toca window nem document', async () => {
    const mod = await import('./idleRest.js');
    expect(typeof mod.isResting).toBe('function');
    expect(mod.isResting()).toBe(false); // sem start(): nunca em repouso
  });
});


describe('idleRest — "Manter ao vivo" (tempo limitado)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ao vivo o painel NÃO entra em repouso nem depois de 20 min sem ninguém mexer', async () => {
    const { idle } = montar();
    idle.start();
    idle.startLive();
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(idle.isResting()).toBe(false);
    expect(idle.isLive()).toBe(true);
    idle.stop();
  });
  it('acabado o prazo (60 min) sem ninguém ter mexido, entra em repouso NA HORA (já passou muito mais que 20 min)', async () => {
    const { idle } = montar();
    idle.start();
    idle.startLive();
    await vi.advanceTimersByTimeAsync(60 * MIN + 1000);
    expect(idle.isLive()).toBe(false);
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('acabado o prazo com atividade recente, continua ativo e a contagem normal de 20 min recomeça da última atividade', async () => {
    const { idle, target } = montar();
    idle.start();
    idle.startLive();
    await vi.advanceTimersByTimeAsync(55 * MIN);
    atividade(target); // t = 55 min
    await vi.advanceTimersByTimeAsync(6 * MIN); // t = 61: o prazo acabou, só 6 min desde a atividade
    expect(idle.isLive()).toBe(false);
    expect(idle.isResting()).toBe(false);
    await vi.advanceTimersByTimeAsync(15 * MIN); // 21 min desde a atividade
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('clicar em repouso acorda e fica ao vivo', async () => {
    const { idle } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(idle.isResting()).toBe(true);
    idle.startLive();
    expect(idle.isResting()).toBe(false);
    expect(idle.isLive()).toBe(true);
    idle.stop();
  });
  it('avisa quem ouve o repouso (boolean) ao acordar pelo botão', async () => {
    const { idle } = montar();
    const ouvinte = vi.fn();
    idle.subscribe(ouvinte);
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    idle.startLive();
    expect(ouvinte.mock.calls.map((c) => c[0])).toEqual([true, false]);
    idle.stop();
  });
  it('clicar de novo RENOVA o prazo a partir de agora', async () => {
    const { idle } = montar();
    idle.start();
    idle.startLive();
    await vi.advanceTimersByTimeAsync(50 * MIN);
    idle.startLive();
    await vi.advanceTimersByTimeAsync(30 * MIN); // t = 80 min: o prazo antigo (60) já teria acabado
    expect(idle.isLive()).toBe(true);
    expect(idle.isResting()).toBe(false);
    idle.stop();
  });
  it('a fotografia de estado traz { resting, liveUntil } e só muda de referência quando algo muda', async () => {
    const { idle } = montar();
    const inicial = idle.getState();
    expect(inicial).toEqual({ resting: false, liveUntil: null });
    idle.start();
    expect(idle.getState()).toBe(inicial); // nada mudou: mesma referência (useSyncExternalStore não pode re-renderizar à toa)
    idle.startLive();
    const ao_vivo = idle.getState();
    expect(ao_vivo.resting).toBe(false);
    expect(ao_vivo.liveUntil).toBe(Date.now() + LIVE_MS);
    await vi.advanceTimersByTimeAsync(61 * MIN);
    expect(idle.getState()).toEqual({ resting: true, liveUntil: null });
    idle.stop();
  });
  it('quem ouve a fotografia é avisado em cada transição, e parar de ouvir funciona', async () => {
    const { idle } = montar();
    const ouvinte = vi.fn();
    const cancelar = idle.subscribeState(ouvinte);
    idle.start();
    idle.startLive();
    expect(ouvinte).toHaveBeenCalledTimes(1);
    expect(ouvinte.mock.calls[0][0].liveUntil).not.toBeNull();
    cancelar();
    await vi.advanceTimersByTimeAsync(61 * MIN);
    expect(ouvinte).toHaveBeenCalledTimes(1);
    idle.stop();
  });
  it('stop() encerra o "ao vivo" e volta ao estado inicial', () => {
    const { idle } = montar();
    idle.start();
    idle.startLive();
    idle.stop();
    expect(idle.isLive()).toBe(false);
    expect(idle.getState()).toEqual({ resting: false, liveUntil: null });
  });
  it('sem start() ou com prazo inválido, startLive() não faz nada', () => {
    const { idle } = montar();
    idle.startLive();
    expect(idle.isLive()).toBe(false);
    idle.start();
    idle.startLive(0);
    idle.startLive(-5);
    expect(idle.isLive()).toBe(false);
    idle.stop();
  });
  it('o "ao vivo" não acorda por rolagem nem depende dela: rolar sozinho não é atividade', async () => {
    const { idle, target } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    target.dispatchEvent(new Event('scroll'));
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('depois de repouso, "Manter ao vivo" também EXPIRA (o temporizador é rearmado) e volta ao repouso', async () => {
    const { idle } = montar();
    idle.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);
    idle.startLive();
    expect(idle.isLive()).toBe(true);
    await vi.advanceTimersByTimeAsync(61 * MIN);
    expect(idle.isLive()).toBe(false);
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
  it('o fim do prazo atualiza a fotografia mesmo continuando ativo (a barra para de dizer "ao vivo até")', async () => {
    const { idle, target } = montar();
    const ouvinte = vi.fn();
    idle.subscribeState(ouvinte);
    idle.start();
    idle.startLive();
    await vi.advanceTimersByTimeAsync(55 * MIN);
    atividade(target);
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(idle.getState()).toEqual({ resting: false, liveUntil: null });
    const ultima = ouvinte.mock.calls.at(-1)[0];
    expect(ultima).toEqual({ resting: false, liveUntil: null });
    idle.stop();
  });
  it('disparo do temporizador ANTES do fim do prazo (ex.: o de repouso, já agendado) não entra em repouso: reagenda só o que falta', () => {
    let agora = 0;
    const timers = [];
    const { idle } = montar({ now: () => agora, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
    idle.start(); // timers[0]: o de repouso (20 min)
    idle.startLive(); // timers[1]: o do fim do prazo (60 min)
    agora = 25 * MIN; // já passou dos 20 min sem atividade, mas o "ao vivo" vai até 60 min
    timers[0].fn();
    expect(idle.isResting()).toBe(false);
    expect(idle.isLive()).toBe(true);
    expect(timers.at(-1).ms).toBe(35 * MIN); // reagendou exatamente o que falta para o fim do prazo
    idle.stop();
  });
  it('com "ao vivo" MENOR que o repouso, a contagem de inatividade conta a partir do clique (não da última atividade antiga)', async () => {
    const { idle } = montar({ liveMs: 5 * MIN });
    idle.start();
    await vi.advanceTimersByTimeAsync(10 * MIN); // 10 min sem mexer
    idle.startLive(); // clique: conta como atividade; ao vivo até o minuto 15
    await vi.advanceTimersByTimeAsync(5 * MIN + 1000); // minuto 15: o prazo acabou, só 5 min desde o clique
    expect(idle.isResting()).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * MIN); // minuto 25: 15 min desde o clique: ainda ativo (20 min)
    expect(idle.isResting()).toBe(false);
    await vi.advanceTimersByTimeAsync(6 * MIN); // minuto 31: 21 min desde o clique
    expect(idle.isResting()).toBe(true);
    idle.stop();
  });
});
