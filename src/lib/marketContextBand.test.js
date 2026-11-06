// Contexto de Mercado — Fase 3: a lógica pura da faixa de eventos. O que se prova: o JSON da rede é validado linha a
// linha (lixo é ignorado, nunca quebra), só aparece evento de agora em diante (mais os que saíram há ≤ 30 min), o
// estado "desatualizado" existe de verdade, a hora é convertida de UTC (inclusive na virada do horário de verão dos
// EUA) e a chave de desligar tolera localStorage indisponível.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  STALE_AFTER_MS, JUST_RELEASED_MS, MAX_EVENTS_SHOWN, APPROACH_HORIZON_MS, BAND_STATES, EVENT_LABELS, EVENT_META, IMPACT_LABELS,
  CATEGORY_META, parseEventValues, eventValueSlots,
  RESULT_CARD_MS, RESULT_KINDS, HISTORY_SHOWN, splitValueText, valueNumber, compareValues, resultRows, resultEvents, releaseHistory,
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

describe('categoria do evento — a cor identifica o TIPO da notícia, nunca "bom/ruim"', () => {
  it('todo tipo do coletor tem uma categoria que existe, com rótulo em texto', () => {
    for (const kind of Object.keys(EVENT_LABELS)) {
      const cat = EVENT_META[kind].category;
      expect(Object.keys(CATEGORY_META)).toContain(cat);
      expect(CATEGORY_META[cat].label.length).toBeGreaterThan(2);
    }
  });
  it('emprego = Payroll; juros = FOMC; inflação = CPI, PPI e PCE', () => {
    expect(EVENT_META.NFP.category).toBe('emprego');
    expect(EVENT_META.FOMC.category).toBe('juros');
    expect(['CPI', 'PPI', 'PCE'].map((k) => EVENT_META[k].category)).toEqual(['inflacao', 'inflacao', 'inflacao']);
  });
  it('rótulos neutros: nenhum fala de alta, baixa, bom ou ruim', () => {
    const texto = Object.values(CATEGORY_META).map((c) => c.label).join(' ');
    expect(texto).not.toMatch(/alta|baixa|bom|ruim|compra|venda|probabilidade/i);
  });
});

describe('números oficiais do evento (Anterior / Atual) — o arquivo vem da rede', () => {
  it('parseEventValues aceita textos curtos e a fonte; descarta o resto', () => {
    expect(parseEventValues({ previous: '151 mil', actual: '175 mil', source: 'BLS' })).toEqual({ previous: '151 mil', actual: '175 mil', revised: null, source: 'BLS' });
    expect(parseEventValues({ previous: '3,2%' })).toEqual({ previous: '3,2%', actual: null, revised: null, source: null });
  });
  it('sem nenhum número válido = null (a tela não desenha espaço vazio)', () => {
    for (const v of [null, undefined, 7, 'texto', [], {}, { previous: 12 }, { previous: '' }, { previous: '   ' }, { source: 'BLS' }]) {
      expect(parseEventValues(v)).toBeNull();
    }
  });
  it('texto longo demais ou com caractere de controle não passa (nada vindo da rede vira marcação)', () => {
    expect(parseEventValues({ previous: 'x'.repeat(25) })).toBeNull();
    expect(parseEventValues({ previous: 'x'.repeat(24) })?.previous).toBe('x'.repeat(24));
    expect(parseEventValues({ previous: '1\u0000 mil\u001b' })?.previous).toBe('1 mil');
  });
  it('parseEvents leva os números adiante só quando são válidos; evento sem números continua igual', () => {
    const out = parseEvents([
      { ...ev('NFP-x', 'NFP', '2026-11-06T13:30:00.000Z'), values: { previous: '151 mil', source: 'BLS' } },
      { ...ev('CPI-x', 'CPI', '2026-11-10T13:30:00.000Z'), values: { previous: { x: 1 } } },
      ev('PPI-x', 'PPI', '2026-11-13T13:30:00.000Z'),
    ]);
    expect(out[0].values).toEqual({ previous: '151 mil', actual: null, revised: null, source: 'BLS' });
    expect('values' in out[1]).toBe(false);
    expect('values' in out[2]).toBe(false);
  });
  it('"Revisado" só vale junto do "Atual" (o arquivo vem da rede: revisado sozinho é descartado)', () => {
    expect(parseEventValues({ previous: '+119 mil', actual: '+81 mil', revised: '+150 mil', source: 'BLS' })).toEqual({ previous: '+119 mil', actual: '+81 mil', revised: '+150 mil', source: 'BLS' });
    expect(parseEventValues({ previous: '+119 mil', revised: '+150 mil', source: 'BLS' })?.revised).toBeNull();
    expect(parseEventValues({ previous: '+119 mil', actual: '+81 mil', revised: 150 })?.revised).toBeNull();
    expect(parseEventValues({ revised: '+150 mil' })).toBeNull();
  });
  it('eventValueSlots: Anterior e Atual; "Atual" sem número = aguardando (text null); nunca Projeção', () => {
    expect(eventValueSlots({})).toEqual([]);
    expect(eventValueSlots({ values: { previous: null, actual: null, source: 'BLS' } })).toEqual([]);
    expect(eventValueSlots({ values: { previous: '151 mil', actual: null } })).toEqual([
      { key: 'previous', label: 'Anterior', text: '151 mil' },
      { key: 'actual', label: 'Atual', text: null },
    ]);
    expect(eventValueSlots({ values: { previous: '151 mil', actual: '175 mil' } }).map((x) => x.text)).toEqual(['151 mil', '175 mil']);
    expect(eventValueSlots({ values: { previous: null, actual: '175 mil' } }).map((x) => x.key)).toEqual(['actual']);
    const todos = ['', '151 mil'].flatMap((t) => eventValueSlots({ values: { previous: t || null, actual: '1' } }).map((x) => x.label));
    expect(todos.join(' ')).not.toMatch(/proje/i);
  });
});

