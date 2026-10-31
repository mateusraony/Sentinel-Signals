// Item 285, addendum 9 — coletor das datas do Contexto de Mercado. Rede toda simulada. O que se prova:
// o FRED manda nas datas, a lista fixa cobre quando ele falha, remarcação vira "a confirmar" (não
// alerta), uma queda do FRED não apaga nada, e NADA fora da lista fechada de campos chega ao arquivo
// público (nem chave, nem URL, nem mensagem de erro).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FRED_RELEASES, EVENT_KEYS, STATUS_KEYS, parseFredReleaseDates, buildEvents, buildStatus, eventsHash,
  assertPublicShape, fetchFredDates,
} from './contextCollect.mjs';
import { main, readPrevious } from './context-collect.mjs';
import { DEFAULT_CONFIG } from './contextBudget.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z');
// Datas reais lidas pela sonda (runs 7-8, 30/10): algumas passadas, as futuras batem com a lista fixa.
const FRED = {
  CPI: ['2026-10-14', '2026-11-10', '2026-12-10'],
  NFP: ['2026-10-02', '2026-11-06', '2026-12-04'],
  PPI: ['2026-10-15', '2026-11-13', '2026-12-15'],
  PCE: ['2026-10-29', '2026-11-25', '2026-12-23'],
};
const byId = (events) => Object.fromEntries(events.map((e) => [e.id, e]));
const fredBody = (dates) => JSON.stringify({ release_dates: dates.map((date) => ({ release_id: 1, date })) });

describe('datas do FRED', () => {
  it('lê release_dates (sem repetir, em ordem) e recusa corpo que não serve', () => {
    expect(parseFredReleaseDates(fredBody(['2026-12-10', '2026-11-10', '2026-11-10']))).toEqual(['2026-11-10', '2026-12-10']);
    expect(parseFredReleaseDates('<html>erro</html>')).toBeNull();
    expect(parseFredReleaseDates('{"release_dates":[]}')).toBeNull();
    expect(parseFredReleaseDates('{"release_dates":[{"date":"ontem"}]}')).toBeNull();
    expect(Object.keys(FRED_RELEASES)).toEqual(['CPI', 'NFP', 'PPI', 'PCE']);
  });
});

