// Item 285, addendum 21 — a BASE PRÓPRIA do BLS (`bls-base.json`, branch pública `context-data`). O que se prova:
//  - a fusão NUNCA perde o que já foi lido: resposta nula, parcial ou com erro deixa a base idêntica, byte a byte;
//  - revisão pequena do BLS sobrescreve (é legítima); salto absurdo (> 5%) é recusado e contado (série errada / dado corrompido);
//  - a linha "-" do BLS vira lacuna OFICIAL com motivo de lista fechada; um valor nunca vira lacuna e uma lacuna some quando o valor chega;
//  - a trava `assertBaseShape` só deixa passar a lista fechada (nada de texto livre, URL, chave, série desconhecida);
//  - com a base, uma resposta PARCIAL da API ainda dá o mesmo texto do CPI de 10/11 (sem a base daria null);
//  - o coletor de ponta a ponta (main): grava a base, não perde nada quando a API cai, sanitiza arquivo corrompido e não vaza chave nem URL.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BLS_SERIES, allSeriesIds, actualValueText, previousValueText } from './contextBls.mjs';
import {
  BASE_VERSION, BASE_SOURCE, MAX_MONTHS, SEED_GAPS, emptyBase, sanitizeBase, assertBaseShape, mergeBase, baseToSeries, describeBase, serializeBase,
} from './contextBlsBase.mjs';
import { main, writeBase, readBase } from './context-collect.mjs';
import { FRED_RELEASES, buildEvents } from './contextCollect.mjs';

const mapa = (pontos) => new Map(pontos);
const json = (x) => JSON.stringify(x);
const CPI_SA = 'CUSR0000SA0';
const CPI_NSA = 'CUUR0000SA0';

// Valores escolhidos para dar contas redondas (os mesmos de contextResult.test.js).
const ANTES = {
  CUSR0000SA0: mapa([['2026-09', 100.3], ['2026-08', 100]]),
  CUUR0000SA0: mapa([['2026-09', 103], ['2025-09', 100]]),
  WPSFD4: mapa([['2026-09', 149.7], ['2026-08', 150]]),
  WPUFD4: mapa([['2026-09', 150.96], ['2025-09', 148]]),
  CES0000000001: mapa([['2026-09', 159119], ['2026-08', 159000]]),
};
// Mesmas séries, mas COM os índices de out/2025 (os de contextResult.test.js): permitem o "em 12 meses" de out/2026. No CPI real esse índice NÃO existe (paralisação).
const ANTES_COM_OUT25 = {
  ...ANTES,
  CUUR0000SA0: mapa([['2026-09', 103], ['2025-09', 100], ['2025-10', 100]]),
  WPUFD4: mapa([['2026-09', 150.96], ['2025-09', 148], ['2025-10', 149]]),
};
const SO_OUTUBRO = { // o BLS acabou de divulgar: a API devolve só o mês novo (resposta PARCIAL)
  CUSR0000SA0: mapa([['2026-10', 100.8]]),
  CUUR0000SA0: mapa([['2026-10', 104]]),
  WPSFD4: mapa([['2026-10', 150.5]]),
  WPUFD4: mapa([['2026-10', 152]]),
  CES0000000001: mapa([['2026-10', 159200]]),
};
const nenhumaLacuna = Object.fromEntries(allSeriesIds().map((id) => [id, null]));
/** O que o coletor usa nas contas: a base JÁ FUNDIDA com a resposta da API (valor recusado nunca entra). */
const uniao = (base, api) => baseToSeries(mergeBase(base, { series: { ...nenhumaLacuna, ...(api ?? {}) }, gaps: nenhumaLacuna }, { seedGaps: {} }).base);
const baseCom = (series, gaps = {}) => mergeBase(emptyBase(), { series, gaps: { ...nenhumaLacuna, ...gaps } }, { seedGaps: {} }).base;

