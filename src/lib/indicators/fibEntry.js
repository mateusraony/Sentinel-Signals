// Entrada e saída por Fibonacci no 15m — docs/known-risks.md item 267.
// BACKTEST-ONLY: só é usado quando `pineConfig.fibEntryEnabled === true`
// (chave que existe apenas em scripts/backtestPineConfig.js, travada por
// src/lib/fibEntryTripwire.test.js) e por operações nascidas nesse modo
// (`exit_mode === 'FIB_FIXED'`). Original a este projeto, sem paridade Pine.
//
// Funções puras: sem I/O, sem Date.now(). Toda referência de tempo vem do
// chamador (`nowMs`), e velas com closeTime > nowMs são descartadas aqui
// dentro — a mesma saída com a série inteira ou cortada em nowMs (causal).
//
// Regras PRÉ-REGISTRADAS (item 267). Mudar qualquer constante depois de ver
// resultado invalida o teste — o teste fibEntry.test.js trava os valores.

export const FIB_RULES = Object.freeze({
  barMs: 15 * 60 * 1000,
  anchorBars: 32, // perna medida nas 32 velas de 15m até o fechamento do sinal de 4h
  atrBars: 14, // média simples do true range, fatia fixa terminando no sinal
  minLegAtr: 1.0, // perna precisa ter ≥ 1×ATR
  entryRetrace: 0.618,
  fillPenetrationAtr: 0.02, // a mínima precisa passar E por 0,02×ATR (toque não basta)
  stopBufferAtr: 0.1,
  tp1Ext: 1.272,
  tp2Ext: 1.618,
  maxWaitBars: 15, // dentro da janela de retry de 4h do sinal RF
});

export const closedAsOf = (candles, nowMs) => (Array.isArray(candles) ? candles : [])
  .filter((c) => c && c.isClosed !== false && Number.isFinite(c.closeTime) && c.closeTime <= nowMs)
  .sort((a, b) => a.openTime - b.openTime);

/**
 * Plano de entrada por Fibonacci para um sinal de 4h.
 * @param {{ candles15m: object[], direction: 'BUY'|'SELL', signalCloseMs: number, nowMs: number }} p
 * @returns {Record<string, any> & { status: string }} status + níveis (entry, stop, tp1, tp2, atr, leg,
 *   fillCandleOpenMs, fillCandleCloseMs, barsWaited, reason quando aplicável)
 */
