// docs/known-risks.md item 266 — laboratório de padrões (B1). Os testes que
// importam: (1) nada do futuro entra num sinal; (2) um padrão PLANTADO é
// achado e passa nas duas fases; (3) ruído puro não passa; (4) o
// pré-registro está travado; (5) o período final não abre.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ranks,
  spearman,
  holmAdjust,
  normalCdf,
  causalPercentile,
  computeFeatures,
  computeTargets,
  splitIndices,
  evaluateTest,
  runPatternLab,
  assertHoldoutSealed,
  formatPatternLabMarkdown,
  HOLDOUT_UNLOCK_PHRASE,
} from './patternLab.mjs';
import { mulberry32 } from './backtest-correlation-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREREG = JSON.parse(readFileSync(resolve(__dirname, '../docs/experiments/pattern-lab-prereg.json'), 'utf8'));
const H4 = 4 * 60 * 60 * 1000;

describe('estatística básica (valores feitos à mão)', () => {
  it('postos com empate pela média; Spearman; Holm de livro; normal', () => {
    expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    // Σd² = 4 → 1 − 6·4/(5·24) = 0,8
    expect(spearman([1, 2, 3, 4, 5], [2, 1, 4, 3, 5])).toBeCloseTo(0.8, 12);
    expect(holmAdjust([0.01, 0.04, 0.03, 0.005, null]).map((v) => (v == null ? null : +v.toFixed(4)))).toEqual([0.03, 0.06, 0.06, 0.02, null]);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
  });
});

// Barras sintéticas contínuas, com todos os campos preenchidos.
function synthBars(n, seed, { start = Date.UTC(2024, 0, 1, 4) } = {}) {
  const rand = mulberry32(seed);
  let close = 100;
  return Array.from({ length: n }, (_, i) => {
    close *= Math.exp((rand() - 0.5) * 0.02);
    return {
      t: start + i * H4, close, volume: 100, takerBuyVolume: 100 * rand(),
      premium: (rand() - 0.5) * 1e-3, fundingPerHour: (rand() - 0.5) * 1e-4,
      openInterest: 1000 + 100 * rand(), topPositionLS: 0.5 + rand(), globalAccountLS: 0.5 + rand(),
    };
  });
}
const NORM = { barMs: H4, percentileWindowBars: 30, percentileMinBars: 15 };

describe('sinais causais — nada do futuro entra', () => {
  it('percentil causal: o valor na barra i é igual com a série inteira ou só até i; abaixo do mínimo é null', () => {
    const v = Array.from({ length: 50 }, (_, i) => Math.sin(i) * 10);
    const full = causalPercentile(v, 20, 10);
    for (const i of [9, 10, 25, 49]) expect(causalPercentile(v.slice(0, i + 1), 20, 10)[i]).toBe(full[i]);
    expect(full[8]).toBeNull();
  });

  it('todos os 11 sinais da barra i são iguais com as barras inteiras ou só até i', () => {
    const bars = synthBars(200, 1);
    const full = computeFeatures(bars, NORM);
    for (const i of [130, 150, 199]) {
      const prefix = computeFeatures(bars.slice(0, i + 1), NORM);
      for (const key of Object.keys(full)) expect(prefix[key][i], `${key}@${i}`).toBe(full[key][i]);
    }
  });

  it('mudar barras DEPOIS de i muda o alvo de i, mas nenhum sinal de i (não-vacuidade)', () => {
    const bars = synthBars(200, 2);
    const altered = bars.map((b, k) => (k > 150 ? { ...b, close: b.close * 3, takerBuyVolume: 99, openInterest: 1e6 } : b));
    const a = computeFeatures(bars, NORM);
    const b = computeFeatures(altered, NORM);
    for (const key of Object.keys(a)) expect(b[key][150], key).toBe(a[key][150]);
    const ta = computeTargets(bars, 1, { barMs: H4, volWindowBars: 30 });
    const tb = computeTargets(altered, 1, { barMs: H4, volWindowBars: 30 });
    expect(tb.z[150]).not.toBe(ta.z[150]);
  });

  it('vela faltando no meio anula o que depende dela (nunca junta períodos de tamanhos diferentes)', () => {
    const bars = synthBars(200, 3).filter((_, k) => k !== 145);
    const f = computeFeatures(bars, NORM);
    const i = bars.findIndex((b) => b.t === Date.UTC(2024, 0, 1, 4) + 146 * H4);
    expect(f.F5_oiChange4h[i]).toBeNull(); // a vela anterior não existe
    expect(f.F1_flow4h[i]).not.toBeNull(); // o que é da própria vela continua
  });
});