describe('sanitizeBase — o arquivo da rede/disco nunca é confiável', () => {
  it('lixo, nulo, lista e versão errada viram base vazia', () => {
    for (const x of [null, undefined, 'x', 7, [], { values: 'x' }, { version: 9, values: { [CPI_SA]: { '2026-09': 100 } } }]) expect(sanitizeBase(x), json(x)).toEqual(emptyBase());
  });

  it('descarta só o que está ruim: série desconhecida, mês mal formado, número em texto, NaN, zero, motivo fora da lista, lacuna de mês com valor', () => {
    const suja = {
      version: BASE_VERSION, source: BASE_SOURCE,
      values: { [CPI_SA]: { '2026-09': 100.3, '2026-9': 5, '2026-13': 5, '2026-08': '100', '2026-07': Number.NaN, '2026-06': 0, '2026-05': -3, '2026-04': 1e9 }, OUTRA: { '2026-09': 1 } },
      gaps: { [CPI_NSA]: { '2025-10': 'paralisacao_2025', '2025-11': 'texto livre', '2026-09': 'nao_divulgado' }, OUTRA: { '2025-10': 'nao_divulgado' } },
    };
    suja.values[CPI_NSA] = { '2026-09': 103 };
    const limpa = sanitizeBase(suja);
    expect(limpa.values).toEqual({ [CPI_SA]: { '2026-09': 100.3 }, [CPI_NSA]: { '2026-09': 103 } });
    expect(limpa.gaps).toEqual({ [CPI_NSA]: { '2025-10': 'paralisacao_2025' } }); // 2026-09 tem valor; "texto livre" e a série desconhecida caem
    expect(() => assertBaseShape(limpa)).not.toThrow();
  });

  it(`poda para os ${MAX_MONTHS} meses mais recentes de cada série e ordena as chaves (o arquivo só muda quando um número muda)`, () => {
    const muitos = {};
    for (let i = 0; i < 60; i += 1) muitos[`${2021 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`] = 100 + i;
    const limpa = sanitizeBase({ version: BASE_VERSION, source: BASE_SOURCE, values: { [CPI_SA]: muitos }, gaps: {} });
    const meses = Object.keys(limpa.values[CPI_SA]);
    expect(meses).toHaveLength(MAX_MONTHS);
    expect(meses[meses.length - 1]).toBe('2025-12'); // o mais recente fica
    expect([...meses].sort()).toEqual(meses);
    expect(Object.keys(sanitizeBase({ version: BASE_VERSION, source: BASE_SOURCE, values: { [CPI_NSA]: { '2026-02': 2, '2026-01': 1 }, [CPI_SA]: { '2026-01': 1 } }, gaps: {} }).values)).toEqual([CPI_SA, CPI_NSA].sort((a, b) => allSeriesIds().indexOf(a) - allSeriesIds().indexOf(b)));
  });
});

describe('assertBaseShape — a lista fechada do que vai para a branch pública', () => {
  const boa = () => ({ version: BASE_VERSION, source: BASE_SOURCE, values: { [CPI_SA]: { '2026-09': 100.3 } }, gaps: { [CPI_NSA]: { '2025-10': 'paralisacao_2025' } } });

  it('a base boa e a vazia passam', () => {
    expect(() => assertBaseShape(boa())).not.toThrow();
    expect(() => assertBaseShape(emptyBase())).not.toThrow();
  });

  it.each([
    ['campo a mais no topo', (b) => { b.extra = 1; }],
    ['sem o campo `source`', (b) => { delete b.source; }],
    ['fonte que não é o BLS', (b) => { b.source = 'FRED'; }],
    ['versão errada', (b) => { b.version = 2; }],
    ['série desconhecida em values', (b) => { b.values.OUTRA = { '2026-09': 1 }; }],
    ['série desconhecida em gaps', (b) => { b.gaps.OUTRA = { '2025-10': 'nao_divulgado' }; }],
    ['mês mal formado', (b) => { b.values[CPI_SA]['2026-9'] = 1; }],
    ['número em texto', (b) => { b.values[CPI_SA]['2026-08'] = '100'; }],
    ['número infinito', (b) => { b.values[CPI_SA]['2026-08'] = Infinity; }],
    ['número absurdo', (b) => { b.values[CPI_SA]['2026-08'] = 1e9; }],
    ['zero', (b) => { b.values[CPI_SA]['2026-08'] = 0; }],
    ['motivo fora da lista', (b) => { b.gaps[CPI_NSA]['2025-11'] = 'texto livre do BLS'; }],
    ['URL no lugar do motivo', (b) => { b.gaps[CPI_NSA]['2025-11'] = 'https://exemplo.invalido/?k=segredo'; }],
    ['URL como chave de série', (b) => { b.values['https://exemplo.invalido'] = {}; }],
    ['valor e lacuna no mesmo mês', (b) => { b.gaps[CPI_SA] = { '2026-09': 'nao_divulgado' }; }],
    ['values que não é objeto', (b) => { b.values = []; }],
  ])('recusa: %s', (_nome, quebrar) => {
    const b = boa();
    quebrar(b);
    expect(() => assertBaseShape(b)).toThrow(/base do BLS recusada/);
  });

  it(`recusa mais de ${MAX_MONTHS} meses numa série`, () => {
    const b = boa();
    for (let i = 0; i < MAX_MONTHS + 1; i += 1) b.values[CPI_SA][`${2010 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`] = 100;
    expect(() => assertBaseShape(b)).toThrow(/base do BLS recusada/);
  });
});

