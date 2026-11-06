// Item 285, addendum 18 — Agenda 4d, etapa 1: a medição da reação do BTC nas divulgações passadas. Parte pura (contextReaction.mjs) com valores
// calculados à mão e a entrada (context-reaction.mjs) com `fetch` de mentira. O que importa: a conta não desloca a janela em 1 vela, buraco no
// dado nunca vira número, o relatório mostra sempre o N e nunca prevê, e a chave do FRED nunca sai no texto.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OFFSETS_MIN, WINDOW_CANDLES, SMALL_SAMPLE, MIN_NORMAL_DAYS, parseKlines, releaseInstants, normalDayInstants, reactionAt, median, percentRank,
  summarizeGroup, compareToNormal, formatReport, formatEventList, formatYearTable, monthsWithTwoDates, toJson, REPORT_NOTE,
} from './contextReaction.mjs';
import { main, fetchWindow, fetchPastFredDates, NORMAL_DAYS } from './context-reaction.mjs';

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 6, 13, 30); // Payroll de 06/11 (13:30 UTC)

/** 61 velas (do minuto antes até o fim da 1ª hora), todas paradas em 100, com ajustes pontuais por minuto relativo a T0. */
function candlesAround(t0, tweaks = {}) {
  return Array.from({ length: WINDOW_CANDLES }, (_, i) => {
    const rel = i - 1; // -1 = a vela de referência
    const base = { t: t0 + rel * MIN, o: 100, h: 100, l: 100, c: 100 };
    return { ...base, ...(tweaks[rel] ?? {}) };
  });
}

describe('parseKlines', () => {
  const row = (t, o, h, l, c) => [t, String(o), String(h), String(l), String(c), '1', t + 59999, '1', 1, '1', '1', '0'];
  it('lê as velas da Binance, em ordem, como números', () => {
    const out = parseKlines(JSON.stringify([row(2 * MIN, 2, 3, 1, 2), row(MIN, 1, 2, 1, 2)]));
    expect(out).toEqual([{ t: MIN, o: 1, h: 2, l: 1, c: 2 }, { t: 2 * MIN, o: 2, h: 3, l: 1, c: 2 }]);
  });
  it('recusa corpo que não serve (não é lista, linha curta, número inválido, máxima menor que a mínima)', () => {
    for (const bad of ['{}', 'não é json', JSON.stringify([[1, 2]]), JSON.stringify([row(MIN, 1, 2, 1, 'x')]), JSON.stringify([row(MIN, 1, 1, 2, 1)]), JSON.stringify([row(MIN, 0, 1, 1, 1)])]) {
      expect(parseKlines(bad), bad).toBeNull();
    }
  });
});

describe('reactionAt (contas à mão)', () => {
  it('movimento em +5/+30/+60 min contra o fechamento da vela que termina na divulgação; amplitude da 1ª hora', () => {
    const r = reactionAt(candlesAround(T0, {
      4: { c: 101 }, // a vela que ABRE em +4 min fecha em +5 min
      29: { c: 99 }, // fecha em +30 min
      59: { c: 102 }, // fecha em +60 min
      10: { h: 103 },
      20: { l: 98 },
    }), T0);
    expect(OFFSETS_MIN).toEqual([5, 30, 60]);
    expect(r.moves[5]).toBeCloseTo(1, 10);
    expect(r.moves[30]).toBeCloseTo(-1, 10);
    expect(r.moves[60]).toBeCloseTo(2, 10);
    expect(r.rangePct).toBeCloseTo(5, 10);
  });

  it('a referência é a vela que termina na divulgação, e a vela que abre na divulgação já conta como movimento (sem deslocar a janela em 1 vela)', () => {
    // vela de referência fecha em 100; a vela que abre em T0 sobe a máxima para 110: faz parte da amplitude.
    const r = reactionAt(candlesAround(T0, { 0: { h: 110 }, [-1]: { c: 100, h: 120, l: 50 } }), T0);
    expect(r.rangePct).toBeCloseTo(10, 10); // máxima/mínima da vela de REFERÊNCIA (120/50) não entram
  });

  it('falta de QUALQUER vela da janela (referência, marcos ou meio da hora) = null; nunca completa com vizinha', () => {
    const full = candlesAround(T0);
    expect(reactionAt(full, T0)).not.toBeNull();
    for (const rel of [-1, 0, 4, 17, 29, 59]) {
      expect(reactionAt(full.filter((c) => c.t !== T0 + rel * MIN), T0), `sem a vela ${rel}`).toBeNull();
    }
    expect(reactionAt([], T0)).toBeNull();
  });
});

