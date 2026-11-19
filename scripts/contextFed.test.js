// Leitor do calendário do FOMC no site do Fed — docs/known-risks.md item 285, addenda 34 e 36.
// O HTML abaixo imita a estrutura REAL da página (blocos "AAAA FOMC Meetings"; pares `fomc-meeting__month` / `fomc-meeting__date`): a coleta de 19/11/2026
// leu 2021–2026 com 8 reuniões cada, e 2026 bateu com a lista fixa. As datas de 2027 dos testes são de teste (dias da semana válidos); 2024 é o calendário
// real, usado para provar os casos difíceis (reunião que cruza o mês e a de quarta a quinta, na semana da eleição).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './context-collect.mjs';
import { buildEvents } from './contextCollect.mjs';
import {
  parseFomcCalendar, meetingEndDate, fetchFomcCalendar, describeFomcCalendar, fomcDatesFromCalendar, FED_FOMC_URL, MEETINGS_PER_YEAR,
} from './contextFed.mjs';

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
  ['January', '26-27'], ['March', '16-17*'], ['April', '27-28'], ['June', '8-9*'],
  ['July', '27-28'], ['September', '14-15*'], ['October', '26-27'], ['November', '16-17*'],
].map(([m, d]) => meeting(m, d));
const Y2024 = [
  ['January', '30-31'], ['March', '19-20*'], ['Apr/May', '30-1'], ['June', '11-12*'],
  ['July', '30-31'], ['September', '17-18*'], ['November', '6-7'], ['December', '17-18*'],
].map(([m, d]) => meeting(m, d));
const PAGE = `<html><body><h3>Meeting calendars and information</h3>${year(2027, Y2027)}${year(2026, Y2026)}${year(2024, Y2024)}</body></html>`;
const D2027 = ['2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-11-17'];

describe('meetingEndDate — o dia do comunicado é o ÚLTIMO dia da reunião', () => {
  it('faixa simples, com asterisco (projeções), dia único e reunião que atravessa o mês', () => {
    expect(meetingEndDate(2026, 'December', '8-9*')).toBe('2026-12-09');
    expect(meetingEndDate(2026, 'January', '27-28')).toBe('2026-01-28');
    expect(meetingEndDate(2026, 'March', '9')).toBe('2026-03-09');
    expect(meetingEndDate(2024, 'Apr/May', '30-1')).toBe('2024-05-01');
    expect(meetingEndDate(2024, 'Apr/May', '30 – 1')).toBe('2024-05-01');
  });
  it('fora: reunião extraordinária, votação por escrito, mês desconhecido, dia impossível, "Apr/May" com um dia só', () => {
    expect(meetingEndDate(2026, 'March', '15 (unscheduled)')).toBeNull();
    expect(meetingEndDate(2026, 'March', '23 (notation vote)')).toBeNull();
    expect(meetingEndDate(2026, 'Smarch', '1-2')).toBeNull();
    expect(meetingEndDate(2026, 'April', '30-31')).toBeNull();
    expect(meetingEndDate(2026, 'Apr/May', '30')).toBeNull();
    expect(meetingEndDate(2026, 'June', 'TBD')).toBeNull();
  });
  it('ACHADO DA REVISÃO: o fim nunca pode vir antes do começo no mesmo mês, e a reunião que cruza o mês tem o fim MENOR que o começo', () => {
    expect(meetingEndDate(2027, 'April', '30-1')).toBeNull(); // viraria 1º de abril, uma data inventada
    expect(meetingEndDate(2027, 'January', '28-27')).toBeNull();
    expect(meetingEndDate(2027, 'Apr/May', '28-29')).toBeNull(); // cruzaria o mês com o fim maior que o começo: lixo
    expect(meetingEndDate(2027, 'Apr/May', '30-30')).toBeNull();
    expect(meetingEndDate(2027, 'January', '27-27')).toBe('2027-01-27'); // mesmo dia nos dois lados é um dia só
  });
});

