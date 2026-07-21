/**
 * Port fiel (para candles fechados) da engine de estrutura SMC/ICT do Pine
 * Script real do usuário ("SMC+A Unified v2.3"): detect_swings, detect_pivot
 * e detect_structure (BOS/CHoCH), mais liquidity sweep e zonas
 * Premium/Discount/Equilibrium — as únicas partes desse indicador que não
 * dependem de desenho de gráfico nem do track_obs (Order Blocks/FVG, fora de
 * escopo por ora).
 *
 * O fix anti-repaint v2.3 do Pine ("trend só muda em barstate.isconfirmed")
 * não precisa ser replicado aqui: como o scanner só processa candles já
 * fechados, toda barra processada equivale a um barstate.isconfirmed=true.
 */
import { calculateATRSeries } from './atr';

function highestInWindow(arr, endIdx, length) {
  let max = -Infinity;
  const start = Math.max(0, endIdx - length + 1);
  for (let k = start; k <= endIdx; k++) {
    if (arr[k] > max) max = arr[k];
  }
  return max;
}

function lowestInWindow(arr, endIdx, length) {
  let min = Infinity;
  const start = Math.max(0, endIdx - length + 1);
  for (let k = start; k <= endIdx; k++) {
    if (arr[k] < min) min = arr[k];
  }
  return min;
}

/**
 * Port de detect_swings(length): swing high/low via breakout de uma janela
 * `length`-barras, com o estado `os` (offset side) persistido barra-a-barra.
 */
function detectSwings(highs, lows, length) {
  const n = highs.length;
  const hh = new Array(n).fill(null);
  const ll = new Array(n).fill(null);
  let os = 0;

  for (let i = length; i < n; i++) {
    const hSw = highs[i - length];
    const lSw = lows[i - length];
    const upper = highestInWindow(highs, i, length);
    const lower = lowestInWindow(lows, i, length);
    const prevOs = os;
    os = hSw > upper ? 0 : lSw < lower ? 1 : prevOs;
    if (os === 0 && prevOs !== 0) hh[i] = hSw;
    if (os === 1 && prevOs !== 1) ll[i] = lSw;
  }
  return { hh, ll };
}

/**
 * Port de detect_structure(swing_len, filter_insignificant_internal_breaks):
 * roda os dois detect_pivot (topo e fundo) e atualiza o trend quando um
 * CHoCH é confirmado. Espera candles JÁ FECHADOS, em ordem cronológica.
 *
 * Defaults iguais ao Pine real: swing_len=50 (swing_length no script),
 * filter_insignificant_internal_breaks=true (linha 1140 do script).
 */
