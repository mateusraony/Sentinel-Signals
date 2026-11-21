import TokenIcon from '@/components/TokenIcon';
import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import moment from 'moment';
import { backend } from '@/api/entities';
import { summarizeOps } from '@/lib/tradeMetrics';
import { POLL_DIAGNOSTIC_MS } from '@/lib/pollingIntervals';

/** @param {{ active?: boolean, payload?: Array<any> }} props */
const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md px-3 py-2 text-11px font-mono space-y-1"
      style={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))' }}>
      <div className="text-muted-foreground flex items-center gap-1.5"><TokenIcon symbol={d.symbol} size={12} />{d.label}</div>
      <div style={{ color: d.pnl >= 0 ? '#5db586' : '#e06a5b' }}>
        Trade: {d.pnl >= 0 ? '+' : ''}{d.pnl?.toFixed(2)}%
      </div>
      <div style={{ color: d.cumulative >= 0 ? '#5db586' : '#e06a5b' }}>
        Acumulado: {d.cumulative >= 0 ? '+' : ''}{d.cumulative?.toFixed(2)}%
      </div>
      <div className="text-muted-foreground">{d.status}</div>
    </div>
  );
};

// Mesma queryKey/teto de VirtualAccountCard.jsx e LiveConfidenceCard.jsx —
// ver comentário equivalente em PerformanceMetricsBar.jsx (achado C-2 do
// Raio-X de UI/UX, docs/claude/ui-audit-criticos.md).
// Layout: o número principal (retorno acumulado) e a contagem W/BE/L aparecem AQUI, uma vez só —
// antes repetiam em "Performance Real" e "Performance Consolidada".
export default function PerformanceOverview() {
  const { data: tradeOps = [] } = useQuery({
    queryKey: ['trade-operations-closed-all'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', 500),
    refetchInterval: POLL_DIAGNOSTIC_MS,
  });

  const { chartData, total, wins, losses, be, totalPnl } = useMemo(() => {
    const s = summarizeOps(tradeOps);
    const data = s.curve
      .filter(p => p.pnlPct !== null)
      .map(({ op, pnlPct, cumulativePct, outcome }) => {
        const STATUS_LABELS = {
          TP2_HIT: 'TP2', STOP_HIT: outcome === 'BE' ? 'BE' : 'Stop',
          INVALIDATED: 'Inv.', CLOSED: 'Enc.'
        };
        return {
          label: `${op.symbol?.replace('USDT', '/USDT')} ${op.timeframe?.toUpperCase()} · ${moment(op.created_date).format('DD/MM HH:mm')}`,
          symbol: op.symbol,
          date: moment(op.created_date).format('DD/MM'),
          pnl: parseFloat(pnlPct.toFixed(2)),
          cumulative: parseFloat(cumulativePct.toFixed(2)),
          status: STATUS_LABELS[op.status] || op.status,
        };
      });
    return { chartData: data, total: s.total, wins: s.wins, losses: s.losses, be: s.be, totalPnl: s.totalPnlPct };
  }, [tradeOps]);

  if (total === 0) return null;

  const pnlColor = totalPnl >= 0 ? '#5db586' : '#e06a5b';

  return (
    <div className="glass-card rounded-md p-5 h-full">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Evolução do saldo</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{total} trades fechados · {wins}W · {be}BE · {losses}L</p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-mono font-medium tabular-nums leading-none" style={{ color: pnlColor }}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}%
          </p>
          <p className="text-xs text-muted-foreground mt-1.5">retorno acumulado</p>
        </div>
      </div>

      {chartData.length > 1 && (
        <div className="mt-4" style={{ height: 230 }} role="img" aria-label={`Gráfico de área da evolução do saldo acumulado, ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}% no total`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="perfGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={pnlColor} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={pnlColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date"
                tick={{ fill: 'rgba(255,255,255,0.62)', fontSize: 11 }}
                axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={40} />
              {/* width fixo: antes o rótulo ficava cortado na esquerda (margin -28) */}
              <YAxis width={52}
                tick={{ fontSize: 11, fill: 'rgba(255,255,255,0.62)' }}
                tickLine={false} axisLine={false}
                tickFormatter={v => `${v > 0 ? '+' : ''}${v.toFixed(0)}%`}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3" />
              <Area
                type="monotone"
                dataKey="cumulative"
                stroke={pnlColor}
                strokeWidth={2}
                fill="url(#perfGrad)"
                dot={(props) => {
                  const { cx, cy, payload } = props;
                  const dotColor = payload.pnl >= 0 ? '#5db586' : '#e06a5b';
                  return <circle key={`dot-${payload.label}`} cx={cx} cy={cy} r={2.5} fill={dotColor} strokeWidth={0} />;
                }}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