// Resultado (addendum 15): o texto por extenso, a comparação neutra e a escolha de quais eventos viram cartão de resultado e histórico.
describe('splitValueText — "m/m" e "a/a" por extenso', () => {
  it('CPI/PPI: no mês e em 12 meses; Payroll: no mês; o valor sai sem a sigla', () => {
    expect(splitValueText('+0,3% m/m · +3,0% a/a')).toEqual([
      { key: 'mom', label: 'no mês', value: '+0,3%' },
      { key: 'yoy', label: 'em 12 meses', value: '+3,0%' },
    ]);
    expect(splitValueText('-0,2% m/m')).toEqual([{ key: 'mom', label: 'no mês', value: '-0,2%' }]);
    expect(splitValueText('+2,0% a/a')).toEqual([{ key: 'yoy', label: 'em 12 meses', value: '+2,0%' }]);
    expect(splitValueText('+1.234 mil')).toEqual([{ key: 'jobs', label: 'no mês', value: '+1.234 mil' }]);
  });

  it('formato desconhecido vira texto sem rótulo (nunca quebra); vazio e não-texto viram lista vazia', () => {
    expect(splitValueText('3,2%')).toEqual([{ key: 'raw', label: null, value: '3,2%' }]);
    expect(splitValueText('151 mil')).toEqual([{ key: 'jobs', label: 'no mês', value: '151 mil' }]);
    for (const v of [null, undefined, '', '   ', 5, {}, []]) expect(splitValueText(v), String(v)).toEqual([]);
  });
});

describe('valueNumber e compareValues — comparação neutra', () => {
  it('lê o número de qualquer medida (vírgula decimal, ponto de milhar, sinal, unidade)', () => {
    expect(valueNumber('+0,3%')).toBe(0.3);
    expect(valueNumber('-0,2%')).toBe(-0.2);
    expect(valueNumber('0,0%')).toBe(0);
    expect(valueNumber('+1.234 mil')).toBe(1234);
    expect(valueNumber('151 mil')).toBe(151);
    expect(valueNumber('-92 mil')).toBe(-92);
    for (const v of [null, undefined, '', 'aguardando', 'x1', {}]) expect(valueNumber(v), String(v)).toBeNull();
  });

  it('acima / abaixo / igual; sem um dos lados ou sem número: null', () => {
    expect(compareValues('+0,5%', '+0,3%')).toBe('acima');
    expect(compareValues('+0,1%', '+0,3%')).toBe('abaixo');
    expect(compareValues('+0,3%', '+0,3%')).toBe('igual');
    expect(compareValues('0,0%', '-0,0%')).toBe('igual');
    expect(compareValues('-0,1%', '+0,1%')).toBe('abaixo'); // cruzar o zero
    expect(compareValues('+81 mil', '+119 mil')).toBe('abaixo');
    expect(compareValues('+1.200 mil', '+999 mil')).toBe('acima'); // milhar com ponto
    expect(compareValues(null, '+0,3%')).toBeNull();
    expect(compareValues('+0,3%', null)).toBeNull();
    expect(compareValues('x', '+0,3%')).toBeNull();
  });
});