export function planFibEntry({ candles15m, direction, signalCloseMs, nowMs }) {
  const R = FIB_RULES;
  if (direction !== 'BUY' && direction !== 'SELL') return { status: 'insufficient_data', reason: 'invalid_direction' };
  if (!Number.isFinite(signalCloseMs) || !Number.isFinite(nowMs)) return { status: 'insufficient_data', reason: 'invalid_time' };
  const closed = closedAsOf(candles15m, nowMs);
  const pre = closed.filter((c) => c.closeTime <= signalCloseMs);
  // A última vela antes do sinal precisa fechar EXATAMENTE no fechamento do
  // sinal; senão falta dado e a perna seria medida no lugar errado.
  if (pre.length < R.anchorBars + 1 || pre[pre.length - 1].closeTime !== signalCloseMs) {
    return { status: 'insufficient_data', reason: 'short_or_misaligned_history' };
  }
  const window = pre.slice(-R.anchorBars);
  const atrSlice = pre.slice(-(R.atrBars + 1));
  let trSum = 0;
  for (let i = 1; i < atrSlice.length; i += 1) {
    const c = atrSlice[i];
    const prevClose = atrSlice[i - 1].close;
    trSum += Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }
  const atr = trSum / R.atrBars;
  if (!(atr > 0)) return { status: 'insufficient_data', reason: 'zero_atr' };

  const isBuy = direction === 'BUY';
  // Compra: L = primeira mínima mais baixa; H = máxima mais alta ESTRITAMENTE
  // depois de L. Venda: espelho (H primeiro, L depois).
  let originIdx = 0;
  for (let i = 1; i < window.length; i += 1) {
    if (isBuy ? window[i].low < window[originIdx].low : window[i].high > window[originIdx].high) originIdx = i;
  }
  if (originIdx >= window.length - 1) return { status: 'no_leg', reason: 'no_candle_after_origin', atr };
  let extremeIdx = originIdx + 1;
  for (let i = originIdx + 2; i < window.length; i += 1) {
    if (isBuy ? window[i].high > window[extremeIdx].high : window[i].low < window[extremeIdx].low) extremeIdx = i;
  }
  const origin = isBuy ? window[originIdx].low : window[originIdx].high;
  const extreme = isBuy ? window[extremeIdx].high : window[extremeIdx].low;
  const delta = Math.abs(extreme - origin);
  const leg = {
    origin, extreme, delta,
    originOpenMs: window[originIdx].openTime,
    extremeOpenMs: window[extremeIdx].openTime,
  };
  if (delta < R.minLegAtr * atr) return { status: 'no_leg', reason: 'leg_below_min_atr', atr, leg };

  const sign = isBuy ? 1 : -1;
  const entry = extreme - sign * R.entryRetrace * delta;
  const stop = origin - sign * R.stopBufferAtr * atr;
  const tp1 = origin + sign * R.tp1Ext * delta;
  const tp2 = origin + sign * R.tp2Ext * delta;
  const fillLevel = entry - sign * R.fillPenetrationAtr * atr;
  const levels = { entry, stop, tp1, tp2, atr, leg };

  // O nível já foi negociado entre o extremo e o sinal → não é um recuo novo.
  for (let i = extremeIdx + 1; i < window.length; i += 1) {
    if (isBuy ? window[i].low <= entry : window[i].high >= entry) return { status: 'already_retraced', ...levels };
  }

  const post = closed.filter((c) => c.closeTime > signalCloseMs);
  for (let k = 0; k < post.length && k < R.maxWaitBars; k += 1) {
    const c = post[k];
    // Mesma vela atinge o TP1 e o preenchimento: a ordem dentro da vela é
    // desconhecida — conta como "fugiu" (sem operação), nunca como vencedora.
    if (isBuy ? c.high >= tp1 : c.low <= tp1) return { status: 'ran_away', ...levels, barsWaited: k + 1 };
    const filled = isBuy ? c.low <= fillLevel : c.high >= fillLevel;
    if (filled) {
      // Só entra se a vela do preenchimento for a ÚLTIMA fechada agora —
      // nunca abrir uma operação datada no passado (passada perdida).
      if (k !== post.length - 1) return { status: 'fill_missed', ...levels, barsWaited: k + 1 };
      // Abertura já além do stop: a vela atravessou a zona inteira e o stop
      // num salto. Sem operação (review do Codex, PR #486): preencher na
      // abertura criaria um stop do lado errado da entrada.
      if (isBuy ? c.open <= stop : c.open >= stop) return { status: 'gap_through_stop', ...levels, barsWaited: k + 1 };
      // Preço sempre E, mesmo quando a vela abre entre E e o stop (o real
      // seria a abertura, melhor): conservador, e mantém a geometria de risco
      // pré-registrada — preencher na abertura encolheria o risco e inflaria o
      // R dos alvos.
      return {
        status: 'filled', ...levels, entry, plannedEntry: entry,
        fillCandleOpenMs: c.openTime, fillCandleCloseMs: c.closeTime, barsWaited: k + 1,
      };
    }
  }
  if (post.length >= R.maxWaitBars) return { status: 'expired', ...levels, barsWaited: R.maxWaitBars };
  return { status: 'pending', ...levels, barsWaited: post.length };
}

/**
 * Avança a gestão de uma operação FIB_FIXED pelas velas de 15m fechadas
 * desde o último marcador. Regras (item 267):
 * - stop vence quando stop e alvo tocam na mesma vela (`exit_ambiguous`);
 * - a vela do preenchimento só checa o stop;
 * - abertura além do stop sai pela abertura (gap);
 * - TP1 fecha 50% e move o stop para a entrada a partir da vela SEGUINTE;
 *   TP2 também só conta a partir da vela seguinte ao TP1;
 * - time stop (tier) só antes do TP1, no fechamento da 1ª vela que alcança o prazo;
 * - sem trailing, sem saída por RF, sem chop, sem invalidação.
 * @param {Record<string, any>} op
 * @param {object[]} candles15m
 * @param {{ nowMs: number, timeStopBarMs?: number }} opts
 * @returns {Record<string, any> & { gap: boolean, patch: Record<string, any>|null, status: string, processed: number }}
 */
