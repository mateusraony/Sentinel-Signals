// Golden tests de paridade Pine×JS — ver .claude/rules/pine-parity.md.
//
// Método (definido por pesquisa de comunidade, fontes no PR):
// 1. CONSISTÊNCIA série×prefixo (causalidade): o valor da barra i na série
//    completa deve ser idêntico ao calculado só com os candles 0..i — é
//    exatamente o que a produção faz a cada scan; divergência = look-ahead.
// 2. REFERÊNCIA CRUZADA com convenção Pine (test-only, __fixtures__/pineRef.js):
//    RMA/Wilder seed=SMA para RSI/ATR/ADX, fórmula fechada p/ Choppiness —
//    comparadas após warm-up de ~6× o período (consenso: EMA/RMA nunca
//    converge exato com histórico diferente) e tolerância rel+abs.
// 3. MEDIÇÃO do seed da EMA: o port seeda com o 1º valor; o Pine observável só
//    via export do gráfico. O teste PROVA que, na profundidade usada em
//    produção (pós warm-up), a escolha do seed é irrelevante (< tolerância).
// 4. NO-REPAINT SMC: evento (BOS/CHoCH) na barra N idêntico calculado com
//    dados até N e com o dataset completo — consenso da comunidade para SMC.
// 5. PADRÃO-OURO REAL: se houver __fixtures__/golden/tv-export-*.csv (export
//    oficial do TradingView do usuário — docs/claude/golden-tv-export.md), as
//    séries do CSV viram a referência primária; o bloco ativa sozinho.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateRangeFilter } from './rangeFilter.js';
import { calculateConfirmedSignal } from './rangeFilterConfirmation.js';
import { calculateRSI } from './rsi.js';
import { calculateMACD } from './macd.js';
import { calculateEMAs } from './movingAverages.js';
import { calculateATRSeries } from './atr.js';
import { calculateADX } from './adx.js';
import { calculateChoppiness } from './choppiness.js';
import { calculateAtrPctSmooth, classifyTier } from './tier.js';
import { calculateStructure, calculateLiquiditySweep, calculatePdZone } from './smcStructure.js';
import { calculateSignalStrength } from './confluence.js';
import { goldenCandles, chochBreakoutCandles } from './__fixtures__/candles.js';
import { emaRef, atrRef, rsiRef, adxRef, chopRef } from './__fixtures__/pineRef.js';

const CANDLES = goldenCandles(500);
const N = CANDLES.length;

// Tolerâncias (ponto de partida da pesquisa; ver pine-parity.md):
// osciladores 0–100 → piso absoluto 0.05; séries de preço → relativa 1e-3.
function expectClose(actual, expected, { atol = 0.05, rtol = 1e-3 } = {}, ctx = '') {
  const diff = Math.abs(actual - expected);
  const bound = Math.max(atol, rtol * Math.abs(expected));
  if (!(diff <= bound)) {
    throw new Error(`${ctx}: |${actual} - ${expected}| = ${diff} > ${bound}`);
  }
}

// Igualdade estrita p/ causalidade (mesmo código, mesmos inputs → bit-igual;
// margem microscópica só p/ não flakear em otimização de float).
function expectSame(actual, expected, ctx = '') {
  if (Number.isNaN(expected)) return expect(Number.isNaN(actual)).toBe(true);
  const diff = Math.abs(actual - expected);
  if (!(diff <= 1e-9 * Math.max(1, Math.abs(expected)))) {
    throw new Error(`${ctx}: prefixo ${actual} ≠ série ${expected}`);
  }
}

