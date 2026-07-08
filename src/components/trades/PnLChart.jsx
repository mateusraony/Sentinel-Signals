import React, { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import moment from 'moment';

function calcPnl(op) {
  const isBuy = op.side === 'BUY';
  let exitPrice = op.exit_price ?? null;
  if (!exitPrice) {
    if (op.status === 'TP2_HIT') exitPrice = op.tp2;
    else if (op.status === 'STOP_HIT') exitPrice = op.tp1_hit ? op.entry_price : op.current_stop;
    else if (op.status === 'INVALIDATED' || op.status === 'CLOSED') exitPrice = op.current_stop;
  }
  if (!exitPrice || !op.entry_price) return null;
  return isBuy
    ? ((exitPrice - op.entry_price) / op.entry_price) * 100
    : ((op.entry_price - exitPrice) / op.entry_price) * 100;
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const isWin = d.pnl >= 0;
  return (
    <div className="rounded-lg px-3 py-2"
      style={{ background: 'rgba(8,10,18,0.95)', border: '1px solid rgba(255,255,255,0.08)', minWidth: 140 }}>
      <div className="text-[9px] font-mono text-muted-foreground mb-1">{label}</div>
      <div className="text-[11px] font-mono font-bold" style={{ color: isWin ? '#00ff80' : '#ff1478' }}>
        {d.pnl >= 0 ? '+' : ''}{d.pnl?.toFixed(2)}%
      </div>
      <div className="text-[9px] font-mono text-muted-foreground">
        Acum: <span style={{ color: d.cumulative >= 0 ? '#00ff80' : '#ff1478' }}>
          {d.cumulative >= 0 ? '+' : ''}{d.cumulative?.toFixed(2)}%
        </span>
      </div>
      <div className="text-[9px] font-mono text-muted-foreground mt-0.5">{d.symbol} {d.side} {d.tf}</div>
    </div>
  );
};

export default function PnLChart({ history }) {
  const data = useMemo(() => {
    const sorted = [...history]
      .filter(op => calcPnl(op) !== null)
      .sort((a, b) => new Date(a.created_date) - new Date(b.created_date));

    let cumulative = 0;
    return sorted.map(op => {
      const pnl = calcPnl(op);
      cumulative += pnl;
      return {
        date: moment(op.created_date).format('DD/MM'),
        pnl: parseFloat(pnl.toFixed(2)),
        cumulative: parseFloat(cumulative.toFixed(2)),
        symbol: op.symbol?.replace('USDT', '/USDT'),
        side: op.side,
        tf: op.timeframe?.toUpperCase(),
        status: op.status,
      };
    });
  }, [history]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 rounded-xl"
        style={{ background: 'rgba(12,15,26,0.6)', border: '1px solid rgba(255,255,255,0.05)' }}>
        <p className="text-[10px] font-mono text-muted-foreground">Sem histórico suficiente para o gráfico.</p>
      </div>
    );
  }

  const finalCum = data[data.length - 1]?.cumulative ?? 0;
  const isPositive = finalCum >= 0;
  const gradColor = isPositive ? '#00ff80' : '#ff1478';

  return (
    <div className="rounded-xl p-4"
      style={{ background: 'rgba(12,15,26,0.7)', border: '1px solid rgba(255,255,255,0.06)', backdropFilter: 'blur(12px)' }}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Performance Acumulada</div>
          <div className="text-xl font-bold font-mono mt-0.5" style={{ color: isPositive ? '#00ff80' : '#ff1478' }}>
            {finalCum >= 0 ? '+' : ''}{finalCum.toFixed(2)}%
          </div>
        </div>
        <div className="text-right">
          <div className="text-[9px] font-mono text-muted-foreground">{data.length} trades</div>
          <div className="text-[9px] font-mono mt-0.5">
            <span style={{ color: '#00ff80' }}>✓ {data.filter(d => d.pnl >= 0).length} win</span>
            <span className="text-muted-foreground mx-1">·</span>
            <span style={{ color: '#ff1478' }}>✗ {data.filter(d => d.pnl < 0).length} loss</span>
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={gradColor} stopOpacity={0.3} />
              <stop offset="95%" stopColor={gradColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tick={{ fill: 'rgba(255,255,255,0.25)', fontSize: 8, fontFamily: 'monospace' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: 'rgba(255,255,255,0.25)', fontSize: 8, fontFamily: 'monospace' }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey="cumulative"
            stroke={gradColor}
            strokeWidth={1.5}
            fill="url(#pnlGrad)"
            dot={false}
            activeDot={{ r: 3, fill: gradColor, stroke: 'none' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}