export function calculateStructure(candles, { swingLen = 50, filterInsignificantInternalBreaks = true } = {}) {
  const n = candles.length;
  if (n < swingLen + 2) {
    return { trend: null, lastBull: { bos: false, choch: false }, lastBear: { bos: false, choch: false }, series: null };
  }

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const atr3 = calculateATRSeries(candles, 3);
  const { hh, ll } = detectSwings(highs, lows, swingLen);

  // detect_pivot depende do trend vigente ANTES da barra ser processada, e o
  // trend só é conhecido depois de rodar os dois pivots daquela mesma barra
  // — por isso simulamos barra-a-barra em vez de vetorizar tudo de uma vez
  // (mesma ordem de avaliação do Pine original). Não rastreamos x/trail_y
  // (usados só para desenhar linhas no Pine) — só o nível y importa para
  // decidir BOS/CHoCH.
  const bullBos = new Array(n).fill(false);
  const bullChoch = new Array(n).fill(false);
  const bearBos = new Array(n).fill(false);
  const bearChoch = new Array(n).fill(false);

  let topY = 0, topLvlCross = true;
  let btmY = 0, btmLvlCross = true;
  let trend = 1;
  const trendSeries = new Array(n).fill(1);

  for (let i = 0; i < n; i++) {
    const high = candles[i].high, low = candles[i].low, close = candles[i].close, open = candles[i].open;

    // ── topo (mode = 1) ──
    const topYPrev = topY;
    if (hh[i] != null) {
      topLvlCross = true;
      topY = hh[i];
    }

    let curBullBos = false, curBullChoch = false;
    if (i > 0) {
      const prevClose = candles[i - 1].close;
      const sd = prevClose <= topYPrev && close > topY;
      if (sd && topLvlCross && topY !== 0) {
        topLvlCross = false;
        let trendConcordant = true;
        if (filterInsignificantInternalBreaks) {
          const atrPiv = atr3[i] || 0;
          const body = Math.abs(open - close);
          const dtl = Math.abs(open - topY);
          const bigC = body > 2 * dtl || body > atrPiv;
          const tw = high - Math.max(close, open);
          const bw = Math.min(close, open) - low;
          trendConcordant = bigC || (tw > bw);
        }
        if (trendConcordant) {
          const t = (trend !== 1 && trend !== -1) ? 1 : trend;
          curBullChoch = 1 === t * -1;
          curBullBos = 1 === t;
        }
      }
    }
    bullBos[i] = curBullBos;
    bullChoch[i] = curBullChoch;

    // ── fundo (mode = -1) ──
    const btmYPrev = btmY;
    if (ll[i] != null) {
      btmLvlCross = true;
      btmY = ll[i];
    }

    let curBearBos = false, curBearChoch = false;
    if (i > 0) {
      const prevClose = candles[i - 1].close;
      const sd = prevClose >= btmYPrev && close < btmY;
      if (sd && btmLvlCross && btmY !== 0) {
        btmLvlCross = false;
        let trendConcordant = true;
        if (filterInsignificantInternalBreaks) {
          const atrPiv = atr3[i] || 0;
          const body = Math.abs(open - close);
          const dtl = Math.abs(open - btmY);
          const bigC = body > 2 * dtl || body > atrPiv;
          const tw = high - Math.max(close, open);
          const bw = Math.min(close, open) - low;
          trendConcordant = bigC || (tw < bw);
        }
        if (trendConcordant) {
          const t = (trend !== 1 && trend !== -1) ? 1 : trend;
          curBearChoch = -1 === t * -1;
          curBearBos = -1 === t;
        }
      }
    }
    bearBos[i] = curBearBos;
    bearChoch[i] = curBearChoch;

    // trend só muda após ambos os pivots desta barra rodarem (mesma ordem
    // do Pine original: os dois detect_pivot primeiro, depois o if de trend)
    trend = curBullChoch ? 1 : curBearChoch ? -1 : trend;
    trendSeries[i] = trend;
  }

  const last = n - 1;
  return {
    trend,
    lastBull: { bos: bullBos[last], choch: bullChoch[last] },
    lastBear: { bos: bearBos[last], choch: bearChoch[last] },
    // Carried confirmed pivot levels (additive) — the protected swing the
    // structure logic itself breaks against (topY/btmY, confirmed with
    // swingLen lag and carried across later bars). Consumed by the SMC
    // structural stop: the true invalidation of a bull structure entry is
    // the protected LOW (lastSwingLow), which can be much older than any
    // fixed recent-candle window. 0 means "never set" → null.
    lastSwingHigh: topY !== 0 ? topY : null,
    lastSwingLow: btmY !== 0 ? btmY : null,
    // Per-bar event/trend series (additive) — used by the golden parity tests
    // for the no-repaint check; last-bar consumers above are unchanged.
    series: { bullBos, bullChoch, bearBos, bearChoch, trend: trendSeries },
  };
}

/**
 * Port de bullish_sweep/bearish_sweep (liquidity sweep — SSL/BSL), avaliado
 * só na última barra fechada.
 */
