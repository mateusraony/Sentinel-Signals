import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { simulateEquityCurve, DEFAULT_INITIAL_CAPITAL, DEFAULT_RISK_PCT } from '@/lib/equityCurve';
import { POLL_DIAGNOSTIC_MS } from '@/lib/pollingIntervals';
import { drawdownColor } from '@/lib/metricColorRanges';

// Conta virtual (capital+drawdown reais, compostos) sobre TODAS as operações fechadas.
// Mesma queryKey de LiveConfidenceCard.jsx/PerformanceMetricsBar.jsx/PerformanceOverview.jsx (achado C-2).
// Defaults ($1.000 / 1% de risco por operação) são os mesmos do relatório de Backtest — ver src/lib/equityCurve.js.
export default function VirtualAccountCard() {
  const { data: operations = [] } = useQuery({
    queryKey: ['trade-operations-closed-all'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', 500),
    refetchInterval: POLL_DIAGNOSTIC_MS,
  });

  const sim = useMemo(() => {
    if (operations.length === 0) return null;
    return simulateEquityCurve(operations, { initialCapital: DEFAULT_INITIAL_CAPITAL, riskPct: DEFAULT_RISK_PCT });
  }, [operations]);

  if (!sim || sim.total === 0) return null;

  const { finalCapital, totalReturnPct, maxDrawdownPct, accountBlown, unsized, total } = sim;
  const returnColor = totalReturnPct >= 0 ? '#5db586' : '#e06a5b';

  return (
    <div className="glass-card rounded-md p-4 h-full">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Conta virtual · ${DEFAULT_INITIAL_CAPITAL} inicial, {DEFAULT_RISK_PCT}% de risco por operação</p>
        {accountBlown && <span className="text-11px font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(224,106,91,0.15)', border: '1px solid rgba(224,106,91,0.4)', color: '#e06a5b' }}>CONTA ZERADA</span>}
      </div>
      <p className="text-2xl font-mono font-medium tabular-nums leading-none mt-2" style={{ color: returnColor }}>
        ${finalCapital.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
      <div className="flex gap-5 mt-2.5 text-xs">
        <span className="text-muted-foreground">Retorno <span className="font-mono" style={{ color: returnColor }}>{totalReturnPct >= 0 ? '+' : ''}{totalReturnPct.toFixed(2)}%</span></span>
        <span className="text-muted-foreground">Drawdown <span className="font-mono" style={{ color: drawdownColor(maxDrawdownPct) }}>-{maxDrawdownPct.toFixed(2)}%</span></span>
      </div>
      <p className="text-xs text-muted-foreground mt-1.5">{total} operações fechadas · {unsized > 0 ? `${unsized} sem risco definido` : 'todas dimensionadas'}</p>
    </div>
  );
}