describe('mergeBase — a fusão que nunca perde o que já foi lido', () => {
  const fundir = (base, series, gaps = {}, opts = { seedGaps: {} }) => mergeBase(base, { series: { ...nenhumaLacuna, ...series }, gaps: { ...nenhumaLacuna, ...gaps } }, opts);

  it('a 1ª coleta preenche a base com tudo o que a API trouxe e marca `changed`', () => {
    const r = fundir(emptyBase(), ANTES);
    expect(r.changed).toBe(true);
    expect(r.base.values[CPI_SA]).toEqual({ '2026-08': 100, '2026-09': 100.3 });
    expect(r.base.values[CPI_NSA]).toEqual({ '2025-09': 100, '2026-09': 103 });
    expect(r.stats.written).toBe(10);
    expect(() => assertBaseShape(r.base)).not.toThrow();
  });

  it('resposta NULA, vazia ou parcial: a base fica IDÊNTICA, byte a byte, e `changed` é falso', () => {
    const base = fundir(emptyBase(), ANTES).base;
    const antes = serializeBase(base);
    for (const series of [{}, { [CPI_SA]: null, [CPI_NSA]: null }, { [CPI_SA]: mapa([]) }, { [CPI_SA]: mapa([['2026-09', 100.3]]) }]) {
      const r = fundir(base, series);
      expect(serializeBase(r.base), json(series)).toBe(antes);
      expect(r.changed, json(series)).toBe(false);
    }
    const semNada = mergeBase(base, null, { seedGaps: {} });
    expect(serializeBase(semNada.base)).toBe(antes);
    expect(semNada.changed).toBe(false);
  });

  it('a API só traz o mês novo: ele entra e todo o passado continua lá', () => {
    const base = fundir(emptyBase(), ANTES).base;
    const r = fundir(base, SO_OUTUBRO);
    expect(r.base.values[CPI_SA]).toEqual({ '2026-08': 100, '2026-09': 100.3, '2026-10': 100.8 });
    expect(r.base.values[CPI_NSA]['2025-09']).toBe(100);
    expect(r.changed).toBe(true);
  });

  it('revisão pequena do BLS (até 5%) sobrescreve o valor guardado', () => {
    const base = fundir(emptyBase(), ANTES).base;
    const r = fundir(base, { [CPI_SA]: mapa([['2026-09', 100.4]]) });
    expect(r.base.values[CPI_SA]['2026-09']).toBe(100.4);
    expect(r.stats.rejected).toBe(0);
  });

  it('salto acima de 5% sobre o valor guardado é RECUSADO e contado (série errada ou dado corrompido); 5% exatos ainda passam', () => {
    const base = fundir(emptyBase(), ANTES).base;
    const r = fundir(base, { [CPI_SA]: mapa([['2026-09', 150]]) });
    expect(r.base.values[CPI_SA]['2026-09']).toBe(100.3);
    expect(r.stats.rejected).toBe(1);
    expect(r.changed).toBe(false);
    expect(fundir(base, { [CPI_SA]: mapa([['2026-09', 100.3 * 1.05]]) }).stats.rejected).toBe(0);
    expect(fundir(base, { [CPI_SA]: mapa([['2026-09', 100.3 * 1.0501]]) }).stats.rejected).toBe(1);
  });

  it('número fora da faixa plausível ou mês mal formado vindo da API é ignorado', () => {
    const r = fundir(emptyBase(), { [CPI_SA]: mapa([['2026-09', 100.3], ['2026-13', 5], ['26-01', 5], ['2026-08', Number.NaN], ['2026-07', -1], ['2026-06', 1e9]]) });
    expect(r.base.values[CPI_SA]).toEqual({ '2026-09': 100.3 });
  });

  it('a linha "-" da API vira lacuna com o motivo; um valor guardado NUNCA vira lacuna', () => {
    const r = fundir(emptyBase(), { [CPI_NSA]: mapa([['2026-09', 103]]) }, { [CPI_NSA]: mapa([['2025-10', 'paralisacao_2025'], ['2026-09', 'nao_divulgado']]) });
    expect(r.base.gaps[CPI_NSA]).toEqual({ '2025-10': 'paralisacao_2025' });
    expect(r.base.values[CPI_NSA]).toEqual({ '2026-09': 103 });
  });

  it('motivo desconhecido vindo da API vira "nao_divulgado" (o texto nunca passa)', () => {
    const r = fundir(emptyBase(), {}, { [CPI_NSA]: mapa([['2025-10', 'texto livre do BLS https://x.invalido']]) });
    expect(r.base.gaps[CPI_NSA]).toEqual({ '2025-10': 'nao_divulgado' });
  });

  it('o valor que chega DEPOIS apaga a lacuna (o BLS publicou mais tarde)', () => {
    const base = fundir(emptyBase(), { [CPI_NSA]: mapa([['2026-09', 103]]) }, { [CPI_NSA]: mapa([['2025-10', 'paralisacao_2025']]) }).base;
    const r = fundir(base, { [CPI_NSA]: mapa([['2025-10', 99.5]]) });
    expect(r.base.values[CPI_NSA]['2025-10']).toBe(99.5);
    expect(r.base.gaps[CPI_NSA]).toBeUndefined();
  });

  it('a semente de lacunas oficiais (CPI de out/2025) entra mesmo com a API muda, e some quando o valor chega', () => {
    expect(SEED_GAPS[CPI_SA]['2025-10']).toBe('paralisacao_2025');
    expect(SEED_GAPS[CPI_NSA]['2025-10']).toBe('paralisacao_2025');
    expect(SEED_GAPS.WPSFD4).toBeUndefined(); // o PPI de out/2025 foi publicado depois
    const semente = mergeBase(emptyBase(), { series: nenhumaLacuna, gaps: nenhumaLacuna });
    expect(semente.base.gaps[CPI_SA]).toEqual({ '2025-10': 'paralisacao_2025' });
    expect(semente.base.gaps[CPI_NSA]).toEqual({ '2025-10': 'paralisacao_2025' });
    const depois = mergeBase(semente.base, { series: { ...nenhumaLacuna, [CPI_NSA]: mapa([['2025-10', 99.5]]) }, gaps: nenhumaLacuna });
    expect(depois.base.gaps[CPI_NSA]).toBeUndefined();
    expect(depois.base.gaps[CPI_SA]).toEqual({ '2025-10': 'paralisacao_2025' });
  });

  it('mesma entrada, mesmos bytes (ordem estável: não gera commit à toa)', () => {
    const a = fundir(emptyBase(), { ...ANTES, ...SO_OUTUBRO, [CPI_SA]: mapa([['2026-10', 100.8], ['2026-08', 100], ['2026-09', 100.3]]) }).base;
    const b = fundir(emptyBase(), { ...ANTES, ...SO_OUTUBRO, [CPI_SA]: mapa([['2026-09', 100.3], ['2026-10', 100.8], ['2026-08', 100]]) }).base;
    expect(serializeBase(a)).toBe(serializeBase(b));
    expect(serializeBase(a).endsWith('\n')).toBe(true);
  });

  it('a base guardada é sanitizada antes de fundir (arquivo ruim no disco não derruba nem contamina)', () => {
    const r = mergeBase({ version: BASE_VERSION, source: BASE_SOURCE, values: { [CPI_SA]: { '2026-09': 'lixo', '2026-08': 100 } }, gaps: {} }, { series: { ...nenhumaLacuna, [CPI_SA]: mapa([['2026-09', 100.3]]) }, gaps: nenhumaLacuna }, { seedGaps: {} });
    expect(r.base.values[CPI_SA]).toEqual({ '2026-08': 100, '2026-09': 100.3 });
  });
});

