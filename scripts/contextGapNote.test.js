// Item 285, addendum 22 — a lacuna oficial chega ao cartão: `values.gap` (motivo, lista fechada) e `values.alt` ("janela alternativa": a variação entre
// o 1º mês PUBLICADO depois da lacuna e o mês do evento). O que se prova:
//  - o cálculo só acontece quando a lacuna é OFICIAL (registrada na base) e o mês do evento já foi publicado; nunca se estima nem se interpola;
//  - `gap`/`alt` entram no conteúdo público só pela lista fechada (formato, meses coerentes, nada de texto livre) e só junto do "Atual";
//  - congelam como o "Atual" (uma revisão posterior não troca o que já saiu), mas um evento já publicado SEM eles os ganha uma vez;
//  - ponta a ponta (main): base → eventos.json, sem chave nem URL, e o formato de antes não muda para quem não tem lacuna.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gapNoteValues, ALT_TEXT_RE, GAP_REASONS } from './contextBls.mjs';
import { baseToGaps, emptyBase, mergeBase } from './contextBlsBase.mjs';
import { buildEvents, sanitizeValues, assertPublicShape, buildStatus, FRED_RELEASES } from './contextCollect.mjs';
import { main } from './context-collect.mjs';

const mapa = (pontos) => new Map(pontos);
const CPI_SA = 'CUSR0000SA0';
const CPI_NSA = 'CUUR0000SA0';
const PPI_NSA = 'WPUFD4';
const LACUNA = { [CPI_NSA]: mapa([['2025-10', 'paralisacao_2025']]) };

// Séries "de outubro": o CPI sem ajuste TEM nov/2025 e out/2026, mas NÃO tem out/2025 (lacuna oficial).
const SERIES = {
  [CPI_SA]: mapa([['2026-08', 100], ['2026-09', 100.3], ['2026-10', 100.8]]),
  [CPI_NSA]: mapa([['2025-09', 100], ['2025-11', 100.5], ['2026-09', 103], ['2026-10', 104]]),
  WPSFD4: mapa([['2026-09', 149.7], ['2026-10', 150.5]]),
  [PPI_NSA]: mapa([['2025-09', 148], ['2025-10', 149], ['2026-09', 150.96], ['2026-10', 152]]),
  CES0000000001: mapa([['2026-09', 159119], ['2026-10', 159200]]),
};