describe('splitIndices', () => {
  it('fechamento em [from, to) e alvo que não atravessa o fim', () => {
    const bars = synthBars(20, 4);
    const fromMs = bars[2].t;
    const toMs = bars[10].t;
    expect(splitIndices(bars, 1, { fromMs, toMs, barMs: H4 })).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(splitIndices(bars, 6, { fromMs, toMs, barMs: H4 })).toEqual([2, 3, 4]);
  });
});

describe('evaluateTest', () => {
  it('determinístico com a mesma seed', () => {
    const rand = mulberry32(9);
    const n = 1500;
    const mk = (sym) => {
      const t = Array.from({ length: n }, (_, i) => Date.UTC(2024, 0, 1) + i * H4);
      const x = t.map(() => rand());
      const z = x.map((v) => v + rand());
      return { symbol: sym, t, x, z, bps: z.map((v) => v * 10), idx: t.map((_, i) => i) };
    };
    const data = [mk('A'), mk('B')];
    const opts = { minRowsPerSymbol: 1000, bootstrapReps: 200, seed: 1 };
    const a = evaluateTest(data, opts);
    expect(evaluateTest(data, opts)).toEqual(a);
    expect(a.eligibleSymbols).toBe(2);
    expect(a.ic).toBeGreaterThan(0.5);
  });
});

// Laboratório inteiro sobre 7 moedas sintéticas no calendário real do
// pré-registro. `beta` > 0 planta: o retorno da próxima vela depende do fluxo
// agressor da vela atual. Todos os campos vêm preenchidos (ruído), exceto
// quando `derivatives` é falso — aí funding/prêmio/metrics ficam nulos, como
// num arquivo que a Binance não publicou (o downloader trata 404 como ausência).
function synthDataset(beta, seed, { derivatives = true } = {}) {
  const start = Date.parse(`${PREREG.dataStart}T04:00:00Z`);
  const end = Date.parse(`${PREREG.dataEnd}T00:00:00Z`);
  const n = Math.floor((end - start) / H4) + 1;
  return PREREG.symbols.map((symbol, s) => {
    const rand = mulberry32(seed + s);
    let close = 100;
    const noise = mulberry32(seed + 1000 + s);
    let prevFlow = 0;
    let oi = 1000;
    const bars = [];
    for (let i = 0; i < n; i += 1) {
      close *= Math.exp(beta * prevFlow * 0.01 + (rand() - 0.5) * 0.02);
      const flow = rand() * 2 - 1;
      oi *= Math.exp((noise() - 0.5) * 0.02);
      const deriv = derivatives
        ? { premium: (noise() - 0.5) * 1e-3, fundingPerHour: (noise() - 0.5) * 1e-5, openInterest: oi, topPositionLS: 0.5 + noise(), globalAccountLS: 0.5 + noise() }
        : { premium: null, fundingPerHour: null, openInterest: null, topPositionLS: null, globalAccountLS: null };
      bars.push({ t: start + i * H4, close, volume: 100, takerBuyVolume: 50 * (flow + 1), ...deriv });
      prevFlow = flow;
    }
    return { symbol, bars };
  });
}
const FAST = { ...PREREG, stats: { ...PREREG.stats, bootstrapReps: 300 } };