describe('resultRows — uma linha por medida', () => {
  const V = { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,5% m/m · +4,0% a/a', revised: '+0,4% m/m · +3,0% a/a', source: 'BLS' };

  it('CPI: Anterior, Atual e a comparação em cada medida; "Revisado" só onde mudou', () => {
    expect(resultRows(V)).toEqual([
      { key: 'mom', label: 'No mês', previous: '+0,3%', actual: '+0,5%', revised: '+0,4%', direction: 'acima' },
      { key: 'yoy', label: 'Em 12 meses', previous: '+3,0%', actual: '+4,0%', revised: null, direction: 'acima' }, // 12 meses revisado = igual ao anterior
    ]);
  });

  it('Payroll: uma linha de vagas; sem "Atual" ainda: só o Anterior e nenhuma comparação', () => {
    expect(resultRows({ previous: '+119 mil', actual: '+81 mil', source: 'BLS' })).toEqual([
      { key: 'jobs', label: 'No mês', previous: '+119 mil', actual: '+81 mil', revised: null, direction: 'abaixo' },
    ]);
    expect(resultRows({ previous: '+119 mil', actual: null, source: 'BLS' })).toEqual([
      { key: 'jobs', label: 'No mês', previous: '+119 mil', actual: null, revised: null, direction: null },
    ]);
  });

  it('valores ausentes ou sem formato conhecido não quebram', () => {
    expect(resultRows(null)).toEqual([]);
    expect(resultRows({})).toEqual([]);
    expect(resultRows({ previous: '3,2%', actual: '3,4%' })).toEqual([
      { key: 'raw', label: 'Valor', previous: '3,2%', actual: '3,4%', revised: null, direction: 'acima' },
    ]);
  });
});

describe('resultEvents e releaseHistory — quem vira cartão de resultado e quem vai para a lista', () => {
  const HORA = 3600000;
  const e = (id, kind, ago, values = { previous: '+119 mil', source: 'BLS' }, status = 'oficial') => ({ id, kind, status, startMs: NOW - ago, values });

  it('constantes', () => {
    expect(RESULT_CARD_MS).toBe(24 * HORA);
    expect(RESULT_KINDS).toEqual(['CPI', 'PPI', 'NFP']);
    expect(HISTORY_SHOWN).toBe(5);
  });

  it('resultEvents: BLS que já saiu há ≤ 24 h e traz número, mais recente primeiro; limite exato entra', () => {
    const a = e('NFP-a', 'NFP', 30 * 60000);
    const b = e('CPI-b', 'CPI', 5 * HORA, { previous: '+0,3% m/m', actual: '+0,5% m/m', source: 'BLS' });
    const limite = e('PPI-c', 'PPI', 24 * HORA);
    expect(resultEvents([b, limite, a], NOW).map((x) => x.id)).toEqual(['NFP-a', 'CPI-b', 'PPI-c']);
  });

  it('resultEvents não inclui: futuro, depois de 24 h, a confirmar, PCE/FOMC, sem número, nem lixo', () => {
    const lixo = [null, 7, {}, { kind: 'CPI' }];
    const fora = [
      e('futuro', 'CPI', -HORA),
      e('velho', 'CPI', 24 * HORA + 1),
      e('talvez', 'CPI', HORA, { previous: '+0,3% m/m', source: 'BLS' }, 'a_confirmar'),
      e('pce', 'PCE', HORA),
      e('fomc', 'FOMC', HORA),
      e('sem-numero', 'CPI', HORA, null),
      e('numeros-vazios', 'CPI', HORA, { previous: null, actual: null, source: null }),
      ...lixo,
    ];
    expect(resultEvents(fora, NOW)).toEqual([]);
    expect(resultEvents(null, NOW)).toEqual([]);
  });

  it('releaseHistory: só quem tem "Atual" e saiu há MAIS de 24 h, mais recente primeiro', () => {
    const com = (id, ago) => e(id, 'CPI', ago, { previous: '+0,3% m/m', actual: '+0,5% m/m', source: 'BLS' });
    const lista = [com('velho', 40 * 24 * HORA), com('ontem', 30 * HORA), com('recente', 3 * HORA), e('sem-atual', 'CPI', 3 * 24 * HORA), com('limite', 24 * HORA)];
    expect(releaseHistory(lista, NOW).map((x) => x.id)).toEqual(['ontem', 'velho']);
    expect(releaseHistory(null, NOW)).toEqual([]);
    expect(releaseHistory([null, 5, { startMs: NaN }], NOW)).toEqual([]);
  });

  it('data "a confirmar" nunca entra na lista, mesmo com "Atual" (uma data adiada não foi divulgação)', () => {
    const v = { previous: '+0,3% m/m', actual: '+0,5% m/m', source: 'BLS' };
    expect(releaseHistory([e('adiado', 'CPI', 3 * 24 * HORA, v, 'a_confirmar'), e('ok', 'CPI', 4 * 24 * HORA, v)], NOW).map((x) => x.id)).toEqual(['ok']);
  });

  it('um evento nunca está nos dois lugares (cartão de resultado e lista) ao mesmo tempo', () => {
    const lista = [-1, 0, 1, 23, 24, 25, 48].map((h) => e(`E${h}`, 'CPI', h * HORA + (h === 24 ? 0 : 1), { previous: '+0,3% m/m', actual: '+0,5% m/m', source: 'BLS' }));
    const noCartao = new Set(resultEvents(lista, NOW).map((x) => x.id));
    for (const x of releaseHistory(lista, NOW)) expect(noCartao.has(x.id), x.id).toBe(false);
  });
});