describe('gapNoteValues — só com lacuna OFICIAL e mês do evento publicado', () => {
  it('CPI de out/2026: o mês-base (out/2025) é lacuna oficial → { gap, alt } com a janela de nov/2025 a out/2026', () => {
    // 104 / 100,5 = +3,4826% → "+3,5%"
    expect(gapNoteValues('CPI', SERIES, LACUNA, '2026-10')).toEqual({ gap: 'paralisacao_2025', alt: '+3,5% de 2025-11 a 2026-10' });
  });

  it('o motivo da lacuna passa como veio (lista fechada)', () => {
    const r = gapNoteValues('CPI', SERIES, { [CPI_NSA]: mapa([['2025-10', 'nao_divulgado']]) }, '2026-10');
    expect(r.gap).toBe('nao_divulgado');
  });

  it('sem o 1º mês depois da lacuna (nov/2025): só o `gap`, SEM janela alternativa (nada é inventado)', () => {
    const sem = { ...SERIES, [CPI_NSA]: mapa([['2025-09', 100], ['2026-09', 103], ['2026-10', 104]]) };
    expect(gapNoteValues('CPI', sem, LACUNA, '2026-10')).toEqual({ gap: 'paralisacao_2025' });
  });

  it('variação implausível (> 30%) não vira janela: só o `gap`', () => {
    const absurdo = { ...SERIES, [CPI_NSA]: mapa([['2025-11', 50], ['2026-10', 104]]) };
    expect(gapNoteValues('CPI', absurdo, LACUNA, '2026-10')).toEqual({ gap: 'paralisacao_2025' });
  });

  it('retorna null quando não há lacuna a explicar', () => {
    // mês-base com valor (o a/a existe): nada a explicar
    expect(gapNoteValues('CPI', { ...SERIES, [CPI_NSA]: mapa([['2025-10', 100], ['2025-11', 100.5], ['2026-10', 104]]) }, LACUNA, '2026-10')).toBeNull();
    // mês-base ausente mas SEM registro de lacuna: falta de dado não é lacuna oficial (não se afirma o que não se sabe)
    expect(gapNoteValues('CPI', SERIES, {}, '2026-10')).toBeNull();
    expect(gapNoteValues('CPI', SERIES, { [CPI_NSA]: null }, '2026-10')).toBeNull();
    // o mês do evento ainda não foi publicado
    expect(gapNoteValues('CPI', { ...SERIES, [CPI_NSA]: mapa([['2025-11', 100.5], ['2026-09', 103]]) }, LACUNA, '2026-10')).toBeNull();
    // Payroll não tem "em 12 meses"; referência inválida
    expect(gapNoteValues('NFP', SERIES, LACUNA, '2026-10')).toBeNull();
    expect(gapNoteValues('CPI', SERIES, LACUNA, null)).toBeNull();
    expect(gapNoteValues('CPI', SERIES, LACUNA, 'lixo')).toBeNull();
    expect(gapNoteValues('CPI', null, LACUNA, '2026-10')).toBeNull();
    expect(gapNoteValues('CPI', SERIES, null, '2026-10')).toBeNull();
  });

  it('lacuna de OUTRA série ou de OUTRO mês não vale', () => {
    expect(gapNoteValues('CPI', SERIES, { [CPI_SA]: mapa([['2025-10', 'paralisacao_2025']]) }, '2026-10')).toBeNull();
    expect(gapNoteValues('CPI', SERIES, { [CPI_NSA]: mapa([['2025-08', 'paralisacao_2025']]) }, '2026-10')).toBeNull();
  });

  it('o PPI segue a mesma regra (a série do 12 meses dele é a WPUFD4)', () => {
    const ppi = { ...SERIES, [PPI_NSA]: mapa([['2025-11', 150], ['2026-10', 152]]) };
    expect(gapNoteValues('PPI', ppi, { [PPI_NSA]: mapa([['2025-10', 'nao_divulgado']]) }, '2026-10')).toEqual({ gap: 'nao_divulgado', alt: '+1,3% de 2025-11 a 2026-10' });
  });

  it('o texto da janela é do formato fechado (e o regex recusa lixo, meses invertidos e janelas de 12 meses)', () => {
    expect(ALT_TEXT_RE.test('+3,5% de 2025-11 a 2026-10')).toBe(true);
    expect(ALT_TEXT_RE.test('-0,4% de 2026-01 a 2026-10')).toBe(true);
    for (const ruim of ['', '3,5% de 2025-11 a 2026-10', '+3,5% desde 2025-11', '+3,5% de 2025-13 a 2026-10', '+3,5% de 2025-11 a 2026-10 e mais', '+3,5% de 2025-11 a 2026-10\n', 'https://x.test +3,5% de 2025-11 a 2026-10']) {
      expect(ALT_TEXT_RE.test(ruim), JSON.stringify(ruim)).toBe(false);
    }
    expect(GAP_REASONS).toEqual(['paralisacao_2025', 'nao_divulgado']);
  });
});

describe('baseToGaps — as lacunas da base no formato que as contas usam', () => {
  it('série com lacuna vira um Map mês → motivo; sem lacuna, null; base vazia, tudo null', () => {
    const base = mergeBase(emptyBase(), { series: { [CPI_SA]: mapa([['2026-09', 100]]) }, gaps: {} }).base; // a semente põe out/2025 do CPI (com e sem ajuste)
    const g = baseToGaps(base);
    expect([...g[CPI_NSA]]).toEqual([['2025-10', 'paralisacao_2025']]);
    expect([...g[CPI_SA]]).toEqual([['2025-10', 'paralisacao_2025']]);
    expect(g[PPI_NSA]).toBeNull();
    for (const v of Object.values(baseToGaps(emptyBase()))) expect(v).toBeNull();
    for (const v of Object.values(baseToGaps(null))) expect(v).toBeNull();
  });
});

