// Item 285 (addenda 2-4) — calendário fixo dos EUA (Plano B do BLS bloqueado). Prova que a
// lista nunca vira alerta com data duvidosa, que o fuso usa Intl (não −4h/−5h)
// e que a sonda reprova lista inválida ou vencida.
import { describe, it, expect } from 'vitest';
import {
  US_RELEASES, STATUS, KINDS, KIND_TIMES, validateCalendar, calendarEvents, alertableEvents, calendarCoverage,
  staticCalendarProbeResult, COVERAGE_WARN_DAYS, compareWithFixedList, formatComparison,
} from './contextCalendar.mjs';
import { summarize } from './contextProbe.mjs';

const NOW = Date.UTC(2026, 9, 29, 16, 0, 0); // 29/10/2026 16:00 UTC
const clone = () => US_RELEASES.map((e) => ({ ...e, fontes: [...e.fontes] }));

describe('lista fixa de datas', () => {
  it('a lista entregue é válida', () => {
    expect(validateCalendar(US_RELEASES)).toEqual([]);
  });

  it('só vira alerta o que é oficial ou tem 2+ fontes; data duvidosa fica "a confirmar" e muda', () => {
    const ids = alertableEvents(US_RELEASES).map((e) => e.id);
    expect(ids).toEqual([
      'nfp-2026-10', 'cpi-2026-10', 'ppi-2026-10', 'pce-2026-10', 'nfp-2026-11',
      'fomc-2026-12', 'cpi-2026-11', 'ppi-2026-11', 'pce-2026-11',
    ]);
    const pend = calendarEvents(US_RELEASES).filter((e) => !e.confirmed).map((e) => e.id);
    expect(pend).toEqual(['nfp-2026-12', 'cpi-2026-12']);
    for (const e of calendarEvents(US_RELEASES).filter((x) => !x.confirmed)) expect(e.note).toBeTruthy();
  });

  it('horário de Nova York → UTC pelo fuso real: 08:30 ET = 13:30Z em novembro (inverno), 12:30Z no verão', () => {
    const byId = Object.fromEntries(calendarEvents(US_RELEASES).map((e) => [e.id, e]));
    // O horário de verão dos EUA acabou em 01/11/2026 → depois disso é UTC−5.
    expect(byId['nfp-2026-10'].startsAtUtc).toBe('2026-11-06T13:30:00.000Z');
    expect(byId['cpi-2026-10'].startsAtUtc).toBe('2026-11-10T13:30:00.000Z');
    // Um CPI de verão (fora da lista, só para provar que não é deslocamento fixo): UTC−4.
    const verao = calendarEvents([{ id: 'x', kind: 'CPI', reference: '2026-06', date: '2026-07-14', time: '08:30', status: STATUS.OFICIAL, fontes: ['https://api.stlouisfed.org/x'] }]);
    expect(verao[0].startsAtUtc).toBe('2026-07-14T12:30:00.000Z');
  });

  it('PPI/PCE às 08:30 e FOMC às 14:00 de Nova York (horário de inverno a partir de 01/11)', () => {
    const byId = Object.fromEntries(calendarEvents(US_RELEASES).map((e) => [e.id, e]));
    expect(byId['ppi-2026-10'].startsAtUtc).toBe('2026-11-13T13:30:00.000Z');
    expect(byId['pce-2026-10'].startsAtUtc).toBe('2026-11-25T13:30:00.000Z');
    expect(byId['fomc-2026-12'].startsAtUtc).toBe('2026-12-09T19:00:00.000Z');
    // Todo tipo da lista tem hora padrão, e toda linha usa a hora do seu tipo.
    expect(Object.keys(KIND_TIMES).sort()).toEqual(Object.keys(KINDS).sort());
    for (const e of US_RELEASES) expect(e.time, e.id).toBe(KIND_TIMES[e.kind]);
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
    const l = clone(); l[0].status = STATUS.CONFIRMADA; l[0].fontes = ['a'];
    expect(validateCalendar(l).join('|')).toMatch(/exige 2\+ fontes/);
    const r = clone(); r[0].status = STATUS.CONFIRMADA; r[0].fontes = ['a', 'a'];
    expect(validateCalendar(r).join('|')).toMatch(/exige 2\+ fontes/);
  });

  it("'oficial' sem fonte oficial (BLS, FRED, Fed ou BEA) é reprovada — terceiros não sobem de nível sozinhos", () => {
    const l = clone(); l[0].fontes = ['https://www.financecalendar.com/us-jobs-report/', 'https://thriveinmarkets.com/x'];
    expect(validateCalendar(l).join('|')).toMatch(/exige uma fonte oficial/);
    const fred = clone(); fred[0].fontes = ['https://api.stlouisfed.org/fred/release/dates?release_id=50'];
    expect(validateCalendar(fred)).toEqual([]);
    // Domínio parecido não engana: só o começo exato da URL conta.
    const falso = clone(); falso[0].fontes = ['https://www.bls.gov.example.com/x'];
    expect(validateCalendar(falso).join('|')).toMatch(/exige uma fonte oficial/);
  });

  it('hora diferente da do tipo é reprovada (FOMC às 08:30 viraria alerta na hora errada)', () => {
    const l = clone(); l.find((e) => e.id === 'fomc-2026-12').time = '08:30';
    expect(validateCalendar(l).join('|')).toMatch(/fomc-2026-12: horário 08:30 diferente do de FOMC \(14:00/);
    const c = clone(); c[0].time = '10:00';
    expect(validateCalendar(c).join('|')).toMatch(/nfp-2026-10: horário 10:00 diferente do de NFP/);
  });

  it("site do Fed e do BEA contam como fonte oficial; domínio parecido não", () => {
    const fed = clone(); fed.find((e) => e.id === 'fomc-2026-12').fontes = ['https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'];
    expect(validateCalendar(fed)).toEqual([]);
    const bea = clone(); bea.find((e) => e.id === 'pce-2026-10').fontes = ['https://www.bea.gov/news/schedule'];
    expect(validateCalendar(bea)).toEqual([]);
    const falso = clone(); falso.find((e) => e.id === 'fomc-2026-12').fontes = ['https://www.federalreserve.gov.example.com/x'];
    expect(validateCalendar(falso).join('|')).toMatch(/fomc-2026-12: 'oficial' exige uma fonte oficial/);
  });

  it("'a_confirmar' sem nota, status/tipo desconhecidos e data inválida", () => {
    const l = clone(); delete l.find((e) => e.id === 'nfp-2026-12').nota;
    expect(validateCalendar(l).join('|')).toMatch(/precisa de nota/);
    const s = clone(); s[0].status = 'talvez';
    expect(validateCalendar(s).join('|')).toMatch(/status desconhecido/);
    const k = clone(); k[0].kind = 'GDP';
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
    expect(cov.futureConfirmed).toBe(9);
    expect(cov.lastConfirmedUtc).toBe('2026-12-23T13:30:00.000Z'); // PCE de 23/12 (era o CPI de 10/12)
    expect(cov.daysLeft).toBe(54);
    expect(cov.warn).toBe(54 < COVERAGE_WARN_DAYS); // < 60 dias: já avisa
    expect(cov.warn).toBe(true);
  });

  it('vence quando a última data confirmada passa', () => {
    const cov = calendarCoverage(US_RELEASES, Date.UTC(2026, 11, 24));
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
    expect(r.detail).toMatch(/9 oficial\(is\) \(BLS\/FRED\/Fed\/BEA\), 0 de terceiros, 2 a confirmar/);
    expect(r.detail).toMatch(/ATENÇÃO: só 54 dia/);
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

describe('comparação com fonte externa (só informa)', () => {
  it('bate / ausente na fonte / só na fonte, dentro da janela da lista', () => {
    const cmp = compareWithFixedList('CPI', ['2026-11-10', '2026-12-11', '2025-01-15', '2027-06-10']);
    expect(cmp.bate).toEqual(['2026-11-10']);
    expect(cmp.ausenteNaFonte).toEqual(['2026-12-10', '2027-01-13']);
    expect(cmp.soNaFonte).toEqual(['2026-12-11']); // 2025 e 2027-06 estão fora da janela da lista
    expect(formatComparison(cmp)).toBe('vs lista fixa — bate: 2026-11-10; ausente na fonte: 2026-12-10, 2027-01-13; só na fonte: 2026-12-11');
  });

  it('não muda a lista (é só leitura)', () => {
    const antes = JSON.stringify(US_RELEASES);
    compareWithFixedList('NFP', ['2026-11-06']);
    expect(JSON.stringify(US_RELEASES)).toBe(antes);
  });

  it('tipo sem datas na lista → diz isso, sem inventar', () => {
    const cmp = compareWithFixedList('NFP', ['2026-11-06'], []);
    expect(cmp.semLista).toBe(true);
    expect(formatComparison(cmp)).toMatch(/sem datas desse tipo/);
  });
});
