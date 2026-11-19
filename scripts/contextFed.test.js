// Leitor do calendário do FOMC no site do Fed — docs/known-risks.md item 285, addendum 34 (FASE DE OBSERVAÇÃO).
// O HTML abaixo imita a estrutura da página (blocos "AAAA FOMC Meetings"; pares `fomc-meeting__month` / `fomc-meeting__date`). A estrutura
// REAL é conferida pelo resumo do coletor no GitHub antes de qualquer data entrar no events.json.
// ATENÇÃO: as datas de 2027 abaixo são FICTÍCIAS (só para o teste) — não são o calendário do Fed.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './context-collect.mjs';
import { parseFomcCalendar, meetingEndDate, fetchFomcCalendar, describeFomcCalendar, FED_FOMC_URL, MEETINGS_PER_YEAR } from './contextFed.mjs';

const meeting = (month, dates, extra = '') => `
  <div class="row fomc-meeting${extra}" style="">
    <div class="fomc-meeting__month col-xs-5 col-sm-3 col-md-2"><strong>${month}</strong></div>
    <div class="fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1">${dates}</div>
    <div class="col-xs-12 col-md-4 col-lg-4 fomc-meeting__minutes">Minutes: <a href="/x.htm">HTML</a></div>
  </div>`;
const year = (y, meetings) => `<div class="panel panel-default"><div class="panel-heading"><h4><a id="${y}">${y} FOMC Meetings</a></h4></div>${meetings.join('')}</div>`;

const Y2026 = [
  ['January', '27-28'], ['March', '17-18*'], ['April', '28-29'], ['June', '16-17*'],
  ['July', '28-29'], ['September', '15-16*'], ['October', '27-28'], ['December', '8-9*'],
].map(([m, d]) => meeting(m, d));
const Y2027 = [
  ['January', '26-27'], ['March', '16-17*'], ['Apr/May', '30-1'], ['June', '15-16*'],
  ['July', '27-28'], ['September', '21-22*'], ['November', '2-3'], ['December', '14-15*'],
].map(([m, d]) => meeting(m, d));
const PAGE = `<html><body><h3>Meeting calendars and information</h3>${year(2027, Y2027)}${year(2026, Y2026)}</body></html>`;

describe('meetingEndDate — o dia do comunicado é o ÚLTIMO dia da reunião', () => {
  it('faixa simples, com asterisco (projeções), dia único e reunião que atravessa o mês', () => {
    expect(meetingEndDate(2026, 'December', '8-9*')).toBe('2026-12-09');
    expect(meetingEndDate(2026, 'January', '27-28')).toBe('2026-01-28');
    expect(meetingEndDate(2026, 'March', '9')).toBe('2026-03-09');
    expect(meetingEndDate(2027, 'Apr/May', '30-1')).toBe('2027-05-01');
    expect(meetingEndDate(2027, 'Apr/May', '30 – 1')).toBe('2027-05-01');
  });
  it('fora: reunião extraordinária, votação por escrito, mês desconhecido, dia impossível, "Apr/May" com um dia só', () => {
    expect(meetingEndDate(2026, 'March', '15 (unscheduled)')).toBeNull();
    expect(meetingEndDate(2026, 'March', '23 (notation vote)')).toBeNull();
    expect(meetingEndDate(2026, 'Smarch', '1-2')).toBeNull();
    expect(meetingEndDate(2026, 'April', '30-31')).toBeNull();
    expect(meetingEndDate(2026, 'Apr/May', '30')).toBeNull();
    expect(meetingEndDate(2026, 'June', 'TBD')).toBeNull();
  });
});

describe('parseFomcCalendar — só anos com as 8 reuniões agendadas', () => {
  it('lê cada ano da página, com as datas em ordem', () => {
    const r = parseFomcCalendar(PAGE);
    expect(r.years['2026']).toEqual(['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09']);
    expect(r.years['2027']).toEqual(['2027-01-27', '2027-03-17', '2027-05-01', '2027-06-16', '2027-07-28', '2027-09-22', '2027-11-03', '2027-12-15']);
    expect(r.rejected).toEqual({});
  });
  it('reunião extraordinária no meio do ano não conta e não derruba o ano', () => {
    const page = year(2026, [...Y2026.slice(0, 2), meeting('March', '23 (notation vote)'), ...Y2026.slice(2)]);
    expect(parseFomcCalendar(page).years['2026']).toHaveLength(MEETINGS_PER_YEAR);
  });
  it('ano incompleto (7 reuniões) ou com 9 é DESCARTADO inteiro — nunca meio calendário', () => {
    expect(parseFomcCalendar(year(2027, Y2027.slice(0, 7)))).toEqual({ years: {}, rejected: { 2027: 7 } });
    expect(parseFomcCalendar(year(2027, [...Y2027, meeting('December', '29-30')])).rejected).toEqual({ 2027: 9 });
  });
  it('fora de ordem ou repetida: descartado', () => {
    expect(parseFomcCalendar(year(2026, [...Y2026].reverse())).rejected).toEqual({ 2026: 8 });
    expect(parseFomcCalendar(year(2026, [...Y2026.slice(0, 7), Y2026[6]])).rejected).toEqual({ 2026: 7 });
  });
  it('a página não tem nenhum "AAAA FOMC Meetings": null (formato inesperado)', () => {
    expect(parseFomcCalendar('<html>manutenção</html>')).toBeNull();
    expect(parseFomcCalendar('')).toBeNull();
    expect(parseFomcCalendar(null)).toBeNull();
  });
});