describe('releaseInstants', () => {
  const NOW = Date.UTC(2026, 10, 6, 15, 0);
  it('08:30 de Nova York em UTC com o horário de verão certo (12:30 no verão, 13:30 no inverno)', () => {
    const out = releaseInstants({ CPI: ['2026-06-10', '2026-12-10'] }, { sinceDate: '2026-01-01', nowMs: Date.UTC(2027, 0, 1) });
    expect(out.map((x) => new Date(x.ms).toISOString())).toEqual(['2026-06-10T12:30:00.000Z', '2026-12-10T13:30:00.000Z']);
  });
  it('fora: anterior ao início, dentro dos 61 min finais, datas inválidas e tipo sem datas', () => {
    const out = releaseInstants({ NFP: ['2023-12-01', '2026-11-06', '2026-11-05', 'lixo'], PPI: null, CPI: undefined }, { sinceDate: '2024-01-01', nowMs: T0 + 30 * MIN });
    expect(out.map((x) => x.date)).toEqual(['2026-11-05']);
    expect(releaseInstants({ NFP: ['2026-11-06'] }, { sinceDate: '2024-01-01', nowMs: T0 + 61 * MIN }).map((x) => x.date)).toEqual(['2026-11-06']);
    expect(releaseInstants({ NFP: ['2026-11-06'] }, { sinceDate: '2024-01-01', nowMs: T0 + 61 * MIN - 1 })).toEqual([]);
    expect(NOW).toBeGreaterThan(T0);
  });
  it('ordem crescente de instante, desempate por tipo', () => {
    const out = releaseInstants({ PPI: ['2026-11-13', '2026-10-15'], CPI: ['2026-10-15'] }, { sinceDate: '2024-01-01', nowMs: Date.UTC(2027, 0, 1) });
    expect(out.map((x) => `${x.date}:${x.kind}`)).toEqual(['2026-10-15:CPI', '2026-10-15:PPI', '2026-11-13:PPI']);
  });
});

describe('normalDayInstants', () => {
  const NOW = Date.UTC(2026, 10, 6, 15, 0); // sexta
  it('só dias úteis sem divulgação; com mais dias elegíveis que o pedido, ESPALHA do mais antigo ao mais recente (inclui os dois extremos)', () => {
    // elegíveis desde 01/10: 24 dias úteis (22 de outubro sem o dia 14 + 3 de novembro até o dia 04, o dia 05 é divulgação)
    const out = normalDayInstants({ eventDates: ['2026-10-14', '2026-11-05'], nowMs: NOW, count: 3, sinceDate: '2026-10-01' });
    expect(out.map((x) => x.date)).toEqual(['2026-10-01', '2026-10-19', '2026-11-04']);
    const all = normalDayInstants({ eventDates: ['2026-10-14', '2026-11-05'], nowMs: NOW, count: 100, sinceDate: '2026-10-01' });
    expect(all).toHaveLength(24);
    for (const x of all) {
      expect([0, 6]).not.toContain(new Date(`${x.date}T12:00:00Z`).getUTCDay());
      expect(['2026-10-14', '2026-11-05']).not.toContain(x.date);
      expect(x.kind).toBe('NORMAL');
    }
    expect(all.map((x) => x.ms)).toEqual([...all.map((x) => x.ms)].sort((p, q) => p - q));
  });
  it('o resultado espalhado cobre o período inteiro e não repete dia', () => {
    const out = normalDayInstants({ eventDates: [], nowMs: NOW, count: 120, sinceDate: '2024-01-01' });
    expect(out).toHaveLength(120);
    expect(new Set(out.map((x) => x.date)).size).toBe(120);
    expect(out[0].date <= '2024-01-05').toBe(true); // o 1º dia útil elegível do período
    expect(out[out.length - 1].date).toBe('2026-11-05'); // o último elegível (hoje nunca entra)
    // cobre os 3 anos (não só os meses mais recentes)
    expect(new Set(out.map((x) => x.date.slice(0, 4)))).toEqual(new Set(['2024', '2025', '2026']));
  });
  it('o dia de hoje nunca entra: a lista começa em ontem, mesmo com a janela de hoje já fechada', () => {
    expect(normalDayInstants({ eventDates: ['2026-11-06'], nowMs: Date.UTC(2026, 10, 6, 14, 0), count: 1, sinceDate: '2026-10-01' })[0].date).toBe('2026-11-05');
    expect(normalDayInstants({ eventDates: [], nowMs: Date.UTC(2026, 10, 6, 14, 40), count: 1, sinceDate: '2026-10-01' })[0].date).toBe('2026-11-05');
  });
});