export function stepFibExit(op, candles15m, { nowMs, timeStopBarMs = 4 * 60 * 60 * 1000 }) {
  const R = FIB_RULES;
  const isBuy = op.side === 'BUY';
  const fillOpen = op.fib_fill_candle_open_ms;
  const marker = op.fib_last_exit_candle_open_ms ?? null;
  const candles = closedAsOf(candles15m, nowMs)
    .filter((c) => c.openTime >= fillOpen && (marker == null || c.openTime > marker));
  if (!candles.length) return { gap: false, patch: null, status: op.status, processed: 0 };

  // Velas precisam ser contíguas a partir do marcador (ou do preenchimento).
  let expected = marker == null ? fillOpen : marker + R.barMs;
  for (const c of candles) {
    if (c.openTime !== expected) return { gap: true, patch: null, status: op.status, processed: 0, expectedOpenMs: expected, gotOpenMs: c.openTime };
    expected += R.barMs;
  }

  let status = op.status;
  let currentStop = op.current_stop;
  let tp1Hit = op.tp1_hit === true;
  let tp1CandleOpen = op.fib_tp1_candle_open_ms ?? null;
  const patch = {};
  let lastOpen = marker;
  const entryRefMs = op.fib_fill_candle_close_ms ?? (fillOpen + R.barMs - 1);
  const deadlineMs = entryRefMs + (op.tier_time_stop_bars ?? 48) * timeStopBarMs;
  const iso = (ms) => new Date(ms).toISOString();

  for (const c of candles) {
    lastOpen = c.openTime;
    const stopTouched = isBuy ? c.low <= currentStop : c.high >= currentStop;
    const gapExit = isBuy ? c.open <= currentStop : c.open >= currentStop;
    const stopExitPrice = gapExit ? c.open : currentStop;
    if (!tp1Hit) {
      if (c.openTime === fillOpen) {
        // Vela do preenchimento: a ordem entre preenchimento e alvo é
        // desconhecida — só o stop conta (pessimista). Sem gap: a abertura
        // é anterior ao preenchimento.
        if (stopTouched) {
          status = 'STOP_HIT';
          Object.assign(patch, { stop_hit_price: currentStop, exit_price: currentStop, stop_hit_real_time: iso(c.closeTime), closed_at_real_time: iso(c.closeTime) });
          break;
        }
        continue;
      }
      const tp1Touched = isBuy ? c.high >= op.tp1 : c.low <= op.tp1;
      if (stopTouched) {
        status = 'STOP_HIT';
        Object.assign(patch, { stop_hit_price: currentStop, exit_price: stopExitPrice, stop_hit_real_time: iso(c.closeTime), closed_at_real_time: iso(c.closeTime) });
        if (gapExit) patch.fib_gap_exit = true;
        if (tp1Touched) patch.exit_ambiguous = true;
        break;
      }
      if (tp1Touched) {
        tp1Hit = true;
        tp1CandleOpen = c.openTime;
        status = 'RUNNER_ACTIVE';
        currentStop = op.entry_price;
        Object.assign(patch, { tp1_hit_price: op.tp1, tp1_hit_real_time: iso(c.closeTime), fib_tp1_candle_open_ms: c.openTime });
        continue;
      }
      if (c.closeTime >= deadlineMs) {
        status = 'CLOSED';
        Object.assign(patch, { closed_reason: 'TIME_STOP', exit_price: c.close, closed_at_real_time: iso(c.closeTime) });
        break;
      }
      continue;
    }
    // Runner: a vela do TP1 não é reavaliada (breakeven e TP2 valem da seguinte).
    if (c.openTime === tp1CandleOpen) continue;
    const tp2Touched = !op.tp2_cap_disabled && (isBuy ? c.high >= op.tp2 : c.low <= op.tp2);
    if (stopTouched) {
      status = 'STOP_HIT';
      Object.assign(patch, { stop_hit_price: currentStop, exit_price: stopExitPrice, stop_hit_real_time: iso(c.closeTime), closed_at_real_time: iso(c.closeTime) });
      if (gapExit) patch.fib_gap_exit = true;
      if (tp2Touched) patch.exit_ambiguous = true;
      break;
    }
    if (tp2Touched) {
      status = 'TP2_HIT';
      Object.assign(patch, { tp2_hit_price: op.tp2, exit_price: op.tp2, tp2_hit_real_time: iso(c.closeTime), closed_at_real_time: iso(c.closeTime) });
      break;
    }
  }

  return {
    gap: false,
    processed: candles.length,
    status,
    patch: {
      ...patch,
      status,
      tp1_hit: tp1Hit,
      tp2_hit: status === 'TP2_HIT' || op.tp2_hit === true,
      current_stop: currentStop,
      fib_last_exit_candle_open_ms: lastOpen,
    },
  };
}
