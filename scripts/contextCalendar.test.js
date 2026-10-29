// Item 287 — calendário fixo dos EUA (Plano B do BLS bloqueado). Prova que a
// lista nunca vira alerta com data duvidosa, que o fuso usa Intl (não −4h/−5h)
// e que a sonda reprova lista inválida ou vencida.
import { describe, it, expect } from 'vitest';
import {
  US_RELEASES, STATUS, validateCalendar, calendarEvents, alertableEvents, calendarCoverage,
  staticCalendarProbeResult, COVERAGE_WARN_DAYS,
} from './contextCalendar.mjs';
import { summarize } from './contextProbe.mjs';

const NOW = Date.UTC(2026, 9, 29, 16, 0, 0); // 29/10/2026 16:00 UTC
const clone = () => US_RELEASES.map((e) => ({ ...e, fontes: [...e.fontes] }));

describe('lista fixa de datas', () => {
  it('a lista entregue é válida', () => {
    expect(validateCalendar(US_RELEASES)).toEqual([]);
  });

  it('só vira alerta o que tem 2+ fontes; data duvidosa fica "a confirmar" e muda', () => {
    const ids = alertableEvents(US_RELEASES).map((e) => e.id);
    expect(ids).toEqual(['nfp-2026-10', 'cpi-2026-10', 'nfp-2026-11']);
    const pend = calendarEvents(US_RELEASES).filter((e) => !e.confirmed).map((e) => e.id);
    expect(pend).toEqual(['cpi-2026-11', 'nfp-2026-12', 'cpi-2026-12']);
    for (const e of calendarEvents(US_RELEASES).filter((x) => !x.confirmed)) expect(e.note).toBeTruthy();
  });

  it('horário de Nova York → UTC pelo fuso real: 08:30 ET = 13:30Z em novembro (inverno), 12:30Z no verão', () => {
    const byId = Object.fromEntries(calendarEvents(US_RELEASES).map((e) => [e.id, e]));
    // O horário de verão dos EUA acabou em 01/11/2026 → depois disso é UTC−5.
    expect(byId['nfp-2026-10'].startsAtUtc).toBe('2026-11-06T13:30:00.000Z');
    expect(byId['cpi-2026-10'].startsAtUtc).toBe('2026-11-10T13:30:00.000Z');
    // Um CPI de verão (fora da lista, só para provar que não é deslocamento fixo): UTC−4.
    const verao = calendarEvents([{ id: 'x', kind: 'CPI', reference: '2026-06', date: '2026-07-14', time: '08:30', status: STATUS.OFICIAL, fontes: ['f'] }]);
    expect(verao[0].startsAtUtc).toBe('2026-07-14T12:30:00.000Z');
  });

  it('eventos saem em ordem cronológica', () => {
    const ms = calendarEvents(US_RELEASES).map((e) => e.startsAtMs);
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
  });
});

describe('validateCalendar reprova defeitos', () => {
  it('id repetido, fim de semana, hora inexistente, fora de ordem', () => {
    const l = clone();
    l.push({ ...l[0] });
    expect(validateCalendar(l).join('|')).toMatch(/id repetido/);

    const fds = clone(); fds[0].date = '2026-11-07'; // sábado
    expect(validateCalendar(fds).join('|')).toMatch(/fim de semana/);

    const inex = [{ id: 'a', kind: 'CPI', reference: '2027-02', date: '2027-03-14', time: '02:30', status: STATUS.OFICIAL, fontes: ['f'] }];
    expect(validateCalendar(inex).join('|')).toMatch(/inexistente/);

    const ord = clone(); [ord[0], ord[3]] = [ord[3], ord[0]];
    expect(validateCalendar(ord).join('|')).toMatch(/fora de ordem/);
  });

  it("'confirmada' com 1 fonte (ou a mesma fonte repetida) é reprovada", () => {
    const l = clone(); l[0].fontes = ['a'];
    expect(validateCalendar(l).join('|')).toMatch(/exige 2\+ fontes/);
    const r = clone(); r[0].fontes = ['a', 'a'];
    expect(validateCalendar(r).join('|')).toMatch(/exige 2\+ fontes/);
  });

  it("'a_confirmar' sem nota, status/tipo desconhecidos e data inválida", () => {
    const l = clone(); delete l.find((e) => e.id === 'cpi-2026-11').nota;
    expect(validateCalendar(l).join('|')).toMatch(/precisa de nota/);
    const s = clone(); s[0].status = 'talvez';
    expect(validateCalendar(s).join('|')).toMatch(/status desconhecido/);
    const k = clone(); k[0].kind = 'PPI';
    expect(validateCalendar(k).join('|')).toMatch(/tipo desconhecido/);
    const d = clone(); d[0].date = '2026-13-45';
    expect(validateCalendar(d).join('|')).toMatch(/data inválida/);
    expect(validateCalendar(null)).toEqual(['a lista não é um array']);
  });
});