describe('baseToSeries / base fundida com a API', () => {
  it('a base preenche o que a API não trouxe; onde as duas têm o mês, a API vence; sem nada, null', () => {
    const base = baseCom(ANTES);
    const u = uniao(base, { ...nenhumaLacuna, [CPI_SA]: mapa([['2026-10', 100.8], ['2026-09', 100.4]]) });
    expect([...u[CPI_SA].entries()].sort()).toEqual([['2026-08', 100], ['2026-09', 100.4], ['2026-10', 100.8]]);
    expect(u[CPI_NSA].get('2025-09')).toBe(100);
    expect(uniao(emptyBase(), nenhumaLacuna)[CPI_SA]).toBeNull();
    expect(uniao(emptyBase(), null)[CPI_NSA]).toBeNull();
    expect(baseToSeries(base)[CPI_SA].get('2026-09')).toBe(100.3);
  });
});

describe('o cálculo com base + API parcial (o caso de 10/11/2026)', () => {
  it('a API só traz outubro: SEM a base não há texto; COM a base sai o mesmo texto de quando ela traz tudo', () => {
    const base = baseCom(ANTES_COM_OUT25);
    expect(previousValueText('CPI', SO_OUTUBRO, '2026-10')).toBeNull(); // sem a base, a resposta parcial não dá nem o "Anterior"
    expect(actualValueText('CPI', SO_OUTUBRO, '2026-10')).toBeNull();
    const u = uniao(base, SO_OUTUBRO);
    expect(previousValueText('CPI', u, '2026-10')).toBe('+0,3% m/m · +3,0% a/a');
    expect(actualValueText('CPI', u, '2026-10')).toBe('+0,5% m/m · +4,0% a/a');
    expect(actualValueText('PPI', u, '2026-10')).toBe('+0,5% m/m · +2,0% a/a');
    expect(actualValueText('NFP', u, '2026-10')).toBe('+81 mil');
  });

  it('o buraco de out/2025 no CPI: a base registra a lacuna e o "Atual" sai só com o mês (a janela alternativa vem depois)', () => {
    const series = {
      [CPI_SA]: mapa([['2026-09', 100.3], ['2026-10', 100.8]]),
      [CPI_NSA]: mapa([['2025-09', 100], ['2025-11', 100.5], ['2026-09', 103], ['2026-10', 104]]),
    };
    const base = mergeBase(emptyBase(), { series: { ...nenhumaLacuna, ...series }, gaps: nenhumaLacuna }).base; // com a semente
    expect(base.gaps[CPI_NSA]['2025-10']).toBe('paralisacao_2025');
    expect(actualValueText('CPI', uniao(base, nenhumaLacuna), '2026-10')).toBe('+0,5% m/m');
  });
});

