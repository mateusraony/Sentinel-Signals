// Item 285, addendum 9 — coletor das datas do Contexto de Mercado. Rede toda simulada. O que se prova:
// o FRED manda nas datas, a lista fixa cobre quando ele falha, remarcação vira "a confirmar" (não
// alerta), uma queda do FRED não apaga nada, e NADA fora da lista fechada de campos chega ao arquivo
// público (nem chave, nem URL, nem mensagem de erro).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FRED_RELEASES, EVENT_KEYS, STATUS_KEYS, VALUES_KEYS, parseFredReleaseDates, buildEvents, buildStatus, eventsHash,
  assertPublicShape, fetchFredDates, sanitizePrevious, sanitizeValues,
} from './contextCollect.mjs';
import { main, readPrevious, describeBls } from './context-collect.mjs';
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
    // Data da lista que o FRED NÃO traz vira "a confirmar" também ALÉM da última que ele publicou
    // (antes ficava "oficial": achado G1 da auditoria de 31/10).
    const lista = [{ id: 'x', kind: 'CPI', reference: '2027-01', date: '2027-02-10', time: '08:30', status: 'oficial', fontes: [] }];
    expect(byId(buildEvents({ fredDatesByKind: FRED, fixedList: lista, nowMs: NOW }))['CPI-2027-02-10'].status).toBe('a_confirmar');
  });

  // Achado G1 da auditoria de 31/10: a regra antiga só rebaixava até a última data do FRED, então uma
  // antecipação ou a retirada das datas futuras deixava DOIS dias "oficiais" para o mesmo evento.
  const oficiais = (events, kind) => events.filter((e) => e.kind === kind && e.status === 'oficial').map((e) => e.id);

  it('remarcação PARA ANTES (PCE de 23/12 para 22/12): só o dia novo é oficial', () => {
    const ev = buildEvents({ fredDatesByKind: { ...FRED, PCE: ['2026-11-25', '2026-12-22'] }, nowMs: NOW });
    expect(byId(ev)['PCE-2026-12-22'].status).toBe('oficial');
    expect(byId(ev)['PCE-2026-12-23'].status).toBe('a_confirmar');
    expect(oficiais(ev, 'PCE')).toEqual(['PCE-2026-11-25', 'PCE-2026-12-22']);
  });

  it('retirada das datas futuras (o FRED responde só com datas passadas): nenhuma data futura do tipo fica oficial', () => {
    const ev = buildEvents({ fredDatesByKind: { ...FRED, PCE: ['2026-09-30', '2026-10-29'] }, nowMs: NOW });
    const pce = ev.filter((e) => e.kind === 'PCE');
    expect(pce.length).toBeGreaterThan(0);
    expect(oficiais(ev, 'PCE')).toEqual([]);
    for (const e of pce) expect(e.status).toBe('a_confirmar');
    // Os outros tipos não são afetados.
    expect(byId(ev)['CPI-2026-11-10'].status).toBe('oficial');
  });

  it('adiamento (CPI de 10/12 para 17/12): só o dia novo é oficial', () => {
    const ev = buildEvents({ fredDatesByKind: { ...FRED, CPI: ['2026-11-10', '2026-12-17'] }, nowMs: NOW });
    expect(oficiais(ev, 'CPI')).toEqual(['CPI-2026-11-10', 'CPI-2026-12-17']);
    expect(byId(ev)['CPI-2026-12-10'].status).toBe('a_confirmar');
  });

  it('nunca há dois oficiais do mesmo mês de referência por tipo (varredura de remarcações)', () => {
    const casos = [['2026-12-22'], ['2026-12-24'], ['2027-01-05'], ['2026-12-23'], []];
    for (const extra of casos) {
      const dates = ['2026-11-25', ...extra];
      const ev = buildEvents({ fredDatesByKind: { ...FRED, PCE: dates }, nowMs: NOW });
      const pceOf = oficiais(ev, 'PCE').map((id) => id.slice(4));
      expect(pceOf.every((d) => dates.includes(d)), `oficiais fora do FRED: ${pceOf} vs ${dates}`).toBe(true);
    }
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

  it('events.json anterior com linhas malformadas: descarta as ruins, não trava e a saída passa na trava pública', () => {
    const boa = buildEvents({ fredDatesByKind: FRED, nowMs: NOW })[0];
    const ruins = [
      { ...boa, id: 'CPI-2026-11-10', kind: 'CPI', status: 'oficial!!', reference: '2026-10' },
      { ...boa, id: 'PPI-2026-11-13', kind: 'PPI', reference: '<script>' },
      { ...boa, id: 'PCE-2026-11-25', kind: 'PCE', startsAtUtc: 'ontem' },
      { id: 'FOMC-2026-12-09', kind: 'CPI', status: 'oficial', reference: null, startsAtUtc: boa.startsAtUtc }, // tipo não bate com o id
      null, 42, 'texto', [], { id: 7 },
    ];
    expect(sanitizePrevious([boa, ...ruins])).toEqual([boa]);
    expect(sanitizePrevious('não é lista')).toEqual([]);
    const ev = buildEvents({ fredDatesByKind: FRED, previous: [boa, ...ruins], nowMs: NOW + 3600000 });
    const status = buildStatus({ events: ev, fredDatesByKind: FRED, nowMs: NOW + 3600000 });
    expect(() => assertPublicShape(ev, status)).not.toThrow();
    // A linha boa é aproveitada (firstSeenAt preservado); as ruins viram eventos novos.
    expect(byId(ev)[boa.id].firstSeenAt).toBe(boa.firstSeenAt);
    expect(byId(ev)['PPI-2026-11-13'].firstSeenAt).toBe('2026-10-31T13:00:00.000Z');
    // E a FRED fora do ar não copia status ruim da coleta anterior.
    const semFred = buildEvents({ fredDatesByKind: {}, previous: ruins, nowMs: NOW });
    expect(() => assertPublicShape(semFred, buildStatus({ events: semFred, fredDatesByKind: {}, nowMs: NOW }))).not.toThrow();
  });

  it('lastChangedAt acompanha a mudança do mês de referência (antes só situação e hora)', () => {
    const a = buildEvents({ fredDatesByKind: FRED, nowMs: NOW });
    const alvo = a.find((e) => e.id === 'CPI-2026-11-10');
    expect(alvo.reference).toBe('2026-10');
    const previous = a.map((e) => (e.id === alvo.id ? { ...e, reference: '2026-09' } : e));
    const b = byId(buildEvents({ fredDatesByKind: FRED, previous, nowMs: NOW + 3600000 }));
    expect(b[alvo.id].reference).toBe('2026-10');
    expect(b[alvo.id].lastChangedAt).toBe('2026-10-31T13:00:00.000Z');
    // Sem mudança nenhuma, continua igual.
    const c = byId(buildEvents({ fredDatesByKind: FRED, previous: a, nowMs: NOW + 3600000 }));
    expect(c[alvo.id].lastChangedAt).toBe(alvo.lastChangedAt);
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

  it('events.json anterior com linhas ruins NÃO trava o coletor para sempre (grava e sai com 0)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-ruim-'));
    const boa = buildEvents({ fredDatesByKind: FRED, nowMs: NOW })[0];
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify([{ ...boa, status: 'texto livre com https://x.y' }, { ...boa, id: 'CPI-2026-11-10', kind: 'CPI', reference: 'x' }]));
    const origLog = console.log;
    console.log = () => {};
    try {
      const code = await main(['--dir', dir], { FRED_API_KEY: 'k' }, { fetchImpl: async (url) => {
        const id = Number(new URL(String(url)).searchParams.get('release_id'));
        const kind = Object.entries(FRED_RELEASES).find(([, v]) => v === id)?.[0];
        return new Response(fredBody(FRED[kind]), { status: 200 });
      }, now: () => NOW });
      expect(code).toBe(0);
      const gravado = fs.readFileSync(path.join(dir, 'events.json'), 'utf8');
      expect(gravado).not.toMatch(/texto livre|https:/);
      expect(() => assertPublicShape(JSON.parse(gravado), JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')))).not.toThrow();
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

// Addendum 14 — o "Anterior" do BLS no events.json. O que se prova: sai do mês de referência certo, só para CPI/PPI/Payroll; uma queda do BLS NÃO apaga o
// que já estava publicado; evento futuro aceita o número novo (revisão) mas, DEPOIS que o evento sai, o número fica congelado; arquivo anterior ruim é
// descartado; e a trava pública só deixa passar `null` ou `{ previous, source: 'BLS' }` no formato único. Rede toda simulada, a chave nunca vaza.
describe('valor "Anterior" do BLS (addendum 14)', () => {
  const mapa = (pontos) => new Map(pontos);
  const BLS = {
    CUSR0000SA0: mapa([['2026-09', 100.3], ['2026-08', 100]]),
    CUUR0000SA0: mapa([['2026-09', 103], ['2025-09', 100]]),
    WPSFD4: mapa([['2026-09', 149.7], ['2026-08', 150]]),
    WPUFD4: mapa([['2026-09', 150.96], ['2025-09', 148]]),
    CES0000000001: mapa([['2026-09', 159119], ['2026-08', 159000]]),
  };
  const CPI = { previous: '+0,3% m/m · +3,0% a/a', source: 'BLS' };
  const build = (extra = {}) => buildEvents({ fredDatesByKind: FRED, nowMs: NOW, blsSeries: BLS, ...extra });

  it('preenche o Anterior de CPI, PPI e Payroll pelo mês de referência (setembro); PCE, FOMC e quem não tem dado ficam sem', () => {
    const m = byId(build());
    expect(m['CPI-2026-11-10'].values).toEqual(CPI);
    expect(m['PPI-2026-11-13'].values).toEqual({ previous: '-0,2% m/m · +2,0% a/a', source: 'BLS' });
    expect(m['NFP-2026-11-06'].values).toEqual({ previous: '+119 mil', source: 'BLS' });
    expect(m['PCE-2026-11-25'].values).toBeNull(); // o PCE é do BEA, não do BLS
    expect(m['FOMC-2026-12-09'].values).toBeNull();
    expect(m['NFP-2026-12-04'].values).toBeNull(); // mede novembro → anterior é outubro, que o BLS ainda não divulgou
    for (const e of Object.values(m)) expect(Object.keys(e)).toEqual(EVENT_KEYS);
  });

  it('sem BLS (null, vazio ou todas as séries nulas): nenhum número, nenhuma quebra', () => {
    for (const blsSeries of [null, {}, { CUSR0000SA0: null, CUUR0000SA0: null, WPSFD4: null, WPUFD4: null, CES0000000001: null }]) {
      for (const e of buildEvents({ fredDatesByKind: FRED, nowMs: NOW, blsSeries })) expect(e.values, e.id).toBeNull();
    }
  });

  it('o BLS cai depois de ter respondido: o Anterior já publicado é MANTIDO (queda não apaga)', () => {
    const publicado = build();
    for (const blsSeries of [null, {}, { CUSR0000SA0: null, CUUR0000SA0: null }]) {
      const de_novo = buildEvents({ fredDatesByKind: FRED, nowMs: NOW + 3600000, previous: publicado, blsSeries });
      expect(byId(de_novo)['CPI-2026-11-10'].values, JSON.stringify(blsSeries)).toEqual(CPI);
      expect(byId(de_novo)['NFP-2026-11-06'].values).toEqual({ previous: '+119 mil', source: 'BLS' });
    }
  });

  it('evento FUTURO aceita o número novo (o BLS revisou setembro); o horário de "mudou" não se mexe por causa do número', () => {
    const publicado = build();
    const revisto = { ...BLS, CUSR0000SA0: mapa([['2026-09', 100.6], ['2026-08', 100]]) }; // +0,6 % no mês
    const depois = buildEvents({ fredDatesByKind: FRED, nowMs: NOW + 3600000, previous: publicado, blsSeries: revisto });
    const cpi = byId(depois)['CPI-2026-11-10'];
    expect(cpi.values).toEqual({ previous: '+0,6% m/m · +3,0% a/a', source: 'BLS' });
    expect(cpi.lastChangedAt).toBe(byId(publicado)['CPI-2026-11-10'].lastChangedAt); // remarcação ≠ número novo
  });

  it('DEPOIS que o evento sai, o número fica CONGELADO (a API passa a revisar o anterior e a trazer o mês novo)', () => {
    const publicado = build();
    const depoisDoCpi = Date.parse('2026-11-10T15:30:00Z'); // CPI saiu às 13:30Z
    const revisto = { ...BLS, CUSR0000SA0: mapa([['2026-10', 101], ['2026-09', 100.6], ['2026-08', 100]]) };
    const ev = byId(buildEvents({ fredDatesByKind: FRED, nowMs: depoisDoCpi, previous: publicado, blsSeries: revisto }));
    expect(ev['CPI-2026-11-10'].values).toEqual(CPI); // continua o número de antes do evento, não o revisado
    // E um evento que já tinha saído SEM número publicado continua sem (nunca se calcula depois do fato).
    const semNumero = buildEvents({ fredDatesByKind: FRED, nowMs: NOW, blsSeries: null });
    const ev2 = byId(buildEvents({ fredDatesByKind: FRED, nowMs: depoisDoCpi, previous: semNumero, blsSeries: BLS }));
    expect(ev2['CPI-2026-11-10'].values).toBeNull();
    expect(ev2['PPI-2026-11-13'].values).toEqual({ previous: '-0,2% m/m · +2,0% a/a', source: 'BLS' }); // este ainda é futuro
  });

  it('values publicado ruim (formato, fonte, campo a mais, URL, tipo errado) é descartado — nunca copiado para a saída', () => {
    const ruins = [
      { previous: 'https://api.bls.gov/x?registrationkey=abc', source: 'BLS' },
      { previous: '+0,3% m/m', source: 'FRED' },
      { previous: 'CPI subiu forte', source: 'BLS' },
      { previous: '+0,3% m/m', source: 'BLS', url: 'https://x.y' },
      { previous: 0.3, source: 'BLS' },
      ['+0,3% m/m', 'BLS'],
      '+0,3% m/m',
      { previous: '+0,3% m/m' },
    ];
    const base = build()[0];
    for (const values of ruins) {
      const ev = buildEvents({ fredDatesByKind: FRED, nowMs: NOW, previous: [{ ...base, values }], blsSeries: null });
      expect(byId(ev)[base.id].values, JSON.stringify(values)).toBeNull();
      expect(() => assertPublicShape(ev, buildStatus({ events: ev, fredDatesByKind: FRED, nowMs: NOW }))).not.toThrow();
    }
    expect(sanitizeValues(CPI)).toEqual(CPI);
    expect(sanitizeValues(null)).toBeNull();
  });

  it('arquivo anterior de ANTES do addendum 14 (sem o campo values) segue valendo', () => {
    const antigo = build({ blsSeries: null }).map(({ values: _v, ...resto }) => resto);
    const ev = buildEvents({ fredDatesByKind: FRED, nowMs: NOW + 3600000, previous: antigo, blsSeries: BLS });
    expect(byId(ev)['CPI-2026-11-10'].values).toEqual(CPI);
    expect(byId(ev)['CPI-2026-11-10'].firstSeenAt).toBe('2026-10-31T12:00:00.000Z');
  });

  it('trava pública: aceita null e { previous, source: "BLS" }; recusa campo ausente, extra, outra fonte, texto livre, URL e tipo errado (o addendum 15 acrescenta actual/revised)', () => {
    const ev = build();
    const st = buildStatus({ events: ev, fredDatesByKind: FRED, nowMs: NOW });
    expect(() => assertPublicShape(ev, st)).not.toThrow();
    const cpi = ev.find((e) => e.id === 'CPI-2026-11-10');
    const plantados = [
      { ...cpi, values: { previous: '+0,3% m/m', source: 'BLS', note: 'x' } },
      { ...cpi, values: { previous: '+0,3% m/m', source: 'FRED' } },
      { ...cpi, values: { previous: 'o CPI veio quente', source: 'BLS' } },
      { ...cpi, values: { previous: 'https://api.bls.gov/publicAPI/v2/timeseries/data/X?registrationkey=abc', source: 'BLS' } },
      { ...cpi, values: { previous: 0.3, source: 'BLS' } },
      { ...cpi, values: { previous: '+0,3%', source: 'BLS' } }, // sem a unidade
      { ...cpi, values: { previous: '+0.3% m/m', source: 'BLS' } }, // ponto em vez de vírgula
      { ...cpi, values: ['+0,3% m/m'] },
      { ...cpi, values: '+0,3% m/m' },
      { ...cpi, values: undefined },
      (({ values: _v, ...resto }) => resto)(cpi), // o campo some
    ];
    for (const e of plantados) expect(() => assertPublicShape([e], st), JSON.stringify(e.values)).toThrow(/conteúdo público recusado/);
    expect(VALUES_KEYS).toEqual(['previous', 'actual', 'revised', 'source']); // addendum 15 (contextResult.test.js)
  });

  describe('coleta ponta a ponta (main)', () => {
    const FKEY = 'fredkey0123456789abcdef0123456789';
    const BKEY = 'blskey0123456789abcdef0123456789';
    const blsResp = (id) => new Response(JSON.stringify({
      status: 'REQUEST_SUCCEEDED',
      message: [],
      Results: { series: [{ seriesID: id, data: [...BLS[id].entries()].map(([ym, v]) => ({ year: ym.slice(0, 4), period: `M${ym.slice(5)}`, value: String(v) })) }] },
    }), { status: 200 });
    const chaveRecusada = () => new Response(JSON.stringify({ status: 'REQUEST_NOT_PROCESSED', message: ['The key:*** provided by the User is invalid. Please provide a proper key for the operation to be successful'] }), { status: 200 });
    const fetchComBls = ({ v2 = 'ok', v1 = 'ok' } = {}) => async (url) => {
      const u = String(url);
      if (u.includes('api.bls.gov')) {
        const modo = u.includes('/v2/') ? v2 : v1;
        if (modo === 'chave') return chaveRecusada();
        if (modo === 'falha') return new Response('x', { status: 500 });
        return blsResp(u.slice(u.lastIndexOf('/') + 1).split('?')[0]);
      }
      const id = Number(new URL(u).searchParams.get('release_id'));
      const kind = Object.entries(FRED_RELEASES).find(([, v]) => v === id)?.[0];
      return new Response(fredBody(FRED[kind]), { status: 200 });
    };
    async function coletar(env, fetchImpl, { now = NOW, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-bls-')) } = {}) {
      const logs = [];
      const origLog = console.log;
      console.log = (...a) => logs.push(a.join(' '));
      try {
        const code = await main(['--dir', dir], env, { fetchImpl, now: () => now });
        return { code, dir, logs: logs.join('\n'), events: JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')), raw: fs.readFileSync(path.join(dir, 'events.json'), 'utf8'), status: fs.readFileSync(path.join(dir, 'status.json'), 'utf8') };
      } finally {
        console.log = origLog;
      }
    }

    it('com chave válida: o events.json traz o Anterior, o resumo mostra a coluna, e nenhuma chave nem URL vaza', async () => {
      const r = await coletar({ FRED_API_KEY: FKEY, BLS_API_KEY: BKEY }, fetchComBls());
      try {
        expect(r.code).toBe(0);
        const m = byId(r.events);
        expect(m['CPI-2026-11-10'].values).toEqual(CPI);
        expect(m['NFP-2026-11-06'].values).toEqual({ previous: '+119 mil', source: 'BLS' });
        expect(r.logs).toMatch(/BLS \(valor "Anterior"\): 5 de 5 séries lidas \(v2 com chave: 5 · v1 sem chave: 0 · sem resposta: 0\)/);
        expect(r.logs).toContain('| Evento | Hora (UTC) | Situação | Anterior (BLS) | Atual (BLS) | Revisado (BLS) |');
        expect(r.logs).toContain('| CPI-2026-11-10 | 2026-11-10 13:30 | oficial | +0,3% m/m · +3,0% a/a | — | — |');
        expect(r.logs).toContain('| FOMC-2026-12-09 | 2026-12-09 19:00 | oficial | — | — | — |');
        for (const texto of [r.raw, r.status, r.logs]) {
          expect(texto).not.toContain(BKEY);
          expect(texto).not.toContain(FKEY);
          expect(texto).not.toMatch(/https?:\/\/|registrationkey/i);
        }
        expect(() => assertPublicShape(r.events, JSON.parse(r.status))).not.toThrow();
      } finally {
        fs.rmSync(r.dir, { recursive: true, force: true });
      }
    });

    it('rodar de novo sem mudança no BLS não muda o events.json (o git não tem o que gravar)', async () => {
      const r1 = await coletar({ FRED_API_KEY: FKEY, BLS_API_KEY: BKEY }, fetchComBls());
      try {
        const r2 = await coletar({ FRED_API_KEY: FKEY, BLS_API_KEY: BKEY }, fetchComBls(), { now: NOW + 3600000, dir: r1.dir });
        expect(r2.raw).toBe(r1.raw);
      } finally {
        fs.rmSync(r1.dir, { recursive: true, force: true });
      }
    });

    it('chave RECUSADA pelo BLS: o Anterior sai mesmo assim (versão sem chave) e o resumo explica o porquê, sem a chave', async () => {
      const r = await coletar({ FRED_API_KEY: FKEY, BLS_API_KEY: BKEY }, fetchComBls({ v2: 'chave' }));
      try {
        expect(r.code).toBe(0);
        expect(byId(r.events)['CPI-2026-11-10'].values).toEqual(CPI);
        expect(r.logs).toMatch(/5 de 5 séries lidas \(v2 com chave: 0 · v1 sem chave: 5 · sem resposta: 0\)/);
        expect(r.logs).toMatch(/ATENÇÃO: o BLS RECUSOU a chave `BLS_API_KEY`/);
        expect(r.logs).toMatch(/ainda não foi ativada pelo link do e-mail/);
        for (const texto of [r.raw, r.status, r.logs]) expect(texto).not.toContain(BKEY);
      } finally {
        fs.rmSync(r.dir, { recursive: true, force: true });
      }
    });

    it('sem a chave: usa a versão sem chave e avisa no resumo', async () => {
      const r = await coletar({ FRED_API_KEY: FKEY }, fetchComBls());
      try {
        expect(byId(r.events)['PPI-2026-11-13'].values).toEqual({ previous: '-0,2% m/m · +2,0% a/a', source: 'BLS' });
        expect(r.logs).toMatch(/Sem o segredo `BLS_API_KEY`/);
      } finally {
        fs.rmSync(r.dir, { recursive: true, force: true });
      }
    });

    it('o BLS fora do ar: a coleta das DATAS segue (código 0), sem número, e o resumo conta as falhas', async () => {
      const r = await coletar({ FRED_API_KEY: FKEY, BLS_API_KEY: BKEY }, fetchComBls({ v2: 'falha', v1: 'falha' }));
      try {
        expect(r.code).toBe(0);
        expect(r.events).toHaveLength(11);
        for (const e of r.events) expect(e.values, e.id).toBeNull();
        expect(r.logs).toMatch(/0 de 5 séries lidas \(v2 com chave: 0 · v1 sem chave: 0 · sem resposta: 5\)/);
        expect(r.status).not.toContain(BKEY);
      } finally {
        fs.rmSync(r.dir, { recursive: true, force: true });
      }
    });

    it('o BLS cai numa coleta seguinte: o número publicado antes continua no arquivo', async () => {
      const r1 = await coletar({ FRED_API_KEY: FKEY, BLS_API_KEY: BKEY }, fetchComBls());
      try {
        const r2 = await coletar({ FRED_API_KEY: FKEY, BLS_API_KEY: BKEY }, fetchComBls({ v2: 'falha', v1: 'falha' }), { now: NOW + 3600000, dir: r1.dir });
        expect(byId(r2.events)['CPI-2026-11-10'].values).toEqual(CPI);
        expect(r2.raw).toBe(r1.raw);
      } finally {
        fs.rmSync(r1.dir, { recursive: true, force: true });
      }
    });

    it('describeBls: só contagens e motivos (limite diário, chave ausente, chave recusada); null sem coleta', () => {
      expect(describeBls(null)).toBeNull();
      const base = { tally: { v2: 0, v1: 3, failed: 2 }, keyPresent: true, keyRejected: false, limitHit: true };
      const t = describeBls(base);
      expect(t).toMatch(/3 de 5 séries lidas/);
      expect(t).toMatch(/O BLS informou que o limite diário de consultas foi atingido/);
      expect(t).not.toMatch(/RECUSOU|Sem o segredo/);
      expect(describeBls({ ...base, keyPresent: false, limitHit: false })).toMatch(/Sem o segredo `BLS_API_KEY`/);
    });
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