export function calculateLiquiditySweep(candles, sweepLookback = 20) {
  const n = candles.length;
  if (n < sweepLookback + 2) return { bullishSweep: false, bearishSweep: false };

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const last = n - 1;
  const { open, close, high, low } = candles[last];

  const swHigh = highestInWindow(highs, last - 1, sweepLookback);
  const swLow = lowestInWindow(lows, last - 1, sweepLookback);

  const bullishSweep = low < swLow && close > swLow && close > open;
  const bearishSweep = high > swHigh && close < swHigh && close < open;

  return { bullishSweep, bearishSweep };
}

/**
 * Classifica `close` como premium/discount/equilibrium dentro do range
 * [low, high] — banda de equilíbrio de 5% do range ao redor do meio. Função
 * pura, sem noção de candle/janela: quem decide QUAL range usar (20 velas
 * genéricas em calculatePdZone, ou a perna de um rompimento de estrutura em
 * check5mSmcConfirmation, ver docs/known-risks.md item 38) é o chamador.
 * `high`/`low` nulos ou invertidos (high < low) → não avaliável (`zone:
 * null`), para que o chamador trate como fail-open em vez de classificar
 * errado.
 */
export function classifyZone(close, high, low) {
  if (high == null || low == null || high < low) {
    return { zone: null, eqTop: null, eqBtm: null };
  }
  const mid = (high + low) / 2;
  const range = high - low;
  const eqBand = range * 0.05;
  const eqTop = mid + eqBand;
  const eqBtm = mid - eqBand;

  let zone;
  if (close > eqTop) zone = 'premium';
  else if (close < eqBtm) zone = 'discount';
  else zone = 'equilibrium';

  return { zone, eqTop, eqBtm };
}

/**
 * Port das zonas Premium/Discount/Equilibrium, avaliadas só na última barra
 * fechada. Wrapper fino sobre `classifyZone` — a janela de 20 velas
 * (excluindo o candle atual) é a única coisa específica desta função.
 */
export function calculatePdZone(candles, pdSwingLen = 20) {
  const n = candles.length;
  if (n < pdSwingLen + 2) return { zone: null, pdSwingHigh: null, pdSwingLow: null };

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const last = n - 1;
  const close = candles[last].close;

  const pdSwingHigh = highestInWindow(highs, last - 1, pdSwingLen);
  const pdSwingLow = lowestInWindow(lows, last - 1, pdSwingLen);
  const { zone, eqTop, eqBtm } = classifyZone(close, pdSwingHigh, pdSwingLow);

  return { zone, pdSwingHigh, pdSwingLow, eqTop, eqBtm };
}

/**
 * Ancora a perna (leg) do impulso que um rompimento de estrutura 1h acabou
 * de confirmar — usada pelo gatilho de entrada 5m (`check5mSmcConfirmation`
 * em `scanner.js`) para julgar se uma entrada, mais tarde, está num recuo
 * favorável dessa perna, em vez de remedir uma janela genérica desconectada
 * do evento (`docs/known-risks.md` item 38 — substitui o gate de zona
 * autocontraditório no candle de viés 1h, item 35).
 *
 * BUY (rompimento de alta): `legLow` = o fundo protegido de onde o impulso
 * partiu (`lastSwingLow`); `legHigh` = o close que acabou de confirmar o
 * rompimento (o topo já alcançado). SELL é o espelho.
 *
 * Fixada UMA VEZ, no instante do sinal 1h (quem chama decide isso —
 * chamar de novo mais tarde recalcularia com um `lastSwingLow`/`lastSwingHigh`
 * potencialmente diferente, fazendo a perna "derivar" enquanto o candidato
 * aguarda confirmação 5m).
 *
 * Retorna null no lado ainda sem pivô protegido confirmado (`lastSwingHigh`/
 * `lastSwingLow` ausente) — chamador deve tratar como não avaliável
 * (fail-open via `classifyZone`), nunca como veredito desfavorável.
 */
export function buildOteLeg(signalType, breakClose, { lastSwingHigh, lastSwingLow } = {}) {
  if (signalType === 'BUY') {
    return { legHigh: breakClose, legLow: lastSwingLow ?? null };
  }
  return { legHigh: lastSwingHigh ?? null, legLow: breakClose };
}