describe('describeBase — a linha do resumo (só contagens e códigos)', () => {
  it('conta valores e lacunas e lista as lacunas por série e mês, sem texto do BLS, chave nem URL', () => {
    const base = mergeBase(emptyBase(), { series: { ...nenhumaLacuna, ...ANTES }, gaps: nenhumaLacuna }).base;
    const linha = describeBase(base, { written: 10, rejected: 0 }, 'gravada');
    expect(linha).toContain('Base do BLS:');
    expect(linha).toContain('10 valores');
    expect(linha).toContain('2 lacunas');
    expect(linha).toContain('CUUR0000SA0 2025-10 (paralisacao_2025)');
    expect(linha).toContain('gravada');
    expect(linha).not.toMatch(/https?:|key|chave/i);
    expect(describeBase(base, { written: 0, rejected: 2 }, 'inalterada')).toContain('2 saltos recusados');
  });
});

describe('coletor de ponta a ponta (main) com a base', () => {
  const FKEY = 'fredkey0123456789abcdef0123456789';
  const BKEY = 'blskey0123456789abcdef0123456789';
  const NOW = Date.parse('2026-10-31T12:00:00Z');
  const AFTER_CPI = Date.parse('2026-11-10T13:30:00Z') + 30 * 60000;
  const FRED = {
    CPI: ['2026-10-14', '2026-11-10', '2026-12-10'],
    NFP: ['2026-10-02', '2026-11-06', '2026-12-04'],
    PPI: ['2026-10-15', '2026-11-13', '2026-12-15'],
    PCE: ['2026-10-29', '2026-11-25', '2026-12-23'],
  };
  const resp = (id, entradas) => new Response(JSON.stringify({
    status: 'REQUEST_SUCCEEDED', message: [],
    Results: { series: [{ seriesID: id, data: entradas.map(([ym, v, notas]) => ({ year: ym.slice(0, 4), period: `M${ym.slice(5)}`, value: String(v), footnotes: notas ?? [{}] })) }] },
  }), { status: 200 });
  const fetchCom = (blsPorId) => async (url) => {
    const u = String(url);
    if (u.includes('api.bls.gov')) {
      const id = u.slice(u.lastIndexOf('/') + 1).split('?')[0];
      const r = blsPorId(id);
      return r === 'erro' ? new Response('x', { status: 500 }) : resp(id, r);
    }
    const idRelease = Number(new URL(u).searchParams.get('release_id'));
    const kind = Object.entries(FRED_RELEASES).find(([, v]) => v === idRelease)?.[0];
    return new Response(JSON.stringify({ release_dates: FRED[kind].map((date) => ({ release_id: 1, date })) }), { status: 200 });
  };
  const doMapa = (series) => (id) => [...series[id].entries()];
  const pasta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-base-'));
  async function rodar(dir, blsPorId, now, extra = {}) {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      const code = await main(['--dir', dir], { FRED_API_KEY: FKEY, BLS_API_KEY: BKEY, ...extra }, { fetchImpl: fetchCom(blsPorId), now: () => now });
      return { code, logs: logs.join('\n') };
    } finally {
      console.log = orig;
    }
  }
  const lido = (dir, f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);
  const cpi = (dir) => JSON.parse(lido(dir, 'events.json')).find((e) => e.id === 'CPI-2026-11-10');

  it('a 1ª coleta grava `bls-base.json` válida, com a semente das lacunas, sem chave nem URL, e o resumo conta a base', async () => {
    const dir = pasta();
    try {
      const r = await rodar(dir, doMapa(ANTES), NOW);
      expect(r.code).toBe(0);
      const texto = lido(dir, 'bls-base.json');
      expect(texto).not.toBeNull();
      const base = JSON.parse(texto);
      expect(() => assertBaseShape(base)).not.toThrow();
      expect(base.values[CPI_SA]).toEqual({ '2026-08': 100, '2026-09': 100.3 });
      expect(base.gaps[CPI_NSA]).toEqual({ '2025-10': 'paralisacao_2025' });
      for (const t of [texto, lido(dir, 'events.json'), lido(dir, 'status.json'), r.logs]) {
        expect(t).not.toContain(BKEY);
        expect(t).not.toContain(FKEY);
        expect(t).not.toMatch(/api\.bls\.gov|registrationkey|https?:/);
      }
      expect(r.logs).toContain('Base do BLS:');
      expect(r.logs).toContain('gravada');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a API CAI depois: a base fica byte a byte igual e o resumo diz "inalterada"', async () => {
    const dir = pasta();
    try {
      await rodar(dir, doMapa(ANTES), NOW);
      const antes = lido(dir, 'bls-base.json');
      const r = await rodar(dir, () => 'erro', NOW + 3600000);
      expect(r.code).toBe(0);
      expect(lido(dir, 'bls-base.json')).toBe(antes);
      expect(r.logs).toContain('inalterada');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('o BLS divulga e a API devolve SÓ o mês novo: o "Atual" completo sai calculado da base (antes da base ficava sem número)', async () => {
    const dir = pasta();
    try {
      await rodar(dir, doMapa(ANTES_COM_OUT25), NOW);
      const r = await rodar(dir, doMapa(SO_OUTUBRO), AFTER_CPI);
      expect(r.code).toBe(0);
      expect(cpi(dir).values).toEqual({ previous: '+0,3% m/m · +3,0% a/a', actual: '+0,5% m/m · +4,0% a/a', source: 'BLS' });
      expect(JSON.parse(lido(dir, 'bls-base.json')).values[CPI_SA]).toEqual({ '2026-08': 100, '2026-09': 100.3, '2026-10': 100.8 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a linha "-" do BLS entra como lacuna oficial na base e a coleta segue', async () => {
    const dir = pasta();
    try {
      const comLacuna = (id) => (id === CPI_NSA
        ? [['2026-09', 103], ['2025-10', '-', [{ code: 'X', text: 'Data unavailable due to the 2025 lapse in appropriations.' }]], ['2025-09', 100]]
        : [...ANTES[id].entries()]);
      const r = await rodar(dir, comLacuna, NOW);
      expect(r.code).toBe(0);
      const base = JSON.parse(lido(dir, 'bls-base.json'));
      expect(base.gaps[CPI_NSA]).toEqual({ '2025-10': 'paralisacao_2025' });
      expect(base.values[CPI_NSA]).toEqual({ '2025-09': 100, '2026-09': 103 });
      expect(r.logs).toContain('CUUR0000SA0 2025-10 (paralisacao_2025)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('revisão da API acima de 5% é RECUSADA pela base E não entra nos números dos eventos (achado do Codex no PR #558)', async () => {
    const dir = pasta();
    try {
      const r1 = await rodar(dir, doMapa(ANTES_COM_OUT25), NOW);
      expect(r1.code).toBe(0);
      expect(cpi(dir).values.previous).toBe('+0,3% m/m · +3,0% a/a');
      const baseAntes = lido(dir, 'bls-base.json');
      // O BLS "revisa" o índice sem ajuste de set/2026 de 103 para 125 (+21%): absurdo, tem de ser recusado em TODO lugar.
      const absurdo = { ...ANTES_COM_OUT25, CUUR0000SA0: mapa([['2026-09', 125], ['2025-09', 100], ['2025-10', 100]]) };
      const r2 = await rodar(dir, doMapa(absurdo), NOW + 3600000);
      expect(r2.code).toBe(0);
      expect(lido(dir, 'bls-base.json')).toBe(baseAntes);
      expect(r2.logs).toContain('1 salto recusado');
      expect(cpi(dir).values.previous).toBe('+0,3% m/m · +3,0% a/a'); // não +0,3% m/m · +25,0% a/a
      expect(lido(dir, 'events.json')).not.toContain('25,0%');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uma linha "-" FORA da semente (PPI, mar/2026) chega à base só como código do motivo — a passagem API → base funciona e o texto do BLS nunca vai junto', async () => {
    const dir = pasta();
    try {
      const textoDoBls = 'Texto livre do BLS que nunca pode ir para a branch pública';
      const comLacunaNova = (id) => (id === 'WPUFD4'
        ? [...ANTES.WPUFD4.entries(), ['2026-03', '-', [{ code: 'Z', text: textoDoBls }]]]
        : [...ANTES[id].entries()]);
      const r = await rodar(dir, comLacunaNova, NOW);
      expect(r.code).toBe(0);
      const texto = lido(dir, 'bls-base.json');
      expect(JSON.parse(texto).gaps.WPUFD4).toEqual({ '2026-03': 'nao_divulgado' });
      expect(texto).not.toContain(textoDoBls);
      expect(r.logs).not.toContain(textoDoBls);
      expect(r.logs).toContain('WPUFD4 2026-03 (nao_divulgado)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('arquivo de base corrompido no disco: a coleta segue e a base volta válida (só o que presta é aproveitado)', async () => {
    const dir = pasta();
    try {
      fs.writeFileSync(path.join(dir, 'bls-base.json'), '{ isto não é json');
      const r1 = await rodar(dir, doMapa(ANTES), NOW);
      expect(r1.code).toBe(0);
      expect(() => assertBaseShape(JSON.parse(lido(dir, 'bls-base.json')))).not.toThrow();
      fs.writeFileSync(path.join(dir, 'bls-base.json'), json({ version: BASE_VERSION, source: BASE_SOURCE, values: { [CPI_SA]: { '2026-08': 100, '2026-09': 'lixo' }, https: { '2026-01': 1 } }, gaps: { [CPI_NSA]: { '2025-10': 'texto livre' } } }));
      const r2 = await rodar(dir, () => 'erro', NOW + 3600000);
      expect(r2.code).toBe(0);
      const base = JSON.parse(lido(dir, 'bls-base.json'));
      expect(() => assertBaseShape(base)).not.toThrow();
      expect(base.values[CPI_SA]).toEqual({ '2026-08': 100 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sem nenhum valor (API muda e base nova): não cria o arquivo da base só com a semente', async () => {
    const dir = pasta();
    try {
      const r = await rodar(dir, () => 'erro', NOW);
      expect(r.code).toBe(0);
      expect(lido(dir, 'bls-base.json')).toBeNull();
      expect(lido(dir, 'events.json')).not.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('o resultado dos eventos com base + API completa é IDÊNTICO ao de antes da base (nada muda para quem já funcionava)', () => {
    const previous = [];
    const semBase = buildEvents({ fredDatesByKind: FRED, nowMs: NOW, previous, blsSeries: ANTES });
    const comBase = buildEvents({ fredDatesByKind: FRED, nowMs: NOW, previous, blsSeries: uniao(baseCom(ANTES), ANTES) });
    expect(comBase).toEqual(semBase);
  });
});

describe('writeBase — a última trava antes do disco', () => {
  const pasta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-write-'));
  const calar = (fn) => {
    const orig = console.error;
    const vistas = [];
    console.error = (...a) => vistas.push(a.join(' '));
    try { return { r: fn(), vistas }; } finally { console.error = orig; }
  };

  it('base válida: grava; igual à do disco: "inalterada"; sem valores: não cria o arquivo', () => {
    const dir = pasta();
    try {
      const file = path.join(dir, 'bls-base.json');
      expect(writeBase(file, emptyBase())).toBe('não gravada (sem valores)');
      expect(fs.existsSync(file)).toBe(false);
      const base = baseCom(ANTES);
      expect(writeBase(file, base)).toBe('gravada');
      expect(fs.readFileSync(file, 'utf8')).toBe(serializeBase(base));
      expect(writeBase(file, base)).toBe('inalterada');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('base FORA da lista fechada (série desconhecida, motivo livre, URL): a trava recusa, nada vai para o disco e a mensagem não cita o conteúdo', () => {
    const dir = pasta();
    try {
      const file = path.join(dir, 'bls-base.json');
      const segredo = ['https:', '', 'api.exemplo.test', 'x?chave=SEGREDO123'].join('/');
      const ruins = [
        { ...baseCom(ANTES), values: { ...baseCom(ANTES).values, [segredo]: { '2026-01': 1 } } },
        { ...baseCom(ANTES), gaps: { [CPI_NSA]: { '2025-10': segredo } } },
        { ...baseCom(ANTES), source: segredo },
        { ...baseCom(ANTES), extra: segredo },
      ];
      for (const ruim of ruins) {
        const { r, vistas } = calar(() => writeBase(file, ruim));
        expect(r).toBe('NÃO gravada (a trava recusou)');
        expect(fs.existsSync(file)).toBe(false);
        expect(vistas.join('\n')).toContain('base do BLS recusada');
        expect(vistas.join('\n')).not.toContain('SEGREDO123');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readBase: arquivo ausente, quebrado ou de outra versão vira base vazia (nunca lança)', () => {
    const dir = pasta();
    try {
      const file = path.join(dir, 'bls-base.json');
      expect(readBase(file)).toEqual(emptyBase());
      fs.writeFileSync(file, '{ quebrado');
      expect(readBase(file)).toEqual(emptyBase());
      fs.writeFileSync(file, json({ version: 99, source: BASE_SOURCE, values: { [CPI_SA]: { '2026-09': 100 } }, gaps: {} }));
      expect(readBase(file)).toEqual(emptyBase());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('o workflow publica a base', () => {
  it('o passo de publicação inclui `bls-base.json` sem quebrar quando o arquivo não existe (git add só se existir)', () => {
    const yml = fs.readFileSync(path.join(process.cwd(), '.github/workflows/context-collect.yml'), 'utf8');
    const codigo = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(codigo).toMatch(/git add events\.json status\.json/);
    expect(codigo).toMatch(/if \[ -e bls-base\.json \]; then\s*\n\s*git add bls-base\.json\s*\n\s*fi/);
  });

  it('a base mora nos nomes conhecidos: as 5 séries do BLS e só elas', () => {
    expect(allSeriesIds().sort()).toEqual(Object.values(BLS_SERIES).flatMap((o) => Object.values(o)).sort());
    expect(Object.keys(emptyBase()).sort()).toEqual(['gaps', 'source', 'values', 'version']);
  });
});
