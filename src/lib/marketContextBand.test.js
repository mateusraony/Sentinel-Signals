// Contexto de Mercado — Fase 3: a lógica pura da faixa de eventos. O que se prova: o JSON da rede é validado linha a
// linha (lixo é ignorado, nunca quebra), só aparece evento de agora em diante (mais os que saíram há ≤ 30 min), o
// estado "desatualizado" existe de verdade, a hora é convertida de UTC (inclusive na virada do horário de verão dos
// EUA) e a chave de desligar tolera localStorage indisponível.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  STALE_AFTER_MS, JUST_RELEASED_MS, MAX_EVENTS_SHOWN, APPROACH_HORIZON_MS, BAND_STATES, EVENT_LABELS, EVENT_META, IMPACT_LABELS,
  parseEvents, parseCheckedAt, upcomingEvents, bandState, formatCountdown, formatCountdownBare, formatEventWhen, formatAge,
  isBandEnabled, setBandEnabled,
  brtDayKey, brtDayDiff, relativeDayLabel, formatEventClock, groupEventsByDay, splitFeatured, eventUrgency, approachFraction,
} from './marketContextBand.js';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ev = (id, kind, startsAtUtc, status = 'oficial') => ({ id, kind, startsAtUtc, status, reference: '2026-10', firstSeenAt: startsAtUtc, lastChangedAt: startsAtUtc });

describe('parseEvents — o JSON vem da rede e pode vir ruim', () => {
  it('aceita as linhas bem formadas e devolve o instante em ms', () => {
    const out = parseEvents([ev('CPI-2026-11-10', 'CPI', '2026-11-10T13:30:00.000Z')]);
    expect(out).toEqual([{ id: 'CPI-2026-11-10', kind: 'CPI', status: 'oficial', startsAtUtc: '2026-11-10T13:30:00.000Z', startMs: Date.parse('2026-11-10T13:30:00.000Z') }]);
  });

  it('ignora linha com tipo/situação desconhecidos, hora inválida ou sem id — sem lançar', () => {
    const out = parseEvents([
      ev('A', 'XYZ', '2026-11-10T13:30:00.000Z'),
      ev('B', 'CPI', 'ontem'),
      ev('C', 'CPI', '2026-11-10T13:30:00.000Z', 'talvez'),
      { kind: 'CPI', status: 'oficial', startsAtUtc: '2026-11-10T13:30:00.000Z' },
      null, 7, 'texto', [],
      ev('D', 'NFP', '2026-11-06T13:30:00.000Z', 'a_confirmar'),
    ]);
    expect(out.map((e) => e.id)).toEqual(['D']);
  });

  it('id repetido: vale o primeiro (senão a tela teria key duplicada)', () => {
    const out = parseEvents([
      ev('CPI-x', 'CPI', '2026-11-10T13:30:00.000Z'),
      ev('CPI-x', 'CPI', '2026-11-11T13:30:00.000Z', 'a_confirmar'),
      ev('NFP-y', 'NFP', '2026-11-06T13:30:00.000Z'),
    ]);
    expect(out.map((e) => e.id)).toEqual(['CPI-x', 'NFP-y']);
    expect(out[0].startsAtUtc).toBe('2026-11-10T13:30:00.000Z');
    // Uma linha inválida NÃO reserva o id (a seguinte, válida, ainda entra).
    expect(parseEvents([ev('Z', 'XYZ', '2026-11-10T13:30:00.000Z'), ev('Z', 'CPI', '2026-11-10T13:30:00.000Z')]).map((e) => e.id)).toEqual(['Z']);
  });

  it('lança só quando o corpo nem é uma lista (vira "indisponível")', () => {
    expect(() => parseEvents({ eventos: [] })).toThrow();
    expect(() => parseEvents(null)).toThrow();
    expect(parseEvents([])).toEqual([]);
  });

  it('parseCheckedAt lê a hora da última checagem e recusa o resto', () => {
    expect(parseCheckedAt({ checkedAt: '2026-11-05T10:00:00.000Z' })).toBe(Date.parse('2026-11-05T10:00:00.000Z'));
    expect(parseCheckedAt({ checkedAt: 'x' })).toBeNull();
    expect(parseCheckedAt(null)).toBeNull();
  });
});