describe('median / percentRank', () => {
  it('mediana de par e ímpar, ignora não-números, vazio = null', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([1, NaN, null, undefined].filter((x) => x !== null && x !== undefined))).toBe(1);
    expect(median([])).toBeNull();
  });
  it('posição = fração dos valores ESTRITAMENTE menores', () => {
    expect(percentRank([1, 2, 3, 4], 3)).toBe(0.5);
    expect(percentRank([1, 2, 3, 4], 0)).toBe(0);
    expect(percentRank([1, 2, 3, 4], 9)).toBe(1);
    expect(percentRank([], 1)).toBeNull();
    expect(percentRank([1, 2], NaN)).toBeNull();
  });
});

describe('summarizeGroup / compareToNormal', () => {
  const rx = (m5, m30, m60, range) => ({ moves: { 5: m5, 30: m30, 60: m60 }, rangePct: range });
  const rows = [
    { date: 'a', reaction: rx(0.1, -0.2, 0.5, 1) },
    { date: 'b', reaction: rx(-0.3, 0.4, -1, 2) },
    { date: 'c', reaction: rx(0, 0, 0, 0.5) },
    { date: 'd', reaction: null },
  ];
  it('conta os sem dado à parte, tira medianas do tamanho (sem sinal) e conta subiu/caiu em 60 min (zero exato não conta)', () => {
    const g = summarizeGroup(rows);
    expect(g.total).toBe(4);
    expect(g.n).toBe(3);
    expect(g.noData).toBe(1);
    expect(g.medAbs[5]).toBeCloseTo(0.1, 10);
    expect(g.medAbs[60]).toBeCloseTo(0.5, 10);
    expect(g.medRange).toBe(1);
    expect(g.up60).toBe(1);
    expect(g.down60).toBe(1);
  });
  it('razão das medianas de 60 min e posição entre os dias normais; sem base = null', () => {
    const g = summarizeGroup(rows);
    const normal = summarizeGroup([0.1, 0.2, 0.25, 0.3, 0.9].map((m, i) => ({ date: String(i), reaction: rx(0, 0, m, 1) })));
    const v = compareToNormal(g, normal);
    expect(v.ratio60).toBeCloseTo(0.5 / 0.25, 10);
    expect(v.rank60).toBeCloseTo(4 / 5, 10); // 0,1/0,2/0,25/0,3 < 0,5 (0,9 não)
    expect(compareToNormal(summarizeGroup([]), normal)).toEqual({ ratio60: null, rank60: null });
    expect(compareToNormal(g, summarizeGroup([])).ratio60).toBeNull();
  });
});

describe('por ano e meses com 2 datas', () => {
  const rx = (m60) => ({ moves: { 5: m60 / 3, 30: m60 / 2, 60: m60 }, rangePct: Math.abs(m60) * 2 });
  const mk = (dates, m) => dates.map((date) => ({ date, reaction: rx(m) }));
  it('tabela por ano: casos e medianas dos dois lados do MESMO ano, razão só com pelo menos 5 casos de cada lado', () => {
    const ev = [...mk(['2024-01-05', '2024-02-02', '2024-03-08', '2024-04-05', '2024-05-03'], 1), ...mk(['2025-01-10', '2025-02-07'], 0.5)];
    const no = [...mk(['2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12'], 0.25), ...mk(['2025-01-13'], 0.2)];
    const txt = formatYearTable(ev, no);
    expect(txt).toContain('| 2024 | 5 | 1,00% | 5 | 0,25% | 4,0x |');
    expect(txt).toContain('| 2025 | 2 | 0,50% | 1 | 0,20% | poucos casos |');
  });
  it('acha meses com 2 datas do mesmo tipo (e não confunde tipos diferentes no mesmo mês)', () => {
    const rowsByKind = { CPI: mk(['2024-02-09', '2024-02-13', '2024-03-12'], 1), PPI: mk(['2024-02-14'], 1), NFP: mk(['2024-02-02', '2024-03-08'], 1) };
    expect(monthsWithTwoDates(rowsByKind)).toEqual(['CPI 2024-02']);
    expect(formatEventList(rowsByKind)).toMatch(/Meses com 2 datas do mesmo tipo.*CPI 2024-02/);
    expect(formatEventList({ NFP: mk(['2024-02-02', '2024-03-08'], 1) })).not.toMatch(/Meses com 2 datas/);
  });
});