describe('sanitizeValues com `gap` e `alt` — a lista fechada do conteúdo público', () => {
  const ok = { previous: '+0,6% m/m · +3,7% a/a', actual: '+0,4% m/m', gap: 'paralisacao_2025', alt: '+3,5% de 2025-11 a 2026-10', source: 'BLS' };

  it('aceita o conjunto completo e devolve SEMPRE na mesma ordem de chaves', () => {
    expect(Object.keys(sanitizeValues({ source: 'BLS', alt: ok.alt, gap: ok.gap, actual: ok.actual, previous: ok.previous }))).toEqual(['previous', 'actual', 'gap', 'alt', 'source']);
    expect(sanitizeValues(ok)).toEqual(ok);
    const semAlt = { ...ok }; delete semAlt.alt;
    expect(sanitizeValues(semAlt)).toEqual(semAlt);
  });

  it('o arquivo anterior sem esses campos continua valendo (formato de antes)', () => {
    const antigo = { previous: '+0,6% m/m · +3,7% a/a', actual: '+0,4% m/m', source: 'BLS' };
    expect(sanitizeValues(antigo)).toEqual(antigo);
  });

  it('recusa: `gap`/`alt` sem "Atual", `alt` sem `gap`, motivo fora da lista, texto livre, URL, janela incoerente', () => {
    const sem = (k) => { const c = { ...ok }; delete c[k]; return c; };
    const ruins = [
      { ...sem('actual') },
      { ...sem('gap') },
      { ...ok, gap: 'texto livre do BLS' },
      { ...ok, gap: 'https://x.test/?k=segredo' },
      { ...ok, gap: '' },
      { ...ok, gap: 1 },
      { ...ok, alt: 'depois de nov/2025 subiu +3,5%' },
      { ...ok, alt: '+3,5% de 2026-10 a 2025-11' }, // invertida
      { ...ok, alt: '+3,5% de 2025-10 a 2026-10' }, // 12 meses: seria o número oficial, não "alternativo"
      { ...ok, alt: '+3,5% de 2026-10 a 2026-10' }, // zero meses
      { ...ok, alt: '+3,5% de 2025-11 a 2026-10 https://x.test' },
      { ...ok, extra: 'x' },
    ];
    for (const r of ruins) expect(sanitizeValues(r), JSON.stringify(r)).toBeNull();
  });
});