describe('runPatternLab — o laboratório acha o que existe e não inventa o que não existe', () => {
  it('padrão plantado no fluxo 4h é achado e passa nas duas fases', () => {
    const r = runPatternLab(synthDataset(0.6, 100), FAST);
    expect(r.verdict).toBe('VALIDATED');
    expect(r.validated).toContain('F1_flow4h@1');
    const f1 = r.tests.find((x) => x.feature === 'F1_flow4h' && x.horizonBars === 1);
    expect(f1.discovery.ic).toBeGreaterThan(0);
    expect(f1.discovery.eligibleSymbols).toBe(7);
    expect(r.untested).toEqual([]);
    expect(formatPatternLabMarkdown(r)).toMatch(/Achei um candidato/);
  });

  it('sinal pré-registrado sem dado invalida a rodada (INCOMPLETE), mesmo com o padrão plantado achado', () => {
    const r = runPatternLab(synthDataset(0.6, 100, { derivatives: false }), FAST);
    expect(r.verdict).toBe('INCOMPLETE');
    // F3–F9 (funding, prêmio, contratos em aberto, proporções) × 2 horizontes.
    expect(r.untested.map((u) => u.test).sort()).toEqual(
      ['F3_funding', 'F4_basis', 'F5_oiChange4h', 'F6_oiChange24h', 'F7_topTraderPosition', 'F8_topVsCrowd', 'F9_oiPriceDivergence']
        .flatMap((f) => [`${f}@1`, `${f}@6`]).sort(),
    );
    expect(r.tests.find((x) => x.feature === 'F3_funding').discovery.reasons).toEqual(['sem ativos com dado suficiente']);
    const md = formatPatternLabMarkdown(r);
    expect(md).toMatch(/Resultado inválido/);
    expect(md).not.toMatch(/Não achei padrão|Achei um candidato/);
  });

  it('dado em poucas moedas (abaixo do mínimo pré-registrado) também é INCOMPLETE, não "não achei"', () => {
    const data = synthDataset(0, 200);
    for (const d of data.slice(PREREG.stats.minEligibleSymbols - 1)) {
      for (const b of d.bars) { b.openInterest = null; b.topPositionLS = null; b.globalAccountLS = null; }
    }
    const r = runPatternLab(data, FAST);
    expect(r.verdict).toBe('INCOMPLETE');
    const f5 = r.tests.find((x) => x.feature === 'F5_oiChange4h' && x.horizonBars === 1);
    expect(f5.discovery.eligibleSymbols).toBe(PREREG.stats.minEligibleSymbols - 1);
    expect(f5.discovery.pass).toBe(false);
    expect(r.untested).toContainEqual({ test: 'F5_oiChange4h@1', phase: 'discovery', eligibleSymbols: PREREG.stats.minEligibleSymbols - 1 });
  });

  it('pré-registro sem o mínimo de moedas é recusado (senão a guarda some em silêncio)', () => {
    const { minEligibleSymbols, ...stats } = FAST.stats;
    expect(minEligibleSymbols).toBe(4);
    expect(() => runPatternLab(synthDataset(0, 1), { ...FAST, stats })).toThrow(/minEligibleSymbols/);
  });

  it('ruído puro: nenhum sinal passa', () => {
    const r = runPatternLab(synthDataset(0, 200), FAST);
    expect(r.verdict).toBe('NO_SURVIVOR');
    expect(r.untested).toEqual([]);
    expect(r.discoverySurvivors).toEqual([]);
    expect(r.testsSpent).toBe(22);
    expect(formatPatternLabMarkdown(r)).toMatch(/Não achei padrão/);
  });
}, 60000);

describe('pré-registro travado (mudar exige mudar este teste, à vista no PR)', () => {
  it('11 sinais × 2 horizontes, períodos, réguas e seed congelados', () => {
    expect(PREREG.features).toHaveLength(11);
    expect(PREREG.horizonsBars).toEqual([1, 6]);
    expect(PREREG.symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'FETUSDT', 'PENDLEUSDT', 'ZROUSDT', 'DYDXUSDT', 'PAXGUSDT']);
    expect(PREREG.dataStart).toBe('2021-09-01');
    expect(PREREG.dataEnd).toBe('2025-10-02');
    expect(PREREG.splits).toEqual({
      discovery: { from: '2021-12-01', to: '2024-11-01' },
      validation: { from: '2024-11-08', to: '2025-10-01' },
      holdout: { from: '2025-10-08', to: '2026-10-01', sealed: true },
    });
    expect(PREREG.stats).toEqual({
      bootstrapReps: 2000, seed: 20261010, minRowsPerSymbol: 1000, minEligibleSymbols: 4,
      discovery: { holmAlpha: 0.05, minAbsT: 3, minSameSignShare: 0.8, minHalfSpreadBps: 12 },
      validation: { minIcRatio: 0.5, minOneSidedT: 2, minSameSignShare: 0.6667 },
    });
    // O fim do dado baixado nunca alcança o período lacrado.
    expect(Date.parse(PREREG.dataEnd)).toBeLessThan(Date.parse(PREREG.splits.holdout.from));
  });
});

describe('período final lacrado', () => {
  it('sem a frase e o arquivo de regra, ou mesmo com eles (B2 não existe), lança HOLDOUT_SEALED', () => {
    expect(() => assertHoldoutSealed()).toThrow(/HOLDOUT_SEALED/);
    expect(() => assertHoldoutSealed({ openHoldout: HOLDOUT_UNLOCK_PHRASE })).toThrow(/HOLDOUT_SEALED/);
    expect(() => assertHoldoutSealed({ openHoldout: HOLDOUT_UNLOCK_PHRASE, ruleFileSha256: 'abc' })).toThrow(/B2 ainda não existe/);
  });
});
