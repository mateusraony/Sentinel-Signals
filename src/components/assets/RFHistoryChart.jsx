import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip, XAxis } from 'recharts';
import { BarChart2 } from 'lucide-react';
import moment from 'moment';

function fmt(price) {
  if (!price && price !== 0) return '—';
  if (price >= 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function dirColor(dir) {
  return dir === 1 ? '#00ff80' : dir === -1 ? '#ff1478' : '#64748b';
}

export default function RFHistoryChart({ asset }) {
  const { data: signals = [], isLoading } = useQuery({
    queryKey: ['rf-history', asset.id],
    queryFn: () => base44.entities.SignalEvent.filter({ asset_id: asset.id }),
    staleTime: 30000,
  });

  const chartData = useMemo(() => {
    return signals
      .filter(s => s.context?.rf_value != null)
      .sort((a, b) => new Date(a.created_date) - new Date(b.created_date))
      .slice(-30)
      .map(s => ({
        time: moment(s.created_date).format('DD/MM HH:mm'),
        rf: s.context.rf_value,
        dir: s.context.rf_direction,
        price: s.price_at_signal,
        signal: s.signal_type,
        tf: s.timeframe,
      }));
  }, [signals]);

  if (isLoading) {
    return (
      <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
        <div className="text-[9px] font-mono text-muted-foreground animate-pulse">Carregando histórico RF...</div>
      </div>
    );
  }

  if (chartData.length < 2) {
    return (
      <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
        <BarChart2 className="w-4 h-4 mx-auto mb-1 text-muted-foreground opacity-30" />
        <div className="text-[9px] font-mono text-muted-foreground">
          {chartData.length === 0 ? 'Sem histórico de sinais RF ainda' : 'Dados insuficientes para gráfico'}
        </div>
        <div className="text-[8px] font-mono text-muted-foreground/60 mt-0.5">
          O histórico é construído automaticamente conforme os sinais são gerados
        </div>
      </div>
    );
  }

  const latest = chartData[chartData.length - 1];
  const first = chartData[0];
  const rfChange = ((latest.rf - first.rf) / first.rf) * 100;
  const stability = Math.abs(rfChange) < 2 ? 'Estável' : Math.abs(rfChange) < 5 ? 'Moderada' : 'Volátil';
  const stabColor = Math.abs(rfChange) < 2 ? '#00ff80' : Math.abs(rfChange) < 5 ? '#ffd166' : '#ff1478';

  return (
    <div className="rounded-lg p-3 space-y-2" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <BarChart2 className="w-3 h-3" style={{ color: '#00e5ff' }} />
          <span className="text-[9px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
            Histórico Range Filter
          </span>
        </div>
        <div className="flex items-center gap-2 text-[9px] font-mono">
          <span className="text-muted-foreground">Estabilidade:</span>
          <span className="font-bold" style={{ color: stabColor }}>{stability}</span>
          <span style={{ color: rfChange >= 0 ? '#00ff80' : '#ff1478' }}>
            {rfChange >= 0 ? '+' : ''}{rfChange.toFixed(2)}%
          </span>
        </div>
      </div>

      {/* Sparkline */}
      <div style={{ height: 60 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 2, right: 4, bottom: 0, left: 4 }}>
            <YAxis domain={['auto', 'auto']} hide />
            <XAxis dataKey="time" hide />
            <Tooltip
              contentStyle={{
                background: 'rgba(10,13,22,0.95)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                fontSize: 10,
                fontFamily: 'monospace',
              }}
              labelStyle={{ color: 'rgba(255,255,255,0.5)', fontSize: 9 }}
              formatter={(value, name) => {
                if (name === 'rf') return [`$${fmt(value)}`, 'RF Value'];
                return [value, name];
              }}
            />
            <Line
              type="monotone"
              dataKey="rf"
              stroke="#00e5ff"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: '#00e5ff' }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Recent values table */}
      <div className="space-y-0.5 max-h-32 overflow-y-auto">
        {[...chartData].reverse().slice(0, 8).map((d, i) => (
          <div key={i} className="flex items-center justify-between text-[8px] font-mono px-1 py-0.5 rounded"
            style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent' }}>
            <span className="text-muted-foreground">{d.time}</span>
            <span style={{ color: dirColor(d.dir) }}>
              {d.dir === 1 ? '▲' : d.dir === -1 ? '▼' : '—'} {d.tf?.toUpperCase()}
            </span>
            <span style={{ color: d.signal === 'BUY' ? '#00ff80' : '#ff1478' }}>{d.signal}</span>
            <span style={{ color: '#00e5ff' }}>${fmt(d.rf)}</span>
            <span className="text-muted-foreground">${fmt(d.price)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}