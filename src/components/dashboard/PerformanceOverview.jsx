import React, { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { TrendingUp, Award, BarChart2, Target } from 'lucide-react';
import moment from 'moment';
import { summarizeOps } from '@/lib/tradeMetrics';

const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg px-3 py-2 text-[10px] font-mono space-y-1"
      style={{ background: 'rgba(6,8,15,0.95)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
      <div className="text-muted-foreground">{d.label}</div>
      <div style={{ color: d.pnl >= 0 ? '#00ff80' : '#ff1478' }}>
        Trade: {d.pnl >= 0 ? '+' : ''}{d.pnl?.toFixed(2)}%
      </div>
      <div style={{ color: d.cumulative >= 0 ? '#00ff80' : '#ff1478' }}>
        Acumulado: {d.cumulative >= 0 ? '+' : ''}{d.cumulative?.toFixed(2)}%
      </div>
      <div className="text-muted-foreground">{d.status}</div>
    </div>
  );
};

export default function PerformanceOverview({ tradeOps }) {
  const { chartData, total, wins, losses, be, totalPnl, winRate, avgWin, avgLoss } = useMemo(() => {
    const s = summarizeOps(tradeOps);

    // Exit reason still labels each point; the BE tag now follows the
    // realized outcome, not `STOP_HIT && tp1_hit`.
    const data = s.curve
      .filter(p => p.pnlPct !== null)
      .map(({ op, pnlPct, cumulativePct, outcome }) => {
        const STATUS_LABELS = {
          TP2_HIT: '🏆 TP2', STOP_HIT: outcome === 'BE' ? '🔄 BE' : '🛑 Stop',
          INVALIDATED: '⚠️ Inv.', CLOSED: '✖ Enc.'
        };
        return {
          label: `${op.symbol?.replace('USDT', '/USDT')} ${op.timeframe?.toUpperCase()} · ${moment(op.created_date).format('DD/MM HH:mm')}`,
          pnl: parseFloat(pnlPct.toFixed(2)),
          cumulative: parseFloat(cumulativePct.toFixed(2)),
          status: STATUS_LABELS[op.status] || op.status,
        };
      });

    return {
      chartData: data,
      total: s.total,
      wins: s.wins,
      losses: s.losses,
      be: s.be,
      totalPnl: s.totalPnlPct,
      winRate: s.counted > 0 ? Math.round(s.winRate) : 0,
      avgWin: s.avgWinPct.toFixed(2),
      avgLoss: s.avgLossPct.toFixed(2),
    };
  }, [tradeOps]);

  if (total === 0) return null;

  const pnlColor = totalPnl >= 0 ? '#00ff80' : '#ff1478';
  const wrColor = winRate >= 60 ? '#00ff80' : winRate >= 45 ? '#ffd166' : '#ff1478';

  const metrics = [
    { icon: Award, label: 'Win Rate', value: `${winRate}%`, color: wrColor },
    { icon: TrendingUp, label: 'Retorno Acum.', value: `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%`, color: pnlColor },
    { icon: Target, label: 'Trades', value: `${wins}W / ${be}BE / ${losses}L`, color: '#00e5ff' },
    { icon: BarChart2, label: 'Avg Win / Loss', value: `+${avgWin}% / -${avgLoss}%`, color: '#ffd166' },
  ];

  return (
    <div className="rounded-xl p-4 space-y-4"
      style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(20px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart2 className="w-4 h-4" style={{ color: '#00e5ff' }} />
          <span className="text-sm font-bold text-foreground">Performance Consolidada</span>
          <span className="text-[9px] font-mono text-muted-foreground">— {total} trades fechados</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: '#00ff80', boxShadow: '0 0 5px #00ff80' }} />
          <span className="text-[9px] font-mono text-muted-foreground">Atualizado em tempo real</span>
        </div>
      </div>

      {/* Metric pills */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {metrics.map(({ icon: MetricIcon, label, value, color }) => (
          <div key={label} className="flex items-center gap-2.5 rounded-lg px-3 py-2.5"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <MetricIcon className="w-3.5 h-3.5 shrink-0" style={{ color }} />
            <div className="min-w-0">
              <div className="text-[8px] font-mono text-muted-foreground leading-none mb-0.5">{label}</div>
              <div className="text-xs font-mono font-bold truncate" style={{ color }}>{value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Chart — Saldo Acumulado */}
      {chartData.length > 1 && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-muted-foreground">Evolução do Saldo Acumulado (%)</span>
            <span className="text-[9px] font-mono font-bold" style={{ color: pnlColor }}>
              {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}% total
            </span>
          </div>
          <div style={{ height: 140 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                <defs>
                  <linearGradient id="perfGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={pnlColor} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={pnlColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" hide />
                <YAxis
                  tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.25)', fontFamily: 'monospace' }}
                  tickLine={false} axisLine={false}
                  tickFormatter={v => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
                />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                <Area
                  type="monotone"
                  dataKey="cumulative"
                  stroke={pnlColor}
                  strokeWidth={2}
                  fill="url(#perfGrad)"
                  dot={(props) => {
                    const { cx, cy, payload } = props;
                    const dotColor = payload.pnl >= 0 ? '#00ff80' : '#ff1478';
                    return <circle key={`dot-${payload.label}`} cx={cx} cy={cy} r={3} fill={dotColor} strokeWidth={0} />;
                  }}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}