describe('upcomingEvents — de agora em diante', () => {
  const events = parseEvents([
    ev('PASSADO', 'PPI', '2026-11-03T13:30:00.000Z'),
    ev('SAIU', 'CPI', new Date(NOW - 10 * 60000).toISOString()),
    ev('SAIU-HA-1H', 'PCE', new Date(NOW - 60 * 60000).toISOString()),
    ev('B', 'NFP', '2026-11-06T13:30:00.000Z'),
    ev('A', 'CPI', '2026-11-06T13:30:00.000Z'),
    ev('C', 'FOMC', '2026-12-09T19:00:00.000Z'),
    ev('D', 'PPI', '2026-12-15T13:30:00.000Z'),
    ev('E', 'PCE', '2026-12-23T13:30:00.000Z'),
  ]);

  it('tira o passado, mantém o que saiu há ≤ 30 min (phase "agora"), ordena por hora e id', () => {
    const out = upcomingEvents(events, NOW);
    expect(out.map((e) => e.id)).toEqual(['SAIU', 'A', 'B', 'C', 'D', 'E']);
    expect(out[0].phase).toBe('agora');
    expect(out[1].phase).toBe('futuro');
    expect(JUST_RELEASED_MS).toBe(30 * 60000);
  });

  it('limita a quantidade mostrada', () => {
    expect(upcomingEvents(events, NOW)).toHaveLength(MAX_EVENTS_SHOWN);
    expect(upcomingEvents(events, NOW, 2)).toHaveLength(2);
  });

  it('aceita entrada ruim sem lançar', () => {
    expect(upcomingEvents(null, NOW)).toEqual([]);
    expect(upcomingEvents([{ id: 'x' }], NOW)).toEqual([]);
  });
});

describe('bandState — os 4 estados', () => {
  const ok = [{ id: 'a' }];
  it('desligado vence tudo', () => {
    expect(bandState({ enabled: false, events: ok, checkedAtMs: NOW, nowMs: NOW })).toBe(BAND_STATES.OFF);
  });
  it('sem dado (rede, branch ainda inexistente) = indisponível', () => {
    expect(bandState({ enabled: true, events: null, checkedAtMs: null, nowMs: NOW })).toBe(BAND_STATES.UNAVAILABLE);
  });
  it('checagem recente = atualizado', () => {
    expect(bandState({ enabled: true, events: ok, checkedAtMs: NOW - 5 * 3600000, nowMs: NOW })).toBe(BAND_STATES.FRESH);
  });
  it('checagem velha (> 36 h) ou sem hora = desatualizado', () => {
    expect(bandState({ enabled: true, events: ok, checkedAtMs: NOW - STALE_AFTER_MS - 1, nowMs: NOW })).toBe(BAND_STATES.STALE);
    expect(bandState({ enabled: true, events: ok, checkedAtMs: null, nowMs: NOW })).toBe(BAND_STATES.STALE);
    expect(bandState({ enabled: true, events: ok, checkedAtMs: NOW - STALE_AFTER_MS, nowMs: NOW })).toBe(BAND_STATES.FRESH); // exatamente 36 h ainda vale
  });
});

describe('formatação', () => {
  it('contagem regressiva', () => {
    expect(formatCountdown(0)).toBe('agora');
    expect(formatCountdown(-5)).toBe('agora');
    expect(formatCountdown(30 * 1000)).toBe('em menos de 1 min');
    expect(formatCountdown(12 * 60000)).toBe('em 12 min');
    expect(formatCountdown(5 * 3600000)).toBe('em 5h');
    expect(formatCountdown(5 * 3600000 + 20 * 60000)).toBe('em 5h 20min');
    expect(formatCountdown(3 * 86400000)).toBe('em 3d');
    expect(formatCountdown(3 * 86400000 + 4 * 3600000 + 5000)).toBe('em 3d 4h');
    expect(formatCountdown(NaN)).toBe('agora');
  });

  it('hora de Brasília a partir de UTC — inclusive antes e depois do fim do horário de verão dos EUA (01/11/2026)', () => {
    // CPI 08:30 de Nova York: 12:30 UTC em horário de verão (até 31/10), 13:30 UTC depois. Brasília é UTC-3 o ano todo.
    expect(formatEventWhen('2026-10-14T12:30:00.000Z')).toBe('qua 14/10, 09:30 (Brasília)');
    expect(formatEventWhen('2026-11-10T13:30:00.000Z')).toBe('ter 10/11, 10:30 (Brasília)');
    expect(formatEventWhen('2026-12-09T19:00:00.000Z')).toBe('qua 09/12, 16:00 (Brasília)'); // FOMC 14:00 ET
    expect(formatEventWhen('lixo')).toBe('—');
  });

  it('idade da última checagem', () => {
    expect(formatAge(NOW - 5 * 60000, NOW)).toBe('há 5 min');
    expect(formatAge(NOW - 5 * 3600000, NOW)).toBe('há 5 h');
    expect(formatAge(NOW + 1000, NOW)).toBe('há 0 min');
    expect(formatAge(null, NOW)).toBeNull();
  });

  it('todo tipo do coletor tem rótulo', () => {
    expect(Object.keys(EVENT_LABELS).sort()).toEqual(['CPI', 'FOMC', 'NFP', 'PCE', 'PPI']);
  });
});