describe('buildEvents com lacuna — o "Atual" congela e o `gap`/`alt` acompanham', () => {
  const FRED = {
    CPI: ['2026-10-14', '2026-11-10', '2026-12-10'],
    NFP: ['2026-10-02', '2026-11-06', '2026-12-04'],
    PPI: ['2026-10-15', '2026-11-13', '2026-12-15'],
    PCE: ['2026-10-29', '2026-11-25', '2026-12-23'],
  };
  const DEPOIS_CPI = Date.parse('2026-11-10T13:39:00Z') + 30 * 60000;
  const cpi = (events) => events.find((e) => e.id === 'CPI-2026-11-10');
  const rodar = (extra) => buildEvents({ fredDatesByKind: FRED, nowMs: DEPOIS_CPI, previous: [], blsSeries: SERIES, ...extra });

  it('depois da divulgação: "Atual" só com o mês (sem o a/a impossível) + gap + alt', () => {
    expect(cpi(rodar({ blsGaps: LACUNA })).values).toEqual({
      previous: '+0,3% m/m · +3,0% a/a', actual: '+0,5% m/m', gap: 'paralisacao_2025', alt: '+3,5% de 2025-11 a 2026-10', source: 'BLS',
    });
  });

  it('sem `blsGaps` (ou sem lacuna registrada) o resultado é IDÊNTICO ao de antes — nada muda para quem não tem lacuna', () => {
    const antes = cpi(rodar({})).values;
    expect(antes).toEqual({ previous: '+0,3% m/m · +3,0% a/a', actual: '+0,5% m/m', source: 'BLS' });
    expect(cpi(rodar({ blsGaps: {} })).values).toEqual(antes);
    expect(cpi(rodar({ blsGaps: { [CPI_NSA]: null } })).values).toEqual(antes);
  });

  it('só o PPI e o CPI recebem; um evento ainda NÃO divulgado nunca recebe `gap`/`alt`', () => {
    const antes = buildEvents({ fredDatesByKind: FRED, nowMs: Date.parse('2026-11-10T12:00:00Z'), previous: [], blsSeries: SERIES, blsGaps: LACUNA });
    expect(cpi(antes).values.gap).toBeUndefined();
    expect(cpi(antes).values.alt).toBeUndefined();
  });

  it('congela: uma 2ª coleta com a janela diferente NÃO troca a que já saiu', () => {
    const r1 = rodar({ blsGaps: LACUNA });
    const outra = { ...SERIES, [CPI_NSA]: mapa([['2025-09', 100], ['2025-11', 98], ['2026-09', 103], ['2026-10', 104]]) };
    const r2 = buildEvents({ fredDatesByKind: FRED, nowMs: DEPOIS_CPI + 3600000, previous: r1, blsSeries: outra, blsGaps: LACUNA });
    expect(cpi(r2).values).toEqual(cpi(r1).values);
  });

  it('um evento JÁ publicado sem `gap`/`alt` (como o de 10/11/2026) os ganha uma vez, sem mexer no resto', () => {
    const publicado = [{ ...cpi(rodar({})), values: { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,5% m/m', source: 'BLS' } }];
    const r = buildEvents({ fredDatesByKind: FRED, nowMs: DEPOIS_CPI + 3600000, previous: publicado, blsSeries: SERIES, blsGaps: LACUNA });
    expect(cpi(r).values).toEqual({ previous: '+0,3% m/m · +3,0% a/a', actual: '+0,5% m/m', gap: 'paralisacao_2025', alt: '+3,5% de 2025-11 a 2026-10', source: 'BLS' });
  });

  it('só o `gap` publicado (nov/2025 ainda sem índice): a `alt` entra depois, o `gap` nunca muda', () => {
    const semNov = { ...SERIES, [CPI_NSA]: mapa([['2025-09', 100], ['2026-09', 103], ['2026-10', 104]]) };
    const r1 = buildEvents({ fredDatesByKind: FRED, nowMs: DEPOIS_CPI, previous: [], blsSeries: semNov, blsGaps: LACUNA });
    expect(cpi(r1).values.gap).toBe('paralisacao_2025');
    expect(cpi(r1).values.alt).toBeUndefined();
    const r2 = buildEvents({ fredDatesByKind: FRED, nowMs: DEPOIS_CPI + 3600000, previous: r1, blsSeries: SERIES, blsGaps: { [CPI_NSA]: mapa([['2025-10', 'nao_divulgado']]) } });
    expect(cpi(r2).values.gap).toBe('paralisacao_2025'); // congelado
    expect(cpi(r2).values.alt).toBe('+3,5% de 2025-11 a 2026-10'); // entrou
  });

  it('a trava pública (assertPublicShape) recusa `gap`/`alt` fora da lista fechada no events.json', () => {
    const events = rodar({ blsGaps: LACUNA });
    const status = buildStatus({ events, fredDatesByKind: FRED, nowMs: DEPOIS_CPI });
    const base = cpi(events);
    const ruins = [
      { ...base.values, gap: 'a Binance caiu' },
      { ...base.values, gap: 'https://x.test/?k=segredo' },
      { ...base.values, alt: 'subiu +3,5% desde nov/2025' },
      { ...base.values, alt: '+3,5% de 2025-11 a 2026-10 e vai subir' },
      { previous: base.values.previous, gap: 'paralisacao_2025', source: 'BLS' }, // sem "Atual"
    ];
    for (const values of ruins) {
      const e = events.map((x) => (x.id === base.id ? { ...x, values } : x));
      expect(() => assertPublicShape(e, status), JSON.stringify(values)).toThrow(/conteúdo público recusado/);
    }
  });

  it('o conteúdo gerado passa na trava pública', () => {
    const events = rodar({ blsGaps: LACUNA });
    const status = buildStatus({ events, fredDatesByKind: FRED, nowMs: DEPOIS_CPI });
    expect(() => assertPublicShape(events, status)).not.toThrow();
  });
});

describe('coletor de ponta a ponta (main) — a lacuna da base chega ao events.json', () => {
  const FKEY = 'fredkey0123456789abcdef0123456789';
  const BKEY = 'blskey0123456789abcdef0123456789';
  const NOW = Date.parse('2026-10-31T12:00:00Z');
  const AFTER_CPI = Date.parse('2026-11-10T13:39:00Z') + 30 * 60000;
  const FRED = {
    CPI: ['2026-10-14', '2026-11-10', '2026-12-10'],
    NFP: ['2026-10-02', '2026-11-06', '2026-12-04'],
    PPI: ['2026-10-15', '2026-11-13', '2026-12-15'],
    PCE: ['2026-10-29', '2026-11-25', '2026-12-23'],
  };
  const resp = (id, entradas) => new Response(JSON.stringify({
    status: 'REQUEST_SUCCEEDED', message: [],
    Results: { series: [{ seriesID: id, data: entradas.map(([ym, v]) => ({ year: ym.slice(0, 4), period: `M${ym.slice(5)}`, value: String(v), footnotes: [{}] })) }] },
  }), { status: 200 });
  const fetchCom = (porId) => async (url) => {
    const u = String(url);
    if (u.includes('api.bls.gov')) {
      const id = u.slice(u.lastIndexOf('/') + 1).split('?')[0];
      const r = porId(id);
      return r === 'erro' ? new Response('x', { status: 500 }) : resp(id, r);
    }
    const idRelease = Number(new URL(u).searchParams.get('release_id'));
    const kind = Object.entries(FRED_RELEASES).find(([, v]) => v === idRelease)?.[0];
    return new Response(JSON.stringify({ release_dates: FRED[kind].map((date) => ({ release_id: 1, date })) }), { status: 200 });
  };
  const doMapa = (series) => (id) => [...series[id].entries()];
  const pasta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-gap-'));
  async function rodar(dir, porId, now) {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      const code = await main(['--dir', dir], { FRED_API_KEY: FKEY, BLS_API_KEY: BKEY }, { fetchImpl: fetchCom(porId), now: () => now });
      return { code, logs: logs.join('\n') };
    } finally {
      console.log = orig;
    }
  }
  const lido = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const cpi = (dir) => JSON.parse(lido(dir, 'events.json')).find((e) => e.id === 'CPI-2026-11-10');

  it('a 1ª coleta de antes da divulgação grava a base; a coleta depois da divulgação publica o "Atual" com `gap` e `alt`', async () => {
    const dir = pasta();
    try {
      const antes = { ...SERIES, [CPI_SA]: mapa([['2026-08', 100], ['2026-09', 100.3]]), [CPI_NSA]: mapa([['2025-09', 100], ['2025-11', 100.5], ['2026-09', 103]]), WPSFD4: mapa([['2026-09', 149.7]]), [PPI_NSA]: mapa([['2025-09', 148], ['2026-09', 150.96]]), CES0000000001: mapa([['2026-08', 159000], ['2026-09', 159119]]) };
      await rodar(dir, doMapa(antes), NOW);
      expect(cpi(dir).values.gap).toBeUndefined();
      // O BLS divulga: a API devolve só o mês novo. A base (com a semente da lacuna e nov/2025) completa a conta.
      const so = { [CPI_SA]: mapa([['2026-10', 100.8]]), [CPI_NSA]: mapa([['2026-10', 104]]), WPSFD4: mapa([['2026-10', 150.5]]), [PPI_NSA]: mapa([['2026-10', 152]]), CES0000000001: mapa([['2026-10', 159200]]) };
      const r = await rodar(dir, doMapa(so), AFTER_CPI);
      expect(r.code).toBe(0);
      expect(cpi(dir).values).toEqual({
        previous: '+0,3% m/m · +3,0% a/a', actual: '+0,5% m/m', gap: 'paralisacao_2025', alt: '+3,5% de 2025-11 a 2026-10', source: 'BLS',
      });
      for (const t of [lido(dir, 'events.json'), lido(dir, 'status.json'), lido(dir, 'bls-base.json'), r.logs]) {
        expect(t).not.toContain(BKEY);
        expect(t).not.toContain(FKEY);
        expect(t).not.toMatch(/api\.bls\.gov|registrationkey|https?:/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('se o BLS um dia publicar out/2025, o "em 12 meses" volta e NÃO há `gap` nem `alt` (o valor apaga a lacuna)', async () => {
    const dir = pasta();
    try {
      const comOut25 = { ...SERIES, [CPI_NSA]: mapa([['2025-09', 100], ['2025-10', 100.4], ['2025-11', 100.5], ['2026-09', 103], ['2026-10', 104]]) };
      await rodar(dir, doMapa(comOut25), AFTER_CPI);
      const e = cpi(dir);
      expect(e.values.actual).toBe('+0,5% m/m · +3,6% a/a'); // 104 / 100,4 = +3,59%
      expect(e.values.gap).toBeUndefined();
      expect(e.values.alt).toBeUndefined();
      expect(JSON.parse(lido(dir, 'bls-base.json')).gaps[CPI_NSA]).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
