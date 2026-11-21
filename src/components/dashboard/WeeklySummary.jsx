import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { BarChart, Bar, ResponsiveContainer, Tooltip, Cell } from 'recharts';
import moment from 'moment';
import { isClosedOp, getClosedAt, calcRealizedPnlPct, summarizeOps } from '@/lib/tradeMetrics';

const WEEKDAY_LABELS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
// Consulta própria, dedicada — não reaproveita os feeds do Dashboard (limitados a 100 ops / 50 sinais).
const WEEK_OPS_LIMIT = 500;
const WEEK_SIGNALS_LIMIT = 300;

export default function WeeklySummary() {
  const { data: tradeOps = [], isLoading: loadingOps } = useQuery({
    queryKey: ['weekly-summary-ops'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', WEEK_OPS_LIMIT),
    staleTime: 60000,
  });
  const { data: recentSignals = [], isLoading: loadingSignals } = useQuery({
    queryKey: ['weekly-summary-signals'],
    queryFn: () => backend.entities.SignalEvent.list('-created_date', WEEK_SIGNALS_LIMIT),
    staleTime: 60000,
  });

  // Achado M-1 do Raio-X: sem isto os números mostravam "+0.00%"/0 como resultado real enquanto carregava.
  const isLoading = loadingOps || loadingSignals;

  const data = useMemo(() => {
    const weekStart = moment().startOf('isoWeek');
    const weekOps = (tradeOps || []).filter(op => {
      if (!isClosedOp(op)) return false;
      const closedAt = getClosedAt(op) || op.created_date;
      return moment(closedAt).isSameOrAfter(weekStart);
    });
    const summary = summarizeOps(weekOps);
    // Achado M-2 do Raio-X: só Range Filter, igual ao resto do Dashboard.
    const signalsThisWeek = (recentSignals || [])
      .filter(s => s.source === 'range_filter' && moment(s.created_date).isSameOrAfter(weekStart)).length;
    const daily = WEEKDAY_LABELS.map((label, i) => {
      const day = moment(weekStart).add(i, 'days');
      const pnlPct = weekOps.reduce((sum, op) => {
        const closedAt = moment(getClosedAt(op) || op.created_date);
        return closedAt.isSame(day, 'day') ? sum + (calcRealizedPnlPct(op) || 0) : sum;
      }, 0);
      return { label, pnlPct: +pnlPct.toFixed(2), isFuture: day.isAfter(moment(), 'day') };
    });
    return {
      totalPnl: summary.totalPnlPct,
      winRate: summary.counted > 0 ? Math.round(summary.winRate) : null,
      counted: summary.counted, wins: summary.wins, losses: summary.losses, be: summary.be,
      signalsThisWeek, daily,
      weekRangeLabel: `${weekStart.format('DD/MM')} – ${moment(weekStart).add(6, 'days').format('DD/MM')}`,
    };
  }, [tradeOps, recentSignals]);

  const pnlColor = data.totalPnl >= 0 ? '#5db586' : '#e06a5b';
  const dim = 'rgba(255,255,255,0.55)';

  return (
    <div className="glass-card rounded-md p-5 h-full flex flex-col">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-foreground">Esta semana</h3>
        <span className="text-xs text-muted-foreground font-mono">{data.weekRangeLabel}</span>
      </div>
      <p data-testid="semana-pnl" className="text-3xl font-mono font-medium tabular-nums leading-none mt-3" style={{ color: isLoading ? dim : pnlColor }}>
        {isLoading ? '···' : `${data.totalPnl >= 0 ? '+' : ''}${data.totalPnl.toFixed(2)}%`}
      </p>
      <p className="text-xs text-muted-foreground mt-1.5">P&L da semana · {data.wins}W · {data.be}BE · {data.losses}L</p>

      <div className="grid grid-cols-2 gap-3 mt-4 pt-4" style={{ borderTop: '1px solid hsl(var(--border))' }}>
        <div>
          <p className="text-xs text-muted-foreground">Taxa de acerto</p>
          <p data-testid="semana-acerto" className="text-lg font-mono font-medium tabular-nums mt-0.5" style={{ color: isLoading ? dim : '#e3b45a' }}>
            {isLoading ? '···' : (data.winRate !== null ? `${data.winRate}%` : '—')}
          </p>
          <p className="text-xs text-muted-foreground">{isLoading ? 'carregando…' : (data.counted > 0 ? `${data.counted} trades fechados` : 'sem trades ainda')}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Sinais processados</p>
          <p data-testid="semana-sinais" className="text-lg font-mono font-medium tabular-nums mt-0.5" style={{ color: isLoading ? dim : 'hsl(var(--foreground))' }}>
            {isLoading ? '···' : data.signalsThisWeek}
          </p>
          <p className="text-xs text-muted-foreground">desde segunda-feira</p>
        </div>
      </div>

      <div className="mt-4 pt-4 flex-1 min-h-[96px]" style={{ borderTop: '1px solid hsl(var(--border))' }}>
        <p className="text-xs text-muted-foreground mb-1">P&L por dia</p>
        <div style={{ height: 70 }} role="img"
          aria-label={isLoading
            ? 'Gráfico de barras do P&L por dia da semana — carregando'
            : `Gráfico de barras do P&L por dia da semana, ${data.totalPnl >= 0 ? '+' : ''}${data.totalPnl.toFixed(2)}% no total`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.daily} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
              <Tooltip
                contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 6, fontSize: 11, fontFamily: 'monospace' }}
                formatter={(value) => [`${value}%`, 'P&L']}
                labelFormatter={(label) => label}
              />
              <Bar dataKey="pnlPct" radius={[2, 2, 0, 0]}>
                {data.daily.map((d, i) => (
                  <Cell key={i} fill={d.isFuture ? 'rgba(255,255,255,0.06)' : d.pnlPct >= 0 ? '#5db586' : '#e06a5b'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="grid grid-cols-7 text-center mt-1">
          {WEEKDAY_LABELS.map(l => <span key={l} className="text-11px text-muted-foreground">{l}</span>)}
        </div>
      </div>
    </div>
  );
}