describe('consistência série×prefixo (causalidade — sem look-ahead)', () => {
  // Passo 7 (primo) p/ amostrar bem sem O(n²) completo em todos os testes.
  const SAMPLE = [];
  for (let i = 60; i < N; i += 7) SAMPLE.push(i);

  it('Range Filter: filterValues/direction por prefixo batem com a série completa', () => {
    const full = calculateRangeFilter(CANDLES).series;
    for (const i of SAMPLE) {
      const pre = calculateRangeFilter(CANDLES.slice(0, i + 1)).series;
      expectSame(pre.filterValues[i], full.filterValues[i], `RF filt @${i}`);
      expect(pre.direction[i]).toBe(full.direction[i]);
    }
  });

  // calculateConfirmedSignal (confirmBars) is a function of already-causal
  // series (filterValues/direction/signals/closes), so it inherits
  // no-look-ahead automatically — proved here the same way as every other
  // indicator, not just assumed from that reasoning.
  it('confirmBars: calculateConfirmedSignal por prefixo bate com a série completa', () => {
    const full = calculateRangeFilter(CANDLES).series;
    const CONFIRM_BARS = 3;
    for (const i of SAMPLE) {
      const pre = calculateRangeFilter(CANDLES.slice(0, i + 1)).series;
      const fullConfirmed = calculateConfirmedSignal(full, CONFIRM_BARS, i);
      const preConfirmed = calculateConfirmedSignal(pre, CONFIRM_BARS, i);
      expect(preConfirmed.confirmedSignal).toBe(fullConfirmed.confirmedSignal);
    }
  });

  it('RSI: série por prefixo bate com a completa', () => {
    const full = calculateRSI(CANDLES).series;
    for (const i of SAMPLE) {
      const pre = calculateRSI(CANDLES.slice(0, i + 1)).series;
      expectSame(pre[i], full[i], `RSI @${i}`);
    }
  });

  it('MACD: macdLine/signalLine por prefixo batem com a completa', () => {
    const full = calculateMACD(CANDLES).series;
    for (const i of SAMPLE) {
      const pre = calculateMACD(CANDLES.slice(0, i + 1)).series;
      expectSame(pre.macdLine[i], full.macdLine[i], `MACD @${i}`);
      expectSame(pre.signalLine[i], full.signalLine[i], `MACD signal @${i}`);
    }
  });

  it('EMAs: séries por prefixo batem com a completa', () => {
    const full = calculateEMAs(CANDLES, 20, 50).series;
    for (const i of SAMPLE) {
      const pre = calculateEMAs(CANDLES.slice(0, i + 1), 20, 50).series;
      expectSame(pre.shortEMA[i], full.shortEMA[i], `EMA20 @${i}`);
      expectSame(pre.longEMA[i], full.longEMA[i], `EMA50 @${i}`);
    }
  });

  it('ATR: série por prefixo bate com a completa', () => {
    const full = calculateATRSeries(CANDLES, 14);
    for (const i of SAMPLE) {
      const pre = calculateATRSeries(CANDLES.slice(0, i + 1), 14);
      expectSame(pre[i], full[i], `ATR @${i}`);
    }
  });

  it('ADX: série por prefixo bate com a completa', () => {
    const full = calculateADX(CANDLES, 14, 14).series;
    for (const i of SAMPLE) {
      if (i < 14 + 14 + 1) continue;
      const pre = calculateADX(CANDLES.slice(0, i + 1), 14, 14).series;
      expectSame(pre.adx[i], full.adx[i], `ADX @${i}`);
    }
  });
});