describe('relatório', () => {
  const rx = (m60) => ({ moves: { 5: m60 / 3, 30: m60 / 2, 60: m60 }, rangePct: Math.abs(m60) * 2 });
  function build(nEvents, nNormal = 40) {
    const group = summarizeGroup(Array.from({ length: nEvents }, (_, i) => ({ date: `2025-${String((i % 12) + 1).padStart(2, '0')}-0${(i % 9) + 1}`, reaction: rx(i % 2 ? 0.6 : -0.9) })));
    const normal = summarizeGroup(Array.from({ length: nNormal }, (_, i) => ({ date: String(i), reaction: rx(i % 2 ? 0.3 : -0.4) })));
    return { perKind: { NFP: { group, vsNormal: compareToNormal(group, normal) } }, normal, generatedAtMs: T0, sinceDate: '2024-01-01' };
  }

  it('mostra o N de cada tipo e do dia normal, a razão e a posição, e avisa "amostra pequena" abaixo de 30 casos', () => {
    const txt = formatReport(build(12));
    expect(txt).toContain('Payroll (emprego) | 12 / 12 (amostra pequena)');
    expect(txt).toContain('Dia normal (mesmo horário, dia útil sem divulgação, espalhado pelo mesmo período) | 40 / 40');
    expect(txt).toMatch(/\| 2,1x \| maior que 100% dos dias normais \|/); // 0,75 / 0,35 = 2,14
    expect(formatReport(build(SMALL_SAMPLE))).not.toContain('amostra pequena');
    expect(SMALL_SAMPLE).toBe(30);
    expect(MIN_NORMAL_DAYS).toBe(20);
  });

  it('o texto sempre carrega os limites e NUNCA prevê direção, nem usa emoji', () => {
    const txt = `${formatReport(build(12))}\n${formatEventList({ NFP: [{ date: '2025-01-01', reaction: rx(0.5) }, { date: '2025-02-01', reaction: null }] })}`;
    expect(txt).toContain(REPORT_NOTE);
    expect(REPORT_NOTE).toMatch(/Correlação não é causa/);
    expect(REPORT_NOTE).toMatch(/expectativa/);
    expect(txt).not.toMatch(/vai (subir|cair|descer|aumentar)|tende a|deve (subir|cair)|probabilidade|previs[ãa]o de alta|compre|venda/i);
    expect(/\p{Extended_Pictographic}/u.test(txt)).toBe(false);
  });

  it('a lista por divulgação mostra o sinal dos movimentos e "sem dado" quando a janela falhou', () => {
    const list = formatEventList({ CPI: [{ date: '2025-03-12', reaction: rx(-0.9) }, { date: '2025-04-10', reaction: null }] });
    expect(list).toContain('| CPI | 2025-03-12 | -0,30% | -0,45% | -0,90% | 1,80% |');
    expect(list).toContain('| CPI | 2025-04-10 | sem dado | sem dado | sem dado | sem dado |');
  });

  it('o JSON tem só agregados (sem preços nem listas de velas) e números arredondados', () => {
    const j = toJson(build(12));
    expect(Object.keys(j)).toEqual(['version', 'generatedAt', 'sinceDate', 'normal', 'kinds']);
    expect(Object.keys(j.kinds.NFP)).toEqual(['total', 'n', 'noData', 'medAbs', 'medRange', 'up60', 'down60', 'ratio60', 'rank60']);
    expect(JSON.stringify(j)).not.toMatch(/abs60|candles|"o"|"c"/);
    expect(j.kinds.NFP.medAbs['60']).toBe(0.75);
  });
});

// ---- a entrada (context-reaction.mjs), com fetch de mentira -------------------------------------------------------------
const KEY = 'chave-secreta-do-fred-123';