describe('montagem dos eventos', () => {
  it('FRED respondendo: datas oficiais, FOMC da lista, hora de cada tipo, só de ontem em diante', () => {
    const ev = buildEvents({ fredDatesByKind: FRED, nowMs: NOW });
    expect(ev.map((e) => e.id)).toEqual([
      'NFP-2026-11-06', 'CPI-2026-11-10', 'PPI-2026-11-13', 'PCE-2026-11-25', 'NFP-2026-12-04',
      'FOMC-2026-12-09', 'CPI-2026-12-10', 'PPI-2026-12-15', 'PCE-2026-12-23', 'NFP-2027-01-08', 'CPI-2027-01-13',
    ]);
    const m = byId(ev);
    expect(m['CPI-2026-11-10']).toMatchObject({ kind: 'CPI', reference: '2026-10', status: 'oficial', startsAtUtc: '2026-11-10T13:30:00.000Z' });
    expect(m['FOMC-2026-12-09']).toMatchObject({ status: 'oficial', startsAtUtc: '2026-12-09T19:00:00.000Z' });
    // 2027: o FRED ainda não publicou → fica como está na lista ("a confirmar", não alerta).
    expect(m['CPI-2027-01-13'].status).toBe('a_confirmar');
    // Passado (PCE de 29/10) não entra.
    expect(m['PCE-2026-10-29']).toBeUndefined();
    for (const e of ev) expect(Object.keys(e)).toEqual(EVENT_KEYS);
    for (const e of ev) expect(e.firstSeenAt).toBe('2026-10-31T12:00:00.000Z');
  });

  it('remarcação: o FRED muda a data → a nova é oficial e a antiga vira "a confirmar"', () => {
    const ev = byId(buildEvents({ fredDatesByKind: { ...FRED, CPI: ['2026-11-10', '2026-12-11'] }, nowMs: NOW }));
    expect(ev['CPI-2026-12-11']).toMatchObject({ status: 'oficial', reference: null });
    expect(ev['CPI-2026-12-10'].status).toBe('a_confirmar');
    // Data da lista ALÉM do que o FRED publicou não é rebaixada (não há o que comparar).
    const lista = [{ id: 'x', kind: 'CPI', reference: '2027-01', date: '2027-02-10', time: '08:30', status: 'oficial', fontes: [] }];
    expect(byId(buildEvents({ fredDatesByKind: FRED, fixedList: lista, nowMs: NOW }))['CPI-2027-02-10'].status).toBe('oficial');
  });

  it('FRED fora do ar para um tipo: usa a lista fixa e não rebaixa nada', () => {
    const ev = byId(buildEvents({ fredDatesByKind: { ...FRED, PPI: null }, nowMs: NOW }));
    expect(ev['PPI-2026-11-13'].status).toBe('oficial'); // vem da lista fixa (oficial pelo FRED na run 7)
    expect(ev['PPI-2026-12-15'].status).toBe('oficial');
    const tudoFora = buildEvents({ fredDatesByKind: {}, nowMs: NOW });
    expect(tudoFora.length).toBe(11); // a lista fixa sozinha cobre tudo
  });

  it('evento já publicado que some da fonte vira "a confirmar"; com a fonte fora do ar, fica como estava', () => {
    const antes = buildEvents({ fredDatesByKind: { ...FRED, CPI: ['2026-11-10', '2026-12-10', '2026-12-17'] }, nowMs: NOW });
    expect(byId(antes)['CPI-2026-12-17'].status).toBe('oficial');
    const depois = NOW + 3600000;
    const sumiu = byId(buildEvents({ fredDatesByKind: FRED, previous: antes, nowMs: depois }));
    expect(sumiu['CPI-2026-12-17']).toMatchObject({ status: 'a_confirmar', firstSeenAt: '2026-10-31T12:00:00.000Z', lastChangedAt: '2026-10-31T13:00:00.000Z' });
    const fredFora = byId(buildEvents({ fredDatesByKind: { ...FRED, CPI: null }, previous: antes, nowMs: depois }));
    expect(fredFora['CPI-2026-12-17'].status).toBe('oficial');
  });

  it('queda do FRED depois de uma remarcação mantém o que foi publicado (achado do Codex no #529)', () => {
    // 1ª coleta: o FRED move o CPI de 10/12 para 11/12 → 10/12 "a confirmar", 11/12 oficial.
    const antes = buildEvents({ fredDatesByKind: { ...FRED, CPI: ['2026-11-10', '2026-12-11'] }, nowMs: NOW });
    expect(byId(antes)['CPI-2026-12-10'].status).toBe('a_confirmar');
    // 2ª coleta com o FRED fora do ar para o CPI: a lista fixa ainda diz 10/12 "oficial", mas o publicado vale.
    const depois = byId(buildEvents({ fredDatesByKind: { ...FRED, CPI: null }, previous: antes, nowMs: NOW + 3600000 }));
    expect(depois['CPI-2026-12-10'].status).toBe('a_confirmar'); // não volta a oficial
    expect(depois['CPI-2026-12-11'].status).toBe('oficial');
    expect(depois['CPI-2026-12-10'].lastChangedAt).toBe(byId(antes)['CPI-2026-12-10'].lastChangedAt); // nada mudou
    // E o contrário: data que o FRED já confirmou não volta a "a confirmar" (o que a lista diz) numa queda.
    const confirmada = buildEvents({ fredDatesByKind: { ...FRED, CPI: ['2026-11-10', '2026-12-10', '2027-01-13'] }, nowMs: NOW });
    expect(byId(confirmada)['CPI-2027-01-13'].status).toBe('oficial');
    const naQueda = byId(buildEvents({ fredDatesByKind: { ...FRED, CPI: null }, previous: confirmada, nowMs: NOW + 3600000 }));
    expect(naQueda['CPI-2027-01-13'].status).toBe('oficial');
    // Com o FRED respondendo, ele volta a mandar (o publicado não trava a fonte principal).
    const voltou = byId(buildEvents({ fredDatesByKind: FRED, previous: antes, nowMs: NOW + 7200000 }));
    expect(voltou['CPI-2026-12-10'].status).toBe('oficial');
    expect(voltou['CPI-2026-12-11'].status).toBe('a_confirmar');
  });

  it('rodar de novo sem novidade não muda nada (mesmos eventos, mesma impressão digital)', () => {
    const a = buildEvents({ fredDatesByKind: FRED, nowMs: NOW });
    const b = buildEvents({ fredDatesByKind: FRED, previous: a, nowMs: NOW + 5 * 3600000 });
    expect(b).toEqual(a);
    expect(eventsHash(b)).toBe(eventsHash(a));
    const sa = buildStatus({ events: a, fredDatesByKind: FRED, nowMs: NOW });
    const sb = buildStatus({ events: b, fredDatesByKind: FRED, nowMs: NOW + 5 * 3600000 });
    expect(sb.hash).toBe(sa.hash);
    expect(sb.checkedAt).not.toBe(sa.checkedAt);
  });
});