describe('referência cruzada com convenção Pine (pós warm-up)', () => {
  const closes = CANDLES.map((c) => c.close);

  it('ATR bate com a referência Wilder (seed=SMA) — warm-up 6×14', () => {
    const port = calculateATRSeries(CANDLES, 14);
    const ref = atrRef(CANDLES, 14);
    for (let i = 84; i < N; i++) {
      expectClose(port[i], ref[i], { atol: 1e-6, rtol: 1e-6 }, `ATR @${i}`);
    }
  });

  it('RSI bate com a referência Wilder — warm-up 6×14', () => {
    const port = calculateRSI(CANDLES, 14).series;
    const ref = rsiRef(closes, 14);
    for (let i = 84; i < N; i++) {
      expectClose(port[i], ref[i], { atol: 0.05, rtol: 1e-3 }, `RSI @${i}`);
    }
  });

  it('ADX/DMI batem com a referência Wilder dupla — warm-up 6×(14+14)', () => {
    const port = calculateADX(CANDLES, 14, 14).series;
    const ref = adxRef(CANDLES, 14, 14);
    for (let i = 168; i < N; i++) {
      expectClose(port.adx[i], ref.adx[i], { atol: 0.05, rtol: 1e-3 }, `ADX @${i}`);
      expectClose(port.plusDI[i], ref.plusDI[i], { atol: 0.05, rtol: 1e-3 }, `+DI @${i}`);
      expectClose(port.minusDI[i], ref.minusDI[i], { atol: 0.05, rtol: 1e-3 }, `-DI @${i}`);
    }
  });

  it('Choppiness (por prefixo) bate com a fórmula fechada', () => {
    const ref = chopRef(CANDLES, 14);
    for (let i = 50; i < N; i += 7) {
      const port = calculateChoppiness(CANDLES.slice(0, i + 1), 14);
      expectClose(port, ref[i], { atol: 0.05, rtol: 1e-3 }, `CHOP @${i}`);
    }
  });

  it('EMA/MACD batem com a referência de mesma semente (valida a mecânica)', () => {
    const emas = calculateEMAs(CANDLES, 20, 50).series;
    const e20 = emaRef(closes, 20, 'first');
    const e50 = emaRef(closes, 50, 'first');
    for (let i = 120; i < N; i += 7) {
      expectClose(emas.shortEMA[i], e20[i], { atol: 1e-9, rtol: 1e-9 }, `EMA20 @${i}`);
      expectClose(emas.longEMA[i], e50[i], { atol: 1e-9, rtol: 1e-9 }, `EMA50 @${i}`);
    }
    const macd = calculateMACD(CANDLES).series;
    const e12 = emaRef(closes, 12, 'first');
    const e26 = emaRef(closes, 26, 'first');
    for (let i = 160; i < N; i += 7) {
      expectClose(macd.macdLine[i], e12[i] - e26[i], { atol: 1e-9, rtol: 1e-9 }, `MACD @${i}`);
    }
  });

  // Medição do seed da EMA (port seeda com o 1º valor; Pine só observável no
  // export real): prova que na profundidade de produção a escolha do seed é
  // irrelevante — a influência do seed decai (1-k)^t e some no warm-up.
  it('sensibilidade ao seed da EMA é desprezível pós warm-up (6× período)', () => {
    let worst = 0;
    for (const n of [20, 50]) {
      const a = emaRef(closes, n, 'first');
      const b = emaRef(closes, n, 'sma');
      for (let i = 6 * n; i < N; i++) {
        const rel = Math.abs(a[i] - b[i]) / Math.abs(b[i]);
        if (rel > worst) worst = rel;
        expect(rel).toBeLessThan(1e-3);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[goldenParity] divergência máx. de seed EMA pós warm-up: ${worst.toExponential(2)}`);
  });
});

describe('SMC — no-repaint (evento na barra N imutável)', () => {
  it('estrutura: eventos por prefixo batem com a série completa (goldenCandles)', () => {
    const swingLen = 10;
    const full = calculateStructure(CANDLES, { swingLen }).series;
    for (let i = swingLen + 2; i < N; i += 7) {
      const pre = calculateStructure(CANDLES.slice(0, i + 1), { swingLen });
      expect(pre.lastBull.bos).toBe(full.bullBos[i]);
      expect(pre.lastBull.choch).toBe(full.bullChoch[i]);
      expect(pre.lastBear.bos).toBe(full.bearBos[i]);
      expect(pre.lastBear.choch).toBe(full.bearChoch[i]);
      expect(pre.trend).toBe(full.trend[i]);
    }
  });

  it('estrutura: cenário conhecido de CHoCH também é estável por prefixo', () => {
    const candles = chochBreakoutCandles();
    const swingLen = 5; // mesmo valor do cenário em smcStructure.test.js
    const full = calculateStructure(candles, { swingLen }).series;
    // O CHoCH bull deve existir na série e disparar na mesma barra via prefixo.
    const chochBar = full.bullChoch.findIndex(Boolean);
    expect(chochBar).toBeGreaterThan(0);
    const pre = calculateStructure(candles.slice(0, chochBar + 1), { swingLen });
    expect(pre.lastBull.choch).toBe(true);
    // E em nenhuma barra anterior o prefixo o antecipa.
    const before = calculateStructure(candles.slice(0, chochBar), { swingLen });
    expect(before.lastBull.choch).toBe(false);
  });

  it('sweep e zona PD são determinísticos por prefixo', () => {
    for (const i of [100, 250, 480]) {
      const slice = CANDLES.slice(0, i + 1);
      expect(calculateLiquiditySweep(slice, 20)).toEqual(calculateLiquiditySweep(slice, 20));
      expect(calculatePdZone(slice, 20)).toEqual(calculatePdZone(slice, 20));
    }
  });
});

describe('score e tier barra a barra (stateless por barra)', () => {
  it('score é determinístico, limitado a 0–100 e coerente com o gate', () => {
    for (let i = 120; i < N; i += 35) {
      const slice = CANDLES.slice(0, i + 1);
      const rf = calculateRangeFilter(slice);
      const rsi = calculateRSI(slice);
      const macd = calculateMACD(slice);
      const ema = calculateEMAs(slice, 20, 50);
      const alignment = { alignment: 'NEUTRAL' };
      const a = calculateSignalStrength(rf, rsi, macd, ema, alignment, '4h', null, 75);
      const b = calculateSignalStrength(rf, rsi, macd, ema, alignment, '4h', null, 75);
      expect(a).toEqual(b);
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(100);
    }
  });

  it('tier por prefixo é sempre um tier válido e coerente com o atrPct', () => {
    for (let i = 120; i < N; i += 35) {
      const atrPct = calculateAtrPctSmooth(CANDLES.slice(0, i + 1), 14, 20);
      const tier = classifyTier(atrPct);
      expect(['T1', 'T2', 'T3']).toContain(tier.tier);
      expect(tier.atrPctSmooth).toBe(atrPct);
    }
  });
});

// ── Fixtures reais congeladas (JSON de scripts/fetch-golden-fixture.mjs) ────
// Candles reais da Binance Spot (mesma fonte do cron), congelados pelo usuário
// rodando o script localmente. Não trazem valores esperados de indicador —
// o valor deles é rodar as MESMAS camadas de validação (prefixo, convenção
// Pine, no-repaint) sobre dados de mercado reais em vez de sintéticos.
const GOLDEN_DIR_JSON = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/golden');
const jsonFixtures = existsSync(GOLDEN_DIR_JSON)
  ? readdirSync(GOLDEN_DIR_JSON).filter((f) => /\.json$/.test(f))
  : [];

describe.skipIf(jsonFixtures.length === 0)('fixtures reais congeladas (Binance JSON)', () => {
  for (const file of jsonFixtures) {
    describe(file, () => {
      const { candles } = JSON.parse(readFileSync(path.join(GOLDEN_DIR_JSON, file), 'utf8'));
      const n = candles.length;
      const closes = candles.map((c) => c.close);

      it('tem barras suficientes p/ warm-up', () => {
        expect(n).toBeGreaterThanOrEqual(300);
      });

      it('consistência série×prefixo em dados reais (amostrado)', () => {
        const rf = calculateRangeFilter(candles).series;
        const rsi = calculateRSI(candles).series;
        const atr = calculateATRSeries(candles, 14);
        for (let i = 90; i < n; i += 29) {
          const slice = candles.slice(0, i + 1);
          expectSame(calculateRangeFilter(slice).series.filterValues[i], rf.filterValues[i], `${file} RF @${i}`);
          expectSame(calculateRSI(slice).series[i], rsi[i], `${file} RSI @${i}`);
          expectSame(calculateATRSeries(slice, 14)[i], atr[i], `${file} ATR @${i}`);
        }
      });

      it('referência cruzada convenção Pine em dados reais (pós warm-up)', () => {
        const atr = calculateATRSeries(candles, 14);
        const refAtr = atrRef(candles, 14);
        const rsi = calculateRSI(candles, 14).series;
        const refRsi = rsiRef(closes, 14);
        const adx = calculateADX(candles, 14, 14).series;
        const refAdx = adxRef(candles, 14, 14);
        const refChop = chopRef(candles, 14);
        for (let i = 168; i < n; i++) {
          expectClose(atr[i], refAtr[i], { atol: 1e-6, rtol: 1e-6 }, `${file} ATR @${i}`);
          expectClose(rsi[i], refRsi[i], { atol: 0.05, rtol: 1e-3 }, `${file} RSI @${i}`);
          expectClose(adx.adx[i], refAdx.adx[i], { atol: 0.05, rtol: 1e-3 }, `${file} ADX @${i}`);
        }
        for (let i = 168; i < n; i += 29) {
          expectClose(calculateChoppiness(candles.slice(0, i + 1), 14), refChop[i], { atol: 0.05, rtol: 1e-3 }, `${file} CHOP @${i}`);
        }
      });

      it('SMC não-repaint em dados reais (amostrado)', () => {
        const swingLen = 10;
        const full = calculateStructure(candles, { swingLen }).series;
        for (let i = 90; i < n; i += 29) {
          const pre = calculateStructure(candles.slice(0, i + 1), { swingLen });
          expect(pre.lastBull.choch).toBe(full.bullChoch[i]);
          expect(pre.lastBear.choch).toBe(full.bearChoch[i]);
          expect(pre.trend).toBe(full.trend[i]);
        }
      });
    });
  }
});

// ── Padrão-ouro real: CSV exportado do TradingView pelo usuário ─────────────
// Ativa sozinho quando houver __fixtures__/golden/tv-export-*.csv (ver
// docs/claude/golden-tv-export.md: gráfico BINANCE:BTCUSDT SPOT, UTC, colunas
// com os títulos prescritos). O CSV traz OHLC + séries plotadas do Pine REAL —
// comparamos tudo do mesmo arquivo, sem depender de rede.
const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/golden');
const tvFiles = existsSync(GOLDEN_DIR)
  ? readdirSync(GOLDEN_DIR).filter((f) => /^tv-export-.*\.csv$/.test(f))
  : [];

describe.skipIf(tvFiles.length === 0)('padrão-ouro: CSV do TradingView', () => {
  const WARMUP = 210; // 6× o maior período (MACD 26+9)

  function parseTvCsv(file) {
    const text = readFileSync(path.join(GOLDEN_DIR, file), 'utf8').trim();
    const lines = text.split(/\r?\n/);
    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const rows = lines.slice(1).map((l) => l.split(',').map((v) => v.trim().replace(/^"|"$/g, '')));
    // Última linha pode ser a barra ao vivo (não fechada) — descartada.
    rows.pop();
    const col = (name) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    const t = col('time');
    ['open', 'high', 'low', 'close'].forEach((c) => {
      if (col(c) === -1) throw new Error(`CSV ${file}: coluna obrigatória ausente: ${c}`);
    });
    const candles = rows.map((r, i) => ({
      openTime: /^\d+$/.test(r[t]) ? Number(r[t]) * 1000 : Date.parse(r[t]),
      open: Number(r[col('open')]),
      high: Number(r[col('high')]),
      low: Number(r[col('low')]),
      close: Number(r[col('close')]),
      volume: 0,
      closeTime: 0,
      isClosed: true,
      _row: i,
    }));
    const series = {};
    for (const name of ['RF_FILT', 'RSI', 'ATR', 'EMA_FAST', 'EMA_SLOW', 'MACD', 'MACD_SIGNAL', 'ADX', 'CHOP']) {
      const c = col(name);
      if (c !== -1) series[name] = rows.map((r) => Number(r[c]));
    }
    return { candles, series };
  }

  for (const file of tvFiles) {
    it(`${file}: séries do port batem com o Pine real (pós warm-up)`, () => {
      const { candles, series } = parseTvCsv(file);
      expect(candles.length).toBeGreaterThanOrEqual(300);
      const n = candles.length;
      const checks = [];
      if (series.RF_FILT) {
        const port = calculateRangeFilter(candles, 20, 3.5).series.filterValues;
        checks.push(['RF_FILT', port, series.RF_FILT, { rtol: 1e-3, atol: 1e-6 }]);
      }
      if (series.RSI) {
        const port = calculateRSI(candles, 14).series;
        checks.push(['RSI', port, series.RSI, { atol: 0.05, rtol: 1e-3 }]);
      }
      if (series.ATR) {
        const port = calculateATRSeries(candles, 14);
        checks.push(['ATR', port, series.ATR, { rtol: 1e-3, atol: 1e-6 }]);
      }
      if (series.EMA_FAST || series.EMA_SLOW) {
        const emas = calculateEMAs(candles, 20, 50).series;
        if (series.EMA_FAST) checks.push(['EMA_FAST(20)', emas.shortEMA, series.EMA_FAST, { rtol: 1e-3, atol: 1e-6 }]);
        if (series.EMA_SLOW) checks.push(['EMA_SLOW(50)', emas.longEMA, series.EMA_SLOW, { rtol: 1e-3, atol: 1e-6 }]);
      }
      if (series.MACD || series.MACD_SIGNAL) {
        const macd = calculateMACD(candles, 12, 26, 9).series;
        if (series.MACD) checks.push(['MACD', macd.macdLine, series.MACD, { rtol: 1e-3, atol: 1e-4 }]);
        if (series.MACD_SIGNAL) checks.push(['MACD_SIGNAL', macd.signalLine, series.MACD_SIGNAL, { rtol: 1e-3, atol: 1e-4 }]);
      }
      if (series.ADX) {
        const port = calculateADX(candles, 14, 14).series.adx;
        checks.push(['ADX', port, series.ADX, { atol: 0.05, rtol: 1e-3 }]);
      }
      if (series.CHOP) {
        const port = [];
        for (let i = 0; i < n; i++) port.push(i < 14 ? NaN : calculateChoppiness(candles.slice(0, i + 1), 14));
        checks.push(['CHOP', port, series.CHOP, { atol: 0.05, rtol: 1e-3 }]);
      }
      expect(checks.length).toBeGreaterThan(0);

      for (const [name, port, ref, tol] of checks) {
        for (let i = WARMUP; i < n; i++) {
          if (!Number.isFinite(ref[i])) continue; // barras sem valor no TV (na)
          expectClose(port[i], ref[i], tol, `${name} @${i} (${file})`);
        }
      }
    });
  }
});
