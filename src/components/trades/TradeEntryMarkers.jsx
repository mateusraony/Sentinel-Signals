import React, { useMemo } from 'react';
import {
  ComposedChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, CartesianGrid
} from 'recharts';
import moment from 'moment';
import { calcRealizedPnlPct as calcPnl } from '@/lib/tradeMetrics';

const STATUS_LABELS = {
  TP2_HIT: '🏆 TP2 Hit',
  STOP_HIT: '🛑 Stop Hit',
  INVALIDATED: '⚠️ Invalidado',
  CLOSED: '✗ Encerrado',
};

// Entry marker — triangle pointing up (BUY) or down (SELL)
function EntryDot({ cx, cy, payload }) {
  if (!cx || !cy || payload.type !== 'entry') return null;
  const isBuy = payload.side === 'BUY';
  const color = isBuy ? '#00ff80' : '#ff1478';
  const s = 8;
  const pts = isBuy
    ? `${cx},${cy - s} ${cx - s},${cy + s * 0.6} ${cx + s},${cy + s * 0.6}`
    : `${cx},${cy + s} ${cx - s},${cy - s * 0.6} ${cx + s},${cy - s * 0.6}`;
  return (
    <g>
      <polygon points={pts} fill={color} opacity={0.95}
        style={{ filter: `drop-shadow(0 0 5px ${color})` }} />
    </g>
  );
}

// Exit marker — circle with crosshair, colored by outcome
function ExitDot({ cx, cy, payload }) {
  if (!cx || !cy || payload.type !== 'exit') return null;
  const color = payload.status === 'STOP_HIT' && !payload.tp1_hit
    ? '#ff1478'
    : payload.status === 'STOP_HIT' && payload.tp1_hit
      ? '#ffd166'
      : payload.status === 'TP2_HIT'
        ? '#00ff80'
        : payload.status === 'INVALIDATED'
          ? '#ff9f43'
          : '#64748b';
  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill="none" stroke={color} strokeWidth={2}
        style={{ filter: `drop-shadow(0 0 5px ${color})` }} />
      <line x1={cx - 3} y1={cy} x2={cx + 3} y2={cy} stroke={color} strokeWidth={2} />
      <line x1={cx} y1={cy - 3} x2={cx} y2={cy + 3} stroke={color} strokeWidth={1.5} />
    </g>
  );
}

// Dispatches to EntryDot or ExitDot based on point type
function TradeDot(props) {
  const { payload } = props;
  if (!payload) return null;
  if (payload.type === 'entry') return <EntryDot {...props} />;
  if (payload.type === 'exit') return <ExitDot {...props} />;
  return null;
}