describe('fetchFomcCalendar — nunca lança, devolve só um código', () => {
  it('ok, HTTP de erro, formato inesperado e rede caída', async () => {
    let seen;
    const ok = await fetchFomcCalendar({ fetchImpl: async (url) => { seen = url; return new Response(PAGE); } });
    expect(seen).toBe(FED_FOMC_URL);
    expect(ok.reason).toBe('ok');
    expect(Object.keys(ok.calendar.years).sort()).toEqual(['2026', '2027']);
    expect(await fetchFomcCalendar({ fetchImpl: async () => new Response('x', { status: 503 }) })).toEqual({ calendar: null, reason: 'http' });
    expect(await fetchFomcCalendar({ fetchImpl: async () => new Response('<html></html>') })).toEqual({ calendar: null, reason: 'formato' });
    expect(await fetchFomcCalendar({ fetchImpl: async () => { throw new Error('boom'); } })).toEqual({ calendar: null, reason: 'rede' });
  });
});

describe('describeFomcCalendar — o resumo da observação', () => {
  it('diz que é só observação, lista as datas e compara com a lista fixa', async () => {
    const fed = await fetchFomcCalendar({ fetchImpl: async () => new Response(PAGE) });
    const lines = describeFomcCalendar(fed, ['2026-12-09']);
    expect(lines[0]).toMatch(/só observação: ainda NÃO entra no events\.json/);
    expect(lines).toContain('• 2026: 8 reuniões, comunicado em 28/01, 18/03, 29/04, 17/06, 29/07, 16/09, 28/10, 09/12 — lista fixa: 1 de 1 bate(m).');
    expect(lines).toContain('• 2027: 8 reuniões, comunicado em 27/01, 17/03, 01/05, 16/06, 28/07, 22/09, 03/11, 15/12.');
  });
  it('divergência com a lista fixa aparece por extenso; ano descartado e falha também', () => {
    const fed = { calendar: { years: { 2026: ['2026-01-28', '2026-12-10'] }, rejected: { 2027: 5 } }, reason: 'ok' };
    const lines = describeFomcCalendar(fed, ['2026-12-09']);
    expect(lines).toContain('• 2026: 2 reuniões, comunicado em 28/01, 10/12 — lista fixa: 0 de 1 bate(m) (NÃO bate: 09/12).');
    expect(lines).toContain('• 2027: ano descartado (5 reunião(ões) válida(s), o esperado é 8).');
    expect(describeFomcCalendar({ calendar: null, reason: 'formato' })).toEqual(['Fed — calendário do FOMC (só observação: ainda NÃO entra no events.json): a página não está no formato esperado.']);
    expect(describeFomcCalendar(null)).toEqual([]);
  });
});

describe('o coletor (main) mostra a observação no resumo e NÃO põe as datas lidas no events.json', () => {
  it('as reuniões de 2027 lidas no Fed aparecem só no resumo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fed-'));
    const fetchImpl = async (url) => (String(url) === FED_FOMC_URL ? new Response(PAGE) : new Response('x', { status: 500 }));
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      expect(await main(['--dir', dir], {}, { fetchImpl, now: () => Date.parse('2026-11-19T15:00:00Z') })).toBe(0);
    } finally {
      console.log = orig;
    }
    const out = logs.join('\n');
    expect(out).toContain('Fed — calendário do FOMC (só observação: ainda NÃO entra no events.json):');
    expect(out).toContain('• 2026: 8 reuniões, comunicado em 28/01, 18/03, 29/04, 17/06, 29/07, 16/09, 28/10, 09/12 — lista fixa: 1 de 1 bate(m).');
    const events = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
    expect(events.filter((e) => e.kind === 'FOMC').map((e) => e.id)).toEqual(['FOMC-2026-12-09']);
  });
});