describe('status.json', () => {
  it('diz se o FRED respondeu (ok / parcial / falhou) e até quando há cobertura confirmada', () => {
    const ev = buildEvents({ fredDatesByKind: FRED, nowMs: NOW });
    const s = buildStatus({ events: ev, fredDatesByKind: FRED, nowMs: NOW });
    expect(Object.keys(s)).toEqual(STATUS_KEYS);
    expect(s).toMatchObject({ version: 1, checkedAt: '2026-10-31T12:00:00.000Z', fred: 'ok', eventsCount: 11, coverageUntil: '2026-12-23T13:30:00.000Z' });
    expect(buildStatus({ events: ev, fredDatesByKind: { ...FRED, PCE: null }, nowMs: NOW }).fred).toBe('parcial');
    expect(buildStatus({ events: ev, fredDatesByKind: {}, nowMs: NOW }).fred).toBe('falhou');
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('trava do conteúdo público (repositório público: lição do item 25)', () => {
  const ev = buildEvents({ fredDatesByKind: FRED, nowMs: NOW });
  const st = buildStatus({ events: ev, fredDatesByKind: FRED, nowMs: NOW });

  it('aceita o que o coletor produz', () => {
    expect(() => assertPublicShape(ev, st)).not.toThrow();
  });

  it('recusa campo extra, texto livre, URL, id trocado e status com campo a mais', () => {
    const plantados = [
      [[{ ...ev[0], note: 'qualquer texto' }], st],
      [[{ ...ev[0], reference: 'https://api.stlouisfed.org/fred?api_key=abc' }], st],
      [[{ ...ev[0], status: 'erro: falha ao abrir https://...' }], st],
      [[{ ...ev[0], id: 'CPI-2026-11-10' }], st], // o 1º evento é NFP: id não bate com o tipo
      [[{ ...ev[0], kind: 'GDP', id: 'GDP-2026-11-06' }], st],
      [[{ ...ev[0], startsAtUtc: 'amanhã' }], st],
      [ev, { ...st, error: 'HTTP 500' }],
      [ev, { ...st, fred: 'falhou: chave abc123' }],
      [ev, { ...st, hash: 'x' }],
    ];
    for (const [e, s] of plantados) expect(() => assertPublicShape(e, s), JSON.stringify(e[0]).slice(0, 80)).toThrow(/conteúdo público recusado/);
  });
});

describe('busca no FRED', () => {
  it('sem a chave: nada é buscado e todos os tipos ficam sem resposta', async () => {
    let chamadas = 0;
    const out = await fetchFredDates({ fetchImpl: async () => { chamadas += 1; return new Response('{}'); }, env: {} });
    expect(chamadas).toBe(0);
    expect(out).toEqual({ CPI: null, NFP: null, PPI: null, PCE: null });
  });

  it('com a chave: 1 requisição por tipo, a chave só na URL; falha vira null sem mensagem', async () => {
    const KEY = 'abcdef0123456789abcdef0123456789';
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.includes('release_id=46')) throw new Error(`falha ao abrir ${url}`);
      if (url.includes('release_id=54')) return new Response('erro', { status: 503 });
      const kind = url.includes('release_id=10') ? 'CPI' : 'NFP';
      return new Response(fredBody(FRED[kind]), { status: 200 });
    };
    const out = await fetchFredDates({ fetchImpl, env: { FRED_API_KEY: KEY } });
    expect(urls).toHaveLength(4);
    for (const u of urls) expect(u).toContain(`api_key=${KEY}`);
    expect(out).toEqual({ CPI: FRED.CPI, NFP: FRED.NFP, PPI: null, PCE: null });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
});

describe('o executável (scripts/context-collect.mjs)', () => {
  it('grava events.json e status.json, a 2ª coleta sem novidade não muda os eventos, e nada vaza', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-collect-'));
    const KEY = 'fedcba9876543210fedcba9876543210';
    const fetchImpl = async (url) => {
      const kind = Object.entries(FRED_RELEASES).find(([, id]) => url.includes(`release_id=${id}&`))[0];
      return new Response(fredBody(FRED[kind]), { status: 200 });
    };
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      expect(await main(['--dir', dir], { FRED_API_KEY: KEY }, { fetchImpl, now: () => NOW })).toBe(0);
      const ev1 = fs.readFileSync(path.join(dir, 'events.json'), 'utf8');
      expect(await main(['--dir', dir], { FRED_API_KEY: KEY }, { fetchImpl, now: () => NOW + 3600000 })).toBe(0);
      const ev2 = fs.readFileSync(path.join(dir, 'events.json'), 'utf8');
      expect(ev2).toBe(ev1); // nada mudou → o git não terá o que gravar em events.json
      const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
      expect(status).toMatchObject({ fred: 'ok', eventsCount: 11, checkedAt: '2026-10-31T13:00:00.000Z' });
      for (const texto of [ev2, JSON.stringify(status), logs.join('\n')]) {
        expect(texto).not.toContain(KEY);
        expect(texto).not.toMatch(/https?:\/\//);
      }
      expect(logs.join('\n')).toMatch(/FRED: \*\*ok\*\*/);
    } finally {
      console.log = origLog;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sem --dir recusa; events.json anterior inválido não quebra a coleta', async () => {
    const origErr = console.error;
    console.error = () => {};
    try {
      expect(await main([], {}, { fetchImpl: async () => new Response('{}'), now: () => NOW })).toBe(1);
    } finally {
      console.error = origErr;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-prev-'));
    fs.writeFileSync(path.join(dir, 'events.json'), '{não é json');
    expect(readPrevious(path.join(dir, 'events.json'))).toEqual([]);
    expect(readPrevious(path.join(dir, 'nao-existe.json'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('tamanho (orçamento da branch de dados, scripts/contextBudget.mjs)', () => {
  it('status.json e cada evento cabem no que o orçamento prevê', () => {
    const ev = buildEvents({ fredDatesByKind: FRED, nowMs: NOW });
    const st = buildStatus({ events: ev, fredDatesByKind: FRED, nowMs: NOW });
    expect(Buffer.byteLength(JSON.stringify(st, null, 2))).toBeLessThan(DEFAULT_CONFIG.storage.statusBytesPerRun);
    for (const e of ev) expect(Buffer.byteLength(JSON.stringify(e, null, 2))).toBeLessThan(DEFAULT_CONFIG.storage.bytesPerEvent);
  });
});
