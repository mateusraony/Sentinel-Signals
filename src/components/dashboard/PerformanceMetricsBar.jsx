import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { summarizeOps } from '@/lib/tradeMetrics';
import { POLL_DIAGNOSTIC_MS } from '@/lib/pollingIntervals';
import { drawdownColor, winRateColor } from '@/lib/metricColorRanges';

// Mesma queryKey/teto de VirtualAccountCard.jsx e LiveConfidenceCard.jsx — os cards de performance
// concordam sobre a mesma amostra (achado C-2 do Raio-X de UI/UX, docs/claude/ui-audit-criticos.md).
// Layout: o retorno acumulado e W/BE/L saíram daqui (aparecem uma vez em "Evolução do saldo");
// `activeOpsCount` segue como prop mas o selo "N ativas" saiu — o Resumo do topo já mostra esse número.
function Metric({ label, value, sub, color }) {
  return (
    <div className="glass-card rounded-md p-4">
      <p className="text-xs text-muted-foreground mb-2">{label}</p>
      <p className="text-2xl font-mono font-medium tabular-nums leading-none" style={{ color }}>{value}</p>
      <p className="text-xs text-muted-foreground mt-2">{sub}</p>
    </div>
  );
}

// eslint-disable-next-line no-unused-vars
export default function PerformanceMetricsBar({ activeOpsCount = 0 }) {
  const { data: tradeOps = [] } = useQuery({
    queryKey: ['trade-operations-closed-all'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', 500),
    refetchInterval: POLL_DIAGNOSTIC_MS,
  });

  const metrics = useMemo(() => {
    const s = summarizeOps(tradeOps);
    if (s.counted === 0) return null;
    const rr = s.avgLossPct > 0 ? s.avgWinPct / s.avgLossPct : null;
    return { maxDrawdown: s.maxDrawdownPct, winRate: Math.round(s.winRate), avgWin: s.avgWinPct, avgLoss: s.avgLossPct, expectancyR: s.expectancyR, rr };
  }, [tradeOps]);

  if (!metrics) return null;
  const { maxDrawdown, winRate, avgWin, avgLoss, expectancyR, rr } = metrics;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 h-full">
      <Metric label="Win rate" value={`${winRate}%`} color={winRateColor(winRate)}
        sub={expectancyR !== null ? `Expectância ${expectancyR >= 0 ? '+' : ''}${expectancyR.toFixed(2)}R` : 'Expectância indisponível'} />
      <Metric label="Drawdown máximo" value={`-${maxDrawdown.toFixed(2)}%`} color={drawdownColor(maxDrawdown)}
        sub={maxDrawdown < 5 ? 'Risco controlado' : maxDrawdown < 15 ? 'Atenção moderada' : 'Drawdown alto'} />
      <Metric label="Risco / retorno" value={rr !== null ? `${rr.toFixed(2)}:1` : '—'}
        color={rr !== null ? (rr >= 2 ? '#5db586' : rr >= 1.5 ? '#e3b45a' : '#dd9a4a') : '#64748b'}
        sub={rr !== null ? (rr >= 2 ? 'Excelente' : rr >= 1.5 ? 'Bom' : 'Abaixo do ideal') : 'Dados insuficientes'} />
      <Metric label="Ganho / perda médios" color="hsl(var(--foreground))" sub="por trade fechado"
        value={<span className="whitespace-nowrap text-xl"><span style={{ color: '#5db586' }}>+{avgWin.toFixed(1)}%</span><span className="text-muted-foreground"> / </span><span style={{ color: '#e06a5b' }}>-{avgLoss.toFixed(1)}%</span></span>} />
    </div>
  );
}