describe('parseFomcCalendar — só anos com as 8 reuniões agendadas, em dias da semana possíveis', () => {
  it('lê cada ano da página, com as datas em ordem (inclui a reunião que cruza o mês e a de quinta-feira de 2024)', () => {
    const r = parseFomcCalendar(PAGE);
    expect(r.years['2026']).toEqual(['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09']);
    expect(r.years['2027']).toEqual(D2027);
    expect(r.years['2024']).toEqual(['2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18']);
    expect(r.rejected).toEqual({});
    expect(r.odd).toEqual({});
  });
  it('o traço pode vir como entidade HTML (&ndash;, &#8211;): a data continua sendo lida', () => {
    const page = year(2026, Y2026.map((m, i) => (i === 0 ? meeting('January', '27&ndash;28') : i === 1 ? meeting('March', '17&#8211;18*') : m)));
    expect(parseFomcCalendar(page).years['2026'][0]).toBe('2026-01-28');
    expect(parseFomcCalendar(page).years['2026'][1]).toBe('2026-03-18');
  });
  it('reunião extraordinária no meio do ano não conta e não derruba o ano', () => {
    const page = year(2026, [...Y2026.slice(0, 2), meeting('March', '23 (notation vote)'), ...Y2026.slice(2)]);
    expect(parseFomcCalendar(page).years['2026']).toHaveLength(MEETINGS_PER_YEAR);
  });
  it('ano incompleto (7 reuniões) ou com 9 é DESCARTADO inteiro — nunca meio calendário', () => {
    expect(parseFomcCalendar(year(2027, Y2027.slice(0, 7)))).toEqual({ years: {}, rejected: { 2027: 7 }, odd: {} });
    expect(parseFomcCalendar(year(2027, [...Y2027, meeting('December', '28-29')])).rejected).toEqual({ 2027: 9 });
  });
  it('fora de ordem ou repetida: descartado', () => {
    expect(parseFomcCalendar(year(2026, [...Y2026].reverse())).rejected).toEqual({ 2026: 8 });
    expect(parseFomcCalendar(year(2026, [...Y2026.slice(0, 7), Y2026[6]])).rejected).toEqual({ 2026: 7 });
  });
  it('uma data que cai em sábado, domingo, segunda ou sexta descarta o ano (sinal de página lida errado) e o resumo diz qual', () => {
    const base = { January: '26-27', March: '16-17*', April: '27-28', June: '8-9*', July: '27-28', September: '14-15*', October: '26-27', November: '16-17*' };
    const pagina = (troca) => year(2027, Object.entries({ ...base, ...troca }).map(([m, d]) => meeting(m, d)));
    // 2027-06-14 é segunda, 2027-07-30 é sexta, 2027-09-12 é domingo, 2027-10-30 é sábado
    for (const [troca, ruim] of [[{ June: '13-14' }, '2027-06-14'], [{ July: '29-30' }, '2027-07-30'], [{ September: '11-12' }, '2027-09-12'], [{ October: '29-30' }, '2027-10-30']]) {
      const r = parseFomcCalendar(pagina(troca));
      expect(r.years).toEqual({});
      expect(r.odd['2027']).toEqual([ruim]);
    }
    expect(parseFomcCalendar(pagina({})).years['2027']).toEqual(D2027); // a base sem troca passa
  });
  it('a página não tem nenhum "AAAA FOMC Meetings": null (formato inesperado)', () => {
    expect(parseFomcCalendar('<html>manutenção</html>')).toBeNull();
    expect(parseFomcCalendar('')).toBeNull();
    expect(parseFomcCalendar(null)).toBeNull();
  });
});

describe('fomcDatesFromCalendar — as datas que o coletor USA', () => {
  const fed = { calendar: parseFomcCalendar(PAGE), reason: 'ok' };
  const NOW = Date.parse('2026-11-19T15:00:00Z');
  it('do ano corrente em diante viram eventos; as passadas (de qualquer ano aceito) vão para o histórico', () => {
    const r = fomcDatesFromCalendar(fed, NOW);
    expect(r.years).toEqual(['2026', '2027']);
    expect(r.upcoming).toEqual([...parseFomcCalendar(PAGE).years['2026'], ...D2027]);
    expect(r.past).toContain('2024-11-07');
    expect(r.past).toContain('2026-10-28');
    expect(r.past).not.toContain('2026-12-09');
    expect(r.past).not.toContain('2027-01-27');
  });
  it('Fed fora do ar, página no formato errado ou sem nenhum ano aceito: null (a lista fixa segue valendo)', () => {
    expect(fomcDatesFromCalendar(null, NOW)).toBeNull();
    expect(fomcDatesFromCalendar({ calendar: null, reason: 'rede' }, NOW)).toBeNull();
    expect(fomcDatesFromCalendar({ calendar: parseFomcCalendar(year(2027, Y2027.slice(0, 7))), reason: 'ok' }, NOW)).toBeNull();
    expect(fomcDatesFromCalendar(fed, NaN)).toBeNull();
  });
});