describe('cobertura (lista que envelhece)', () => {
  it('conta só datas CONFIRMADAS à frente e avisa antes de vencer', () => {
    const cov = calendarCoverage(US_RELEASES, NOW);
    expect(cov.expired).toBe(false);
    expect(cov.futureConfirmed).toBe(3);
    expect(cov.lastConfirmedUtc).toBe('2026-12-04T13:30:00.000Z');
    expect(cov.daysLeft).toBe(35);
    expect(cov.warn).toBe(35 < COVERAGE_WARN_DAYS); // < 60 dias: já avisa
    expect(cov.warn).toBe(true);
  });

  it('vence quando a última data confirmada passa', () => {
    const cov = calendarCoverage(US_RELEASES, Date.UTC(2026, 11, 5));
    expect(cov.expired).toBe(true);
    expect(cov.futureConfirmed).toBe(0);
  });

  it('data "a confirmar" NÃO conta como cobertura', () => {
    const so = US_RELEASES.filter((e) => e.status === STATUS.A_CONFIRMAR);
    expect(calendarCoverage(so, NOW).expired).toBe(true);
  });
});

describe('linha da sonda (grupo us-calendar)', () => {
  it('lista válida e dentro do prazo → OK e o portão us-calendar abre mesmo com o BLS bloqueado', () => {
    const r = staticCalendarProbeResult(US_RELEASES, NOW);
    expect(r.status).toBe('OK');
    expect(r.detail).toMatch(/terceiros, não oficial/);
    expect(r.detail).toMatch(/ATENÇÃO: só 35 dia/);
    const bls = (id) => ({ id, required: true, group: 'us-calendar', status: 'FALHOU' });
    const sum = summarize([bls('bls-calendar'), bls('bls-cpi-page'), bls('bls-empsit-page'), r]);
    expect(sum.gateOk).toBe(true);
  });

  it('lista vencida → FALHOU (o portão volta a reprovar)', () => {
    const r = staticCalendarProbeResult(US_RELEASES, Date.UTC(2027, 0, 20));
    expect(r.status).toBe('FALHOU');
    expect(r.detail).toMatch(/vencida/);
    const bls = { id: 'bls', required: true, group: 'us-calendar', status: 'FALHOU' };
    expect(summarize([bls, r]).gateOk).toBe(false);
  });

  it('lista inválida → FALHOU com o motivo', () => {
    const l = clone(); l[0].fontes = ['a'];
    const r = staticCalendarProbeResult(l, NOW);
    expect(r.status).toBe('FALHOU');
    expect(r.detail).toMatch(/lista inválida/);
  });

  it('não-vacuidade: sem a lista fixa, o BLS bloqueado reprova o portão', () => {
    const bls = { id: 'bls', required: true, group: 'us-calendar', status: 'FALHOU' };
    expect(summarize([bls]).gateOk).toBe(false);
  });
});