const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const isEntry = d.type === 'entry';
  return (
    <div className="rounded-lg px-3 py-2.5 text-[10px] font-mono space-y-1"
      style={{ background: 'rgba(6,8,15,0.97)', border: '1px solid rgba(255,255,255,0.1)', minWidth: 180, boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>
      <div className="font-bold flex items-center gap-1.5" style={{ color: d.side === 'BUY' ? '#00ff80' : '#ff1478' }}>
        {isEntry ? '▲ ENTRADA' : '● SAÍDA'} — {d.side} {d.symbol}
      </div>
      <div className="text-muted-foreground">{d.date}</div>
      {!isEntry && (
        <div style={{ color: d.pnl >= 0 ? '#00ff80' : '#ff1478' }} className="font-bold">
          P&L: {d.pnl >= 0 ? '+' : ''}{d.pnl?.toFixed(2)}%
        </div>
      )}
      <div style={{ color: '#94a3b8' }}>
        Cumulativo: {d.cumulative >= 0 ? '+' : ''}{d.cumulative?.toFixed(2)}%
      </div>
      {!isEntry && <div className="text-[9px]" style={{ color: '#64748b' }}>{d.statusLabel}</div>}
    </div>
  );
};

export default function TradeEntryMarkers({ history }) {
  const { chartData, finalCum, wins, losses } = useMemo(() => {
    const valid = history
      .filter(op => calcPnl(op) !== null && op.created_date && op.closed_at)
      .sort((a, b) => new Date(a.created_date) - new Date(b.created_date));

    if (valid.length === 0) return { chartData: [], finalCum: 0, wins: 0, losses: 0 };

    const points = [];
    let cumulative = 0;
    let w = 0, l = 0;

    valid.forEach((op) => {
      const pnl = calcPnl(op);
      const entryCum = cumulative;
      cumulative += pnl;
      const exitCum = cumulative;
      if (pnl >= 0) w++; else l++;

      const symbol = op.symbol?.replace('USDT', '/USDT');
      const side = op.side;
      const status = op.status;
      const statusLabel = STATUS_LABELS[status] || status;

      points.push({
        date: moment(op.created_date).format('DD/MM HH:mm'),
        timestamp: new Date(op.created_date).getTime(),
        type: 'entry',
        cumulative: parseFloat(entryCum.toFixed(2)),
        pnl: 0,
        symbol, side, status, statusLabel,
        tp1_hit: op.tp1_hit,
      });
      points.push({
        date: moment(op.closed_at).format('DD/MM HH:mm'),
        timestamp: new Date(op.closed_at).getTime(),
        type: 'exit',
        cumulative: parseFloat(exitCum.toFixed(2)),
        pnl: parseFloat(pnl.toFixed(2)),
        symbol, side, status, statusLabel,
        tp1_hit: op.tp1_hit,
      });
    });

    points.sort((a, b) => a.timestamp - b.timestamp);
    return { chartData: points, finalCum: cumulative, wins: w, losses: l };
  }, [history]);

  if (chartData.length === 0) return null;

  const isPositive = finalCum >= 0;
  const gradColor = isPositive ? '#00ff80' : '#ff1478';

  return (
    <div className="rounded-xl p-4 space-y-3"
      style={{ background: 'rgba(12,15,26,0.75)', border: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(16px)' }}>

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">Curva de Capital + Execuções de Entrada/Saída</div>
          <div className="text-xl font-bold font-mono mt-0.5" style={{ color: isPositive ? '#00ff80' : '#ff1478' }}>
            {finalCum >= 0 ? '+' : ''}{finalCum.toFixed(2)}%
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono flex-wrap">
          <span className="flex items-center gap-1.5">
            <svg width="12" height="10"><polygon points="6,0 0,10 12,10" fill="#00ff80" opacity={0.9} /></svg>
            <span style={{ color: 'rgba(255,255,255,0.5)' }}>Entrada BUY</span>
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="12" height="10"><polygon points="6,10 0,0 12,0" fill="#ff1478" opacity={0.9} /></svg>
            <span style={{ color: 'rgba(255,255,255,0.5)' }}>Entrada SELL</span>
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="none" stroke="#00ff80" strokeWidth="1.5" /><line x1="3" y1="6" x2="9" y2="6" stroke="#00ff80" strokeWidth="1.5" /></svg>
            <span style={{ color: 'rgba(255,255,255,0.5)' }}>Saída TP2</span>
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="none" stroke="#ff1478" strokeWidth="1.5" /><line x1="3" y1="6" x2="9" y2="6" stroke="#ff1478" strokeWidth="1.5" /></svg>
            <span style={{ color: 'rgba(255,255,255,0.5)' }}>Saída Stop</span>
          </span>
          <span style={{ color: '#00ff80' }}>✓ {wins}W</span>
          <span style={{ color: '#ff1478' }}>✗ {losses}L</span>
        </div>
      </div>

      {/* Chart */}
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 10, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="tradeExecGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={gradColor} stopOpacity={0.25} />
                <stop offset="95%" stopColor={gradColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis dataKey="date" tick={{ fill: 'rgba(255,255,255,0.2)', fontSize: 8, fontFamily: 'monospace' }}
              axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={30} />
            <YAxis tick={{ fill: 'rgba(255,255,255,0.2)', fontSize: 8, fontFamily: 'monospace' }}
              axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.08)', strokeWidth: 1 }} />
            <Area
              type="monotone"
              dataKey="cumulative"
              stroke={gradColor}
              strokeWidth={1.5}
              fill="url(#tradeExecGrad)"
              dot={<TradeDot />}
              activeDot={{ r: 5, fill: gradColor, stroke: 'none' }}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Recent exits */}
      <div className="flex gap-1.5 flex-wrap pt-1 max-h-24 overflow-y-auto">
        {chartData.filter(d => d.type === 'exit').slice(-12).map((d, i) => {
          const color = d.pnl >= 0 ? '#00ff80' : '#ff1478';
          return (
            <div key={i} className="flex items-center gap-1 px-2 py-1 rounded-lg text-[9px] font-mono"
              style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${color}22` }}>
              <span style={{ color: d.side === 'BUY' ? '#00ff80' : '#ff1478' }}>{d.side === 'BUY' ? '▲' : '▼'}</span>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>{d.symbol}</span>
              <span style={{ color }} className="font-bold">{d.pnl >= 0 ? '+' : ''}{d.pnl?.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}