describe('buildEvents com as datas do Fed — regras de rebaixamento e de continuidade', () => {
  const NOW = Date.parse('2026-11-19T15:00:00Z');
  const fixed = [
    { kind: 'FOMC', reference: '2026-12', date: '2026-12-09', status: 'oficial' },
    { kind: 'FOMC', reference: '2028-01', date: '2028-01-26', status: 'oficial' },
  ];
  const fomc = { upcoming: ['2026-12-09', ...D2027], years: ['2026', '2027'] };
  const byId = (evs, id) => evs.find((e) => e.id === id);
  it('o rebaixamento vale SÓ nos anos que o Fed trouxe completos: uma data da lista fixa de 2028 (ano que ele não trouxe) fica oficial', () => {
    const evs = buildEvents({ fredDatesByKind: {}, fixedList: fixed, previous: [], nowMs: NOW, fomc });
    expect(byId(evs, 'FOMC-2028-01-26').status).toBe('oficial');
    expect(byId(evs, 'FOMC-2026-12-09').status).toBe('oficial');
    const semDezembro = buildEvents({ fredDatesByKind: {}, fixedList: fixed, previous: [], nowMs: NOW, fomc: { upcoming: D2027, years: ['2026', '2027'] } });
    expect(byId(semDezembro, 'FOMC-2026-12-09').status).toBe('a_confirmar'); // ano 2026 aceito e a data sumiu
    expect(byId(semDezembro, 'FOMC-2028-01-26').status).toBe('oficial');
  });
  it('um FOMC já publicado que ficou fora do ano aceito NÃO é rebaixado quando o Fed some ou quando o ano não vem (só o ano aceito conta)', () => {
    const publicado = buildEvents({ fredDatesByKind: {}, fixedList: [], previous: [], nowMs: NOW, fomc });
    const semFed = buildEvents({ fredDatesByKind: {}, fixedList: [], previous: publicado, nowMs: NOW, fomc: null });
    expect(semFed.filter((e) => e.kind === 'FOMC').every((e) => e.status === 'oficial')).toBe(true);
    expect(semFed.filter((e) => e.kind === 'FOMC').length).toBe(9);
    const soOutroAno = buildEvents({ fredDatesByKind: {}, fixedList: [], previous: publicado, nowMs: NOW, fomc: { upcoming: ['2029-01-31'], years: ['2029'] } });
    expect(soOutroAno.filter((e) => e.id.startsWith('FOMC-2027')).every((e) => e.status === 'oficial')).toBe(true);
  });
  it('data do Fed malformada é ignorada (não vira evento)', () => {
    const evs = buildEvents({ fredDatesByKind: {}, fixedList: [], previous: [], nowMs: NOW, fomc: { upcoming: ['lixo', '2027-01-27'], years: ['2027'] } });
    expect(evs.filter((e) => e.kind === 'FOMC').map((e) => e.id)).toEqual(['FOMC-2027-01-27']);
  });
});

describe('fetchFomcCalendar — nunca lança, devolve só um código', () => {
  it('ok, HTTP de erro, formato inesperado e rede caída', async () => {
    let seen;
    const ok = await fetchFomcCalendar({ fetchImpl: async (url) => { seen = url; return new Response(PAGE); } });
    expect(seen).toBe(FED_FOMC_URL);
    expect(ok.reason).toBe('ok');
    expect(Object.keys(ok.calendar.years).sort()).toEqual(['2024', '2026', '2027']);
    expect(await fetchFomcCalendar({ fetchImpl: async () => new Response('x', { status: 503 }) })).toEqual({ calendar: null, reason: 'http' });
    expect(await fetchFomcCalendar({ fetchImpl: async () => new Response('<html></html>') })).toEqual({ calendar: null, reason: 'formato' });
    expect(await fetchFomcCalendar({ fetchImpl: async () => { throw new Error('boom'); } })).toEqual({ calendar: null, reason: 'rede' });
  });
});

