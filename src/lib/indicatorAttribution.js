// Pure, dependency-free "shadow operation" simulator — docs/known-risks.md
// item 69 (Fase 1 do pedido do usuário: medir a contribuição marginal de
// cada indicador, não só olhar as operações que já passaram em todos os
// filtros de hoje). Backtest-only: precisa de candles FUTUROS em relação ao
// instante do sinal, que só o motor de replay tem disponível em memória de
// forma causal — scanner.js ao vivo nunca importa este arquivo.
//
// Mesma disciplina de não-look-ahead do resto do motor (P0-c/P0-d/P0-g,
// ver .claude/rules/trading-engine.md): os candles passados para
// simulateShadowOutcome devem já vir filtrados para o instante estritamente
// posterior ao sinal (mesmo contrato de isCandleUsableForExits) — este
// módulo não faz esse corte sozinho, o caller (backtestEngine.js) que
// controla o clock simulado é quem garante isso.
//
// buildShadowOp duplica (não importa) a fórmula de entry/stop/TP de
// buildTradeOpData (scanner.js:303-431) em vez de chamá-la diretamente — os
// dois formatos de input divergem (aqui é um snapshot de indicador, lá é um
// SignalEvent real com confirmation15m) e a fórmula em si é curta (~6
// linhas). Se o cálculo de entry/stop/TP em buildTradeOpData mudar, replique
// aqui também.

/**
 * @param {Object} snapshot - um item de rawSignalSnapshots (scanner.js)
 * @param {Object} pineConfig
 * @returns {Object} shadow op pronta para simulateShadowOutcome
 */
export function buildShadowOp(snapshot, pineConfig = {}) {
  const isBuy = snapshot.direction === 'BUY';
  const entry = snapshot.entry_price_ref;
  const atrValue = snapshot.atr_value;
  const atrStopMult = snapshot.tier_atr_stop_mult ?? 2.0;
  const riskR = atrValue * atrStopMult;
  const initialStop = isBuy ? entry - riskR : entry + riskR;
  const tp1R = pineConfig.tp1R ?? 1.5;
  const tp2R = tp1R * 2;
  const tp1 = isBuy ? entry + riskR * tp1R : entry - riskR * tp1R;
  const tp2 = isBuy ? entry + riskR * tp2R : entry - riskR * tp2R;
  return {
    isBuy,
    entry,
    initialStop,
    tp1,
    tp2,
    tp1R,
    tp2R,
    atrValue,
    timeStopBars: snapshot.tier_time_stop_bars ?? 48,
    runnerEnabled: pineConfig.runnerEnabled !== false,
    trailAtrMult: pineConfig.trailAtrMult ?? 2.0,
  };
}

// Extraído da MESMA fórmula de MFE/MAE de persistScanResults (scanner.js,
// item 47.2) — base de risco SEMPRE o risco inicial fixo (|entry-initialStop|),
// nunca o stop corrente/trailing, mesma convenção de sinal.
function trackExcursion({ isBuy, entry, riskR, candleHigh, candleLow, mfeR, maeR, barsSinceEntry, barsToMfe, barsToMae }) {
  if (!(riskR > 0)) return { mfeR, maeR, barsToMfe, barsToMae };
  const favorableExtreme = isBuy ? candleHigh : candleLow;
  const adverseExtreme = isBuy ? candleLow : candleHigh;
  const sign = isBuy ? 1 : -1;
  const favorableR = (sign * (favorableExtreme - entry)) / riskR;
  const adverseR = (sign * (adverseExtreme - entry)) / riskR;
  let nextMfe = mfeR, nextMae = maeR, nextBarsToMfe = barsToMfe, nextBarsToMae = barsToMae;
  if (!Number.isFinite(nextMfe) || favorableR > nextMfe) { nextMfe = favorableR; nextBarsToMfe = barsSinceEntry; }
  if (!Number.isFinite(nextMae) || adverseR < nextMae) { nextMae = adverseR; nextBarsToMae = barsSinceEntry; }
  return { mfeR: nextMfe, maeR: nextMae, barsToMfe: nextBarsToMfe, barsToMae: nextBarsToMae };
}