function fakeFetch({ fredBody, klines, calls = [] } = {}) {
  return async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.hostname === 'api.stlouisfed.org') {
      const id = u.searchParams.get('release_id');
      const dates = (fredBody ?? {})[id] ?? [];
      return { status: 200, text: async () => JSON.stringify({ release_dates: dates.map((date) => ({ release_id: Number(id), date })) }) };
    }
    const start = Number(u.searchParams.get('startTime'));
    const limit = Number(u.searchParams.get('limit'));
    if (klines === 'vazio') return { status: 200, text: async () => '[]' };
    if (klines instanceof Set && !klines.has(start)) return { status: 200, text: async () => '[]' };
    // preço determinístico que varia por minuto: p(t) = 100 + (minuto % 7) * 0,1
    const rows = Array.from({ length: limit }, (_, i) => {
      const t = start + i * MIN;
      const p = 100 + (Math.floor(t / MIN) % 7) * 0.1;
      return [t, String(p), String(p + 0.05), String(p - 0.05), String(p), '1', t + 59999, '1', 1, '1', '1', '0'];
    });
    return { status: 200, text: async () => JSON.stringify(rows) };
  };
}

describe('context-reaction.mjs (entrada)', () => {
  const NOW = Date.UTC(2026, 10, 6, 16, 0);
  const FRED = { 50: ['2026-10-02', '2026-09-05', '2026-11-06'], 10: ['2026-10-14'], 46: ['2026-10-15'], 54: ['2026-10-29'] };

  it('mede, imprime o relatório e grava o JSON; a chave do FRED não aparece em nenhum lugar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-react-'));
    try {
      const out = [];
      const jsonPath = join(dir, 'r.json');
      const code = await main({ argv: ['--json', jsonPath], env: { FRED_API_KEY: KEY, CONTEXT_CONTACT_EMAIL: 'robo@example.com' }, fetchImpl: fakeFetch({ fredBody: FRED }), nowMs: NOW, log: (m) => out.push(m) });
      expect(code).toBe(0);
      const text = out.join('\n');
      expect(text).toContain('Como o BTC se mexeu nas divulgações passadas dos EUA');
      expect(text).toContain('Payroll (emprego) | 3 / 3');
      expect(text).toContain('### Por ano (todos os tipos juntos)');
      expect(text).toContain('### Divulgações medidas');
      expect(text).toContain(`Dia normal (mesmo horário, dia útil sem divulgação, espalhado pelo mesmo período) | ${NORMAL_DAYS} / ${NORMAL_DAYS}`);
      const json = readFileSync(jsonPath, 'utf8');
      expect(JSON.parse(json).kinds.NFP.n).toBe(3);
      expect(`${text}\n${json}`).not.toContain(KEY);
      expect(`${text}\n${json}`).not.toContain('robo@example.com');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('só pede ao FRED as datas (nunca valor de série) e à Binance as velas de 1 min do BTC/USDT', async () => {
    const calls = [];
    await main({ argv: [], env: { FRED_API_KEY: KEY }, fetchImpl: fakeFetch({ fredBody: FRED, calls }), nowMs: NOW, log: () => {} });
    const fred = calls.filter((c) => c.includes('stlouisfed.org'));
    expect(fred).toHaveLength(4);
    for (const c of fred) expect(c).toMatch(/\/fred\/release\/dates\?/);
    for (const c of fred) expect(c).toContain('include_release_dates_with_no_data=false'); // data sem dado = divulgação cancelada/remarcada, não é evento
    const bin = calls.filter((c) => !c.includes('stlouisfed.org'));
    expect(bin.length).toBe(6 + NORMAL_DAYS); // 6 divulgações passadas (3 Payroll + CPI + PPI + PCE) + os dias normais
    for (const c of bin) expect(c).toMatch(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines\?symbol=BTCUSDT&interval=1m&startTime=\d+&limit=61$/);
    // os dias normais ficam DENTRO do período medido (desde 01/01/2024) e cobrem os anos, não só os meses mais recentes
    const starts = bin.map((c) => Number(new URL(c).searchParams.get('startTime')));
    expect(Math.min(...starts)).toBeGreaterThanOrEqual(Date.UTC(2024, 0, 1));
    expect(Math.min(...starts)).toBeLessThan(Date.UTC(2024, 1, 1));
  });

  it('sem FRED_API_KEY, sem resposta do FRED ou sem velas: sai com 1 e diz o motivo', async () => {
    const out = [];
    expect(await main({ argv: [], env: {}, fetchImpl: fakeFetch({ fredBody: FRED }), nowMs: NOW, log: (m) => out.push(m) })).toBe(1);
    expect(out.join('\n')).toMatch(/FRED_API_KEY/);
    const out2 = [];
    const down = async () => ({ status: 503, text: async () => '' });
    expect(await main({ argv: [], env: { FRED_API_KEY: KEY }, fetchImpl: down, nowMs: NOW, log: (m) => out2.push(m) })).toBe(1);
    expect(out2.join('\n')).toMatch(/não respondeu/);
    expect(out2.join('\n')).not.toContain(KEY);
    const out3 = [];
    expect(await main({ argv: [], env: { FRED_API_KEY: KEY }, fetchImpl: fakeFetch({ fredBody: FRED, klines: 'vazio' }), nowMs: NOW, log: (m) => out3.push(m), sleep: async () => {} })).toBe(1);
    expect(out3.join('\n')).toMatch(/Dado insuficiente/);
  });

  it('sem dias normais suficientes com velas completas não há comparação: sai com 1 (mesmo com as divulgações medidas)', async () => {
    const eventStarts = new Set(releaseInstants({ NFP: FRED[50], CPI: FRED[10], PPI: FRED[46], PCE: FRED[54] }, { sinceDate: '2024-01-01', nowMs: NOW }).map((e) => e.ms - MIN));
    expect(eventStarts.size).toBe(6);
    const out = [];
    const code = await main({ argv: [], env: { FRED_API_KEY: KEY }, fetchImpl: fakeFetch({ fredBody: FRED, klines: eventStarts }), nowMs: NOW, log: (m) => out.push(m), sleep: async () => {} });
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/Dado insuficiente: 6 divulgação\(ões\) e 0 dia\(s\) normal\(is\)/);
  });

  it('se o FRED falhar em UM tipo, não mede (as divulgações dele entrariam nos "dias normais"); diz qual tipo faltou, sem a chave', async () => {
    const base = fakeFetch({ fredBody: FRED });
    const calls = [];
    const cpiFora = async (url) => {
      calls.push(String(url));
      if (String(url).includes('release_id=10&')) return { status: 503, text: async () => '' };
      return base(url);
    };
    const out = [];
    const code = await main({ argv: [], env: { FRED_API_KEY: KEY }, fetchImpl: cpiFora, nowMs: NOW, log: (m) => out.push(m), sleep: async () => {} });
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/calendário incompleto.*CPI/i);
    expect(out.join('\n')).not.toContain(KEY);
    expect(calls.filter((c) => c.includes('binance')).length).toBe(0); // nem chega a baixar velas
  });

  it('recusa data inicial fora do formato', async () => {
    const out = [];
    expect(await main({ argv: ['--since', '2024/01/01'], env: { FRED_API_KEY: KEY }, fetchImpl: fakeFetch({ fredBody: FRED }), nowMs: NOW, log: (m) => out.push(m) })).toBe(1);
    expect(out.join('\n')).toMatch(/Data inicial inválida/);
  });

  it('fetchWindow tenta de novo em 429 (e espera), desiste de 404 sem repetir e devolve null depois de 3 falhas de rede', async () => {
    const seq = (statuses) => {
      let i = 0;
      const calls = [];
      return { calls, fn: async () => { calls.push(1); const s = statuses[Math.min(i, statuses.length - 1)]; i += 1; if (s === 'rede') throw new Error('rede'); return { status: s, text: async () => (s === 200 ? JSON.stringify([[T0 - MIN, '1', '1', '1', '1', '1', T0, '1', 1, '1', '1', '0']]) : '') }; } };
    };
    const waits = [];
    const sleep = async (ms) => { waits.push(ms); };
    const a = seq([429, 200]);
    expect(await fetchWindow(T0, { fetchImpl: a.fn, sleep })).toHaveLength(1);
    expect(a.calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
    const b = seq([404]);
    expect(await fetchWindow(T0, { fetchImpl: b.fn, sleep })).toBeNull();
    expect(b.calls).toHaveLength(1);
    const c = seq(['rede']);
    expect(await fetchWindow(T0, { fetchImpl: c.fn, sleep })).toBeNull();
    expect(c.calls).toHaveLength(3);
  });

  it('fetchPastFredDates: sem chave nem chama; falha vira null sem mensagem', async () => {
    let called = 0;
    const f = async () => { called += 1; throw new Error(`falhou ${KEY}`); };
    expect(await fetchPastFredDates({ fetchImpl: f, env: {} })).toEqual({ CPI: null, NFP: null, PPI: null, PCE: null });
    expect(called).toBe(0);
    expect(await fetchPastFredDates({ fetchImpl: f, env: { FRED_API_KEY: KEY } })).toEqual({ CPI: null, NFP: null, PPI: null, PCE: null });
    expect(called).toBe(4);
  });
});