describe('describeFomcCalendar — o resumo do coletor', () => {
  it('lista as datas por ano e compara com a lista fixa', async () => {
    const fed = await fetchFomcCalendar({ fetchImpl: async () => new Response(PAGE) });
    const lines = describeFomcCalendar(fed, ['2026-12-09']);
    expect(lines[0]).toMatch(/lido da página do Fed; os anos aceitos entram no events\.json/);
    expect(lines).toContain('• 2026: 8 reuniões, comunicado em 28/01, 18/03, 29/04, 17/06, 29/07, 16/09, 28/10, 09/12 — lista fixa: 1 de 1 bate(m).');
    expect(lines).toContain('• 2027: 8 reuniões, comunicado em 27/01, 17/03, 28/04, 09/06, 28/07, 15/09, 27/10, 17/11.');
  });
  it('divergência com a lista fixa aparece por extenso; ano descartado (contagem ou dia da semana) e falha também', () => {
    const fed = { calendar: { years: { 2026: ['2026-01-28', '2026-12-10'] }, rejected: { 2027: 5 }, odd: { 2028: ['2028-05-01'] } }, reason: 'ok' };
    const lines = describeFomcCalendar(fed, ['2026-12-09']);
    expect(lines).toContain('• 2026: 2 reuniões, comunicado em 28/01, 10/12 — lista fixa: 0 de 1 bate(m) (NÃO bate: 09/12).');
    expect(lines).toContain('• 2027: ano descartado (5 reunião(ões) válida(s), o esperado é 8).');
    expect(lines).toContain('• 2028: ano descartado (data(s) que não caem de terça a quinta: 01/05).');
    expect(describeFomcCalendar({ calendar: null, reason: 'formato' })).toEqual(['Fed — calendário do FOMC (lido da página do Fed; os anos aceitos entram no events.json): a página não está no formato esperado.']);
    expect(describeFomcCalendar(null)).toEqual([]);
  });
});

describe('o coletor (main): as datas do Fed viram eventos de FOMC; o histórico ganha as reuniões passadas', () => {
  const NOW = Date.parse('2026-11-19T15:00:00Z');
  const run = async (fetchImpl, dir, env = {}) => {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      expect(await main(['--dir', dir], env, { fetchImpl, now: () => NOW })).toBe(0);
    } finally {
      console.log = orig;
    }
    return logs.join('\n');
  };
  const fedOnly = async (url) => (String(url) === FED_FOMC_URL ? new Response(PAGE) : new Response('x', { status: 500 }));

  it('events.json ganha o FOMC de 2027 (oficial, referência = mês da reunião) e mantém o de 09/12/2026; o resumo mostra o ano', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fed-'));
    const out = await run(fedOnly, dir);
    const fomc = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')).filter((e) => e.kind === 'FOMC');
    expect(fomc.map((e) => e.id)).toEqual(['FOMC-2026-12-09', ...D2027.map((d) => `FOMC-${d}`)]);
    expect(fomc.every((e) => e.status === 'oficial')).toBe(true);
    expect(fomc.find((e) => e.id === 'FOMC-2027-11-17')).toMatchObject({ reference: '2027-11', startsAtUtc: '2027-11-17T19:00:00.000Z', values: null });
    expect(out).toContain('• 2027: 8 reuniões');
  });
  it('o Fed fora do ar NÃO apaga nem rebaixa os FOMC já publicados (e a lista fixa segue valendo)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fed-'));
    await run(fedOnly, dir);
    const ruim = async () => new Response('x', { status: 500 });
    await run(ruim, dir);
    const fomc = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')).filter((e) => e.kind === 'FOMC');
    expect(fomc.map((e) => e.id)).toEqual(['FOMC-2026-12-09', ...D2027.map((d) => `FOMC-${d}`)]);
    expect(fomc.every((e) => e.status === 'oficial')).toBe(true);
  });
  it('uma data da lista fixa que o Fed não traz mais (ano aceito) é REBAIXADA para "a confirmar"; ano que o Fed não trouxe não é tocado', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fed-'));
    // a reunião de dezembro de 2026 passa de 08–09 para 09–10 (o comunicado vai de 09/12 para 10/12, uma quinta)
    const remarcado = `<html><body>${year(2027, Y2027)}${year(2026, [...Y2026.slice(0, 7), meeting('December', '9-10*')])}</body></html>`;
    await run(async (url) => (String(url) === FED_FOMC_URL ? new Response(remarcado) : new Response('x', { status: 500 })), dir);
    const fomc = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')).filter((e) => e.kind === 'FOMC');
    expect(fomc.find((e) => e.id === 'FOMC-2026-12-09').status).toBe('a_confirmar');
    expect(fomc.find((e) => e.id === 'FOMC-2026-12-10').status).toBe('oficial');
  });
  it('history.json ganha as reuniões passadas (o aviso de antes do FOMC passa a mostrar o BTC delas) e a trava pública aceita o tipo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fed-'));
    await run(fedOnly, dir);
    const h = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
    expect(h.dates.FOMC.slice(0, 3)).toEqual(['2026-10-28', '2026-09-16', '2026-07-29']);
    expect(h.dates.FOMC).not.toContain('2026-12-09'); // futura
  });
});