describe('chave de ligar/desligar (por navegador)', () => {
  afterEach(() => { vi.unstubAllGlobals(); try { localStorage.clear(); } catch { /* ambiente sem localStorage */ } });

  it('padrão é ligada; desligar e religar persistem', () => {
    const store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) });
    expect(isBandEnabled()).toBe(true);
    setBandEnabled(false);
    expect(isBandEnabled()).toBe(false);
    setBandEnabled(true);
    expect(isBandEnabled()).toBe(true);
  });

  it('localStorage indisponível (modo privado/quota): não lança e a faixa fica ligada', () => {
    const quebrado = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('bloqueado'); } };
    vi.stubGlobal('localStorage', quebrado);
    expect(() => setBandEnabled(false)).not.toThrow();
    expect(() => setBandEnabled(true)).not.toThrow();
    expect(isBandEnabled()).toBe(true);
  });
});

// ---- Redesenho de 04/11/2026: nomes claros, dia de Brasília, evento em destaque, urgência ----
describe('EVENT_META — nome claro e importância de referência', () => {
  it('cobre exatamente os mesmos tipos de EVENT_LABELS, com título, sigla e importância válidos', () => {
    expect(Object.keys(EVENT_META).sort()).toEqual(Object.keys(EVENT_LABELS).sort());
    for (const [kind, m] of Object.entries(EVENT_META)) {
      expect(m.title.length, kind).toBeGreaterThan(3);
      expect(m.short, kind).toBe(EVENT_LABELS[kind]);
      expect([1, 2, 3], kind).toContain(m.impact);
      expect(IMPACT_LABELS[m.impact], kind).toBeTruthy();
    }
  });

  it('texto neutro: nenhum nome ou rótulo fala de probabilidade, direção ou ordem de compra/venda', () => {
    const texto = JSON.stringify([EVENT_META, IMPACT_LABELS]);
    expect(texto).not.toMatch(/probabilidade|vai subir|vai cair|compra|venda/i);
  });

  it('alta importância para CPI, Payroll e FOMC; média para PPI e PCE (rótulo editorial, não previsão)', () => {
    expect(['CPI', 'NFP', 'FOMC'].map((k) => EVENT_META[k].impact)).toEqual([3, 3, 3]);
    expect(['PPI', 'PCE'].map((k) => EVENT_META[k].impact)).toEqual([2, 2]);
  });
});

describe('dia de Brasília — a virada é à meia-noite de Brasília, não de UTC', () => {
  it('brtDayKey converte de UTC (UTC−3, sem horário de verão)', () => {
    expect(brtDayKey(Date.parse('2026-11-05T02:59:59Z'))).toBe('2026-11-04'); // 23:59:59 em Brasília
    expect(brtDayKey(Date.parse('2026-11-05T03:00:00Z'))).toBe('2026-11-05'); // 00:00 em Brasília
  });

  it('brtDayDiff: 23:30 de Brasília → evento às 00:30 de Brasília é AMANHÃ, mesmo sendo o mesmo dia em UTC', () => {
    const now = Date.parse('2026-11-05T02:30:00Z'); // 23:30 de 04/11 em Brasília
    expect(brtDayDiff(Date.parse('2026-11-05T03:30:00Z'), now)).toBe(1);
    expect(brtDayDiff(Date.parse('2026-11-05T02:59:59Z'), now)).toBe(0);
    expect(brtDayDiff(Date.parse('2026-11-14T13:30:00Z'), now)).toBe(10);
  });

  it('relativeDayLabel', () => {
    expect([0, 1, -1, 5, -3].map(relativeDayLabel)).toEqual(['Hoje', 'Amanhã', 'Ontem', 'em 5 dias', 'há 3 dias']);
  });

  it('formatEventClock: 13:30 UTC = 10:30 de Brasília; hora inválida vira traço', () => {
    expect(formatEventClock('2026-11-06T13:30:00.000Z')).toBe('10:30');
    expect(formatEventClock('2026-12-09T19:00:00.000Z')).toBe('16:00'); // FOMC
    expect(formatEventClock('ontem')).toBe('—');
  });

  it('formatCountdownBare tira o "em "', () => {
    expect(formatCountdownBare(5 * 3600000 + 20 * 60000)).toBe('5h 20min');
    expect(formatCountdownBare(30 * 3600000)).toBe('1d 6h');
    expect(formatCountdownBare(0)).toBe('agora');
    expect(formatCountdownBare(20000)).toBe('menos de 1 min');
  });
});

