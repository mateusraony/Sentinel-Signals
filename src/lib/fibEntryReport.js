// Seção `fibEntry` do relatório de backtest — docs/known-risks.md item 267.
// Pura: recebe os sinais e as operações do backend do replay. Conta por SINAL
// (não por avaliação, a lição do item 90): cada sinal 4h da RF termina em
// exatamente um balde — `filled` se a operação dele existe, senão o último
// motivo de rejeição gravado (fib_pending, fib_expired, fib_ran_away,
// fib_fill_missed, fib_no_leg, fib_already_retraced, ou um gate anterior como
// trend_reversed/active_op_exists).

const isFibOp = (op) => op?.exit_mode === 'FIB_FIXED';

export function summarizeFibEntry({ signals = [], ops = [], fromMs, toMs }) {
  const inWindow = (iso) => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && (fromMs == null || t >= fromMs) && (toMs == null || t <= toMs);
  };
  const opIds = new Set(ops.map((op) => op.id));
  const rfSignals = signals.filter((s) => s.timeframe === '4h' && s.source === 'range_filter' && inWindow(s.candle_time || s.created_date));
  const byStatus = {};
  for (const s of rfSignals) {
    const key = opIds.has(`trade_${s.dedup_key || s.id}`) ? 'filled' : (s.last_rejection_reason || 'no_retry');
    byStatus[key] = (byStatus[key] || 0) + 1;
  }

  const fibOps = ops.filter(isFibOp);
  const closed = fibOps.filter((op) => ['STOP_HIT', 'TP2_HIT', 'CLOSED', 'INVALIDATED'].includes(op.status));
  const exits = { stopBeforeTp1: 0, breakevenAfterTp1: 0, tp2: 0, timeStop: 0, other: 0 };
  for (const op of closed) {
    if (op.status === 'TP2_HIT') exits.tp2 += 1;
    else if (op.status === 'STOP_HIT') exits[op.tp1_hit ? 'breakevenAfterTp1' : 'stopBeforeTp1'] += 1;
    else if (op.closed_reason === 'TIME_STOP') exits.timeStop += 1;
    else exits.other += 1;
  }
  const stopPcts = fibOps
    .map((op) => Math.abs(op.entry_price - op.initial_stop) / op.entry_price * 100)
    .filter(Number.isFinite);
  const waits = fibOps.map((op) => op.fib_bars_waited).filter(Number.isFinite);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    enabled: true,
    signals: rfSignals.length,
    byStatus,
    fillRate: rfSignals.length ? (byStatus.filled || 0) / rfSignals.length : null,
    ops: fibOps.length,
    closedOps: closed.length,
    exits,
    tp1Rate: closed.length ? closed.filter((op) => op.tp1_hit).length / closed.length : null,
    exitAmbiguous: closed.filter((op) => op.exit_ambiguous === true).length,
    gapExits: closed.filter((op) => op.fib_gap_exit === true).length,
    // Tamanho do stop em % do preço: com stop curto, o custo fixo (taxa +
    // slippage) pesa mais em R — compare com report.costs.avgCostR.
    avgStopDistancePct: mean(stopPcts),
    avgBarsWaited: mean(waits),
  };
}