/**
 * Anda candle a candle (já filtrados para depois do sinal, ordem
 * cronológica) simulando a MESMA máquina de decisão do RF nativo em
 * persistScanResults (scanner.js:2989-3220): stop tem prioridade sobre TP no
 * mesmo candle (resolveCandleExit), Time Stop conta candles do timeframe de
 * sinal, TP1 move pro breakeven + runner (se runnerEnabled) ou fecha total,
 * trailing ATR pós-TP1 nunca regride. Simplificações DELIBERADAS em relação
 * ao motor real (documentadas, não são bugs):
 *   - `atrValue` fica CONSTANTE (o valor no instante do sinal) durante toda
 *     a simulação, em vez de recalculado a cada candle futuro — recalcular a
 *     série de ATR pra cada candle futuro de cada sinal-fantasma seria caro
 *     e não muda a pergunta que este módulo responde (contribuição de
 *     INDICADOR, não paridade fina de trailing).
 *   - Gates opt-in desligados por padrão no motor real (Chop Exit,
 *     Invalidação RF, proteção pré-TP1) são omitidos aqui — omiti-los
 *     reproduz exatamente o comportamento DEFAULT do motor real, não diverge
 *     dele.
 *   - Sem confirmação de 15m (entrada = preço de fechamento do candle de
 *     sinal) — deliberado: o objetivo aqui é isolar o indicador, não
 *     re-testar o mecanismo de confirmação 15m (já medido à parte, item 67).
 *
 * @param {Object} shadowOp - de buildShadowOp
 * @param {Array<{openTime:string, closeTime:string, high:number, low:number, close:number}>} futureCandles
 * @returns {Object} outcome
 */
export function simulateShadowOutcome(shadowOp, futureCandles) {
  const { isBuy, entry, initialStop, tp1, tp2, timeStopBars, runnerEnabled, atrValue, trailAtrMult } = shadowOp;
  const riskR = Math.abs(entry - initialStop);
  if (!(riskR > 0) || !Array.isArray(futureCandles) || futureCandles.length === 0) {
    return { outcome: 'insufficient_data', exitReason: null, rResult: null, mfeR: null, maeR: null, barsToExit: null };
  }

  let currentStop = initialStop;
  let tp1Hit = false;
  let mfeR = null, maeR = null, barsToMfe = null, barsToMae = null;

  for (let i = 0; i < futureCandles.length; i++) {
    const candle = futureCandles[i];
    const barsSinceEntry = i + 1;
    const candleHigh = candle.high;
    const candleLow = candle.low;
    const closePrice = candle.close;
    const stopCheckPrice = isBuy ? candleLow : candleHigh;
    const tpCheckPrice = isBuy ? candleHigh : candleLow;

    ({ mfeR, maeR, barsToMfe, barsToMae } = trackExcursion({
      isBuy, entry, riskR, candleHigh, candleLow, mfeR, maeR, barsSinceEntry, barsToMfe, barsToMae,
    }));

    if (!tp1Hit) {
      const stopHit = isBuy ? stopCheckPrice <= currentStop : stopCheckPrice >= currentStop;
      const tp1Touched = isBuy ? tpCheckPrice >= tp1 : tpCheckPrice <= tp1;
      const timeStopTriggered = barsSinceEntry >= timeStopBars;

      if (stopHit) {
        return { outcome: 'STOP_HIT', exitReason: 'STOP_HIT', rResult: (isBuy ? 1 : -1) * (currentStop - entry) / riskR, mfeR, maeR, barsToExit: barsSinceEntry };
      }
      if (timeStopTriggered) {
        return { outcome: 'CLOSED', exitReason: 'TIME_STOP', rResult: (isBuy ? 1 : -1) * (closePrice - entry) / riskR, mfeR, maeR, barsToExit: barsSinceEntry };
      }
      if (tp1Touched) {
        if (!runnerEnabled) {
          return { outcome: 'CLOSED', exitReason: 'TP1_FULL', rResult: shadowOp.tp1R, mfeR, maeR, barsToExit: barsSinceEntry };
        }
        tp1Hit = true;
        currentStop = entry; // breakeven, mesma regra do motor real
      }
    } else {
      const stopHit = isBuy ? stopCheckPrice <= currentStop : stopCheckPrice >= currentStop;
      const tp2Touched = isBuy ? tpCheckPrice >= tp2 : tpCheckPrice <= tp2;

      if (stopHit) {
        return { outcome: 'STOP_HIT', exitReason: 'STOP_HIT', rResult: (isBuy ? 1 : -1) * (currentStop - entry) / riskR, mfeR, maeR, barsToExit: barsSinceEntry };
      }
      if (tp2Touched) {
        return { outcome: 'TP2_HIT', exitReason: 'TP2_HIT', rResult: shadowOp.tp2R, mfeR, maeR, barsToExit: barsSinceEntry };
      }
      // P0-d: avança só depois de checar contra o stop ARMAZENADO — mesma
      // ordem do motor real (opExitRules.js:advanceTrailingStop).
      const atrTrailStop = isBuy ? closePrice - atrValue * trailAtrMult : closePrice + atrValue * trailAtrMult;
      currentStop = isBuy ? Math.max(currentStop, atrTrailStop) : Math.min(currentStop, atrTrailStop);
    }
  }

  return { outcome: 'STILL_OPEN_AT_CUTOFF', exitReason: null, rResult: null, mfeR, maeR, barsToExit: futureCandles.length };
}