describe('groupEventsByDay — os dias da linha do tempo', () => {
  const now = Date.parse('2026-11-04T19:00:00Z'); // quarta, 16:00 em Brasília
  const rows = upcomingEvents(parseEvents([
    ev('H1', 'PPI', '2026-11-04T22:00:00Z'), // hoje 19:00
    ev('H2', 'PCE', '2026-11-04T23:30:00Z'), // hoje 20:30
    ev('AM', 'CPI', '2026-11-05T13:30:00Z'), // amanhã
    ev('SEX', 'NFP', '2026-11-06T13:30:00Z'),
    ev('FOMC', 'FOMC', '2026-12-09T19:00:00Z'),
  ]), now, 50);
  const groups = groupEventsByDay(rows, now);

  it('agrupa eventos do mesmo dia de Brasília e mantém a ordem de hora', () => {
    expect(groups.map((g) => g.key)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-12-09']);
    expect(groups[0].items.map((e) => e.id)).toEqual(['H1', 'H2']);
  });

  it('rótulos: dia da semana em maiúsculas sem ponto, dia, mês e "Hoje" / "Amanhã" / "em N dias"', () => {
    expect(groups.map((g) => [g.weekday, g.day, g.month, g.relative])).toEqual([
      ['QUA', '04', '11', 'Hoje'],
      ['QUI', '05', '11', 'Amanhã'],
      ['SEX', '06', '11', 'em 2 dias'],
      ['QUA', '09', '12', 'em 35 dias'],
    ]);
    expect(groups[0].dayMonth).toBe('04/11');
  });

  it('evento às 00:30 de Brasília cai no dia seguinte (não no dia UTC)', () => {
    const g = groupEventsByDay([{ id: 'X', startMs: Date.parse('2026-11-05T03:30:00Z') }], Date.parse('2026-11-05T02:30:00Z'));
    expect(g[0].relative).toBe('Amanhã');
    expect(g[0].day).toBe('05');
  });

  it('entrada ruim não lança', () => {
    expect(groupEventsByDay(null, now)).toEqual([]);
    expect(groupEventsByDay([{ id: 'x' }, null], now)).toEqual([]);
  });
});

describe('splitFeatured — data "a confirmar" nunca vira "próximo evento"', () => {
  const mk = (id, status) => ({ id, status, startMs: 1 });
  it('o destaque é o primeiro com data firme; o resto mantém a ordem', () => {
    const { featured, rest } = splitFeatured([mk('P', 'a_confirmar'), mk('A', 'oficial'), mk('B', 'confirmada')]);
    expect(featured.id).toBe('A');
    expect(rest.map((e) => e.id)).toEqual(['P', 'B']);
  });
  it('só datas a confirmar: sem destaque', () => {
    const { featured, rest } = splitFeatured([mk('P', 'a_confirmar'), mk('Q', 'a_confirmar')]);
    expect(featured).toBeNull();
    expect(rest).toHaveLength(2);
  });
  it('lista vazia ou inválida', () => {
    expect(splitFeatured([])).toEqual({ featured: null, rest: [] });
    expect(splitFeatured(null)).toEqual({ featured: null, rest: [] });
  });
});

describe('eventUrgency e approachFraction', () => {
  const now = 1_000_000_000_000;
  const e = (deltaMs, status = 'oficial') => ({ status, startMs: now + deltaMs });
  it('pendente, agora, iminente (≤ 1 h), em24h, proximo (≤ 7 d), distante', () => {
    expect(eventUrgency(e(3600000, 'a_confirmar'), now)).toBe('pendente');
    expect(eventUrgency(e(-60000), now)).toBe('agora');
    expect(eventUrgency(e(0), now)).toBe('agora');
    expect(eventUrgency(e(3600000), now)).toBe('iminente');
    expect(eventUrgency(e(3600001), now)).toBe('em24h');
    expect(eventUrgency(e(24 * 3600000), now)).toBe('em24h');
    expect(eventUrgency(e(24 * 3600000 + 1), now)).toBe('proximo');
    expect(eventUrgency(e(APPROACH_HORIZON_MS), now)).toBe('proximo');
    expect(eventUrgency(e(APPROACH_HORIZON_MS + 1), now)).toBe('distante');
  });
  it('a barra de aproximação vai de 0 (longe) a 1 (na hora) e nunca sai do intervalo', () => {
    expect(approachFraction(APPROACH_HORIZON_MS)).toBe(0);
    expect(approachFraction(APPROACH_HORIZON_MS / 2)).toBeCloseTo(0.5);
    expect(approachFraction(0)).toBe(1);
    expect(approachFraction(-5)).toBe(1);
    expect(approachFraction(APPROACH_HORIZON_MS * 3)).toBe(0);
    expect(approachFraction(NaN)).toBe(0);
  });
});
