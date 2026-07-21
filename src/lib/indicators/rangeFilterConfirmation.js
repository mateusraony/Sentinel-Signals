/**
 * confirmBars — porte fiel do gate de confirmação de N candles do Pine real
 * do usuário ("NEW ERA - Range Filter Strategy v13.2", src/pages/PineScript.jsx
 * linhas ~251-329/397-398). Sincronizado em strategyConfig/current desde
 * sempre mas nunca lido por scanner.js (docs/known-risks.md item 27) —
 * implementado aqui, isolado de rangeFilter.js (que já é testado por
 * paridade e sensível a look-ahead) para não arriscar aquele arquivo.
 *
 * O Pine é RETROATIVO, não um contador que precisa de estado entre scans:
 * na barra atual, olha pra trás os últimos `confirmBars` candles JÁ
 * FECHADOS (via ta.barssince + um for-loop sobre close[i]/filt[i]/fdir[i]).
 * Por ser função só de séries já causais (produzidas por calculateRangeFilter,
 * que já não olha à frente), esta função herda a propriedade de não-repaint
 * automaticamente — sem precisar de nenhum novo campo persistido.
 *
 * Pine:
 *   longSignalRaw  = longCond and nz(condIni[1], 0) == -1        (= signals[i]==='BUY' no port)
 *   barsSinceBuy   = ta.barssince(longSignalRaw)
 *   freshBuy       = not na(barsSinceBuy) and barsSinceBuy == confirmBars - 1
 *   buyFollowThrough = true; for i = 0 to confirmBars-1: buyFollowThrough := buyFollowThrough and close[i] > filt[i] and fdir[i] == 1
 *   finalBuy       = ... and freshBuy and buyFollowThrough and ...
 *
 * Propriedade em confirmBars=1 (o default sincronizado hoje): freshBuy vira
 * "o flip é a barra atual" e o loop de follow-through roda só i=0. Em
 * rangeFilter.js, longCond exige `src > filt && upward` em AMBOS os ramos do
 * OR — ou seja, sempre que signals[i]==='BUY' dispara, close[i]>filt[i] &&
 * direction[i]===1 já é verdade por construção. Logo confirmBars=1 é
 * matematicamente idêntico ao sinal bruto de hoje (provado em
 * rangeFilterConfirmation.test.js, não só afirmado aqui).
 */
export function calculateConfirmedSignal(series, confirmBars = 1, index = series.filterValues.length - 1) {
  const { filterValues, direction, signals, closes } = series;
  const bars = Math.max(1, Math.round(confirmBars) || 1);

  function barsSinceLastSignal(type) {
    for (let back = 0; back <= index; back++) {
      if (signals[index - back] === type) return back;
    }
    return null; // Pine's na() — never fired within the available history
  }

  function followThrough(wantDirection) {
    for (let k = 0; k < bars; k++) {
      const idx = index - k;
      if (idx < 0) return false; // insufficient history — mirrors Pine's na()
      const holds = wantDirection === 1
        ? closes[idx] > filterValues[idx] && direction[idx] === 1
        : closes[idx] < filterValues[idx] && direction[idx] === -1;
      if (!holds) return false;
    }
    return true;
  }

  const barsSinceBuy = barsSinceLastSignal('BUY');
  const barsSinceSell = barsSinceLastSignal('SELL');
  const freshBuy = barsSinceBuy === bars - 1;
  const freshSell = barsSinceSell === bars - 1;
  const buyFollowThrough = followThrough(1);
  const sellFollowThrough = followThrough(-1);

  const confirmedSignal = freshBuy && buyFollowThrough
    ? 'BUY'
    : freshSell && sellFollowThrough
      ? 'SELL'
      : 'NONE';

  return { confirmedSignal, buyFollowThrough, sellFollowThrough, freshBuy, freshSell };
}
