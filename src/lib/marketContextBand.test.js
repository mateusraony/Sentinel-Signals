// Contexto de Mercado — Fase 3: a lógica pura da faixa de eventos. O que se prova: o JSON da rede é validado linha a
// linha (lixo é ignorado, nunca quebra), só aparece evento de agora em diante (mais os que saíram há ≤ 30 min), o
// estado "desatualizado" existe de verdade, a hora é convertida de UTC (inclusive na virada do horário de verão dos
// EUA) e a chave de desligar tolera localStorage indisponível.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  STALE_AFTER_MS, JUST_RELEASED_MS, MAX_EVENTS_SHOWN, BAND_STATES, EVENT_LABELS,
  parseEvents, parseCheckedAt, upcomingEvents, bandState, formatCountdown, formatEventWhen, formatAge,
  isBandEnabled, setBandEnabled,
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
    expect(out.map((e) => e.id)).toEqual(['SAIU', 'A', 'B', 'C']);
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
