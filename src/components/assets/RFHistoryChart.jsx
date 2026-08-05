import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { fetchCandles } from '@/lib/marketDataProvider';
import { calculateRangeFilter } from '@/lib/indicators/rangeFilter';
import {
  ComposedChart, Area, Line, ResponsiveContainer, YAxis, Tooltip, XAxis, CartesianGrid,
} from 'recharts';
import { BarChart2, AlertTriangle } from 'lucide-react';
import moment from 'moment';

const TIMEFRAMES = ['15m', '1h', '4h', '1d'];
const DISPLAY_BARS = 60;
const FETCH_LIMIT = 200;

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

function stdDevPct(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export default function RFHistoryChart({ asset }) {
  const [timeframe, setTimeframe] = useState('4h');

  const { data: candles, isLoading, error } = useQuery({
    queryKey: ['rf-history-candles', asset.symbol, timeframe],
    queryFn: () => fetchCandles(asset.symbol, timeframe, FETCH_LIMIT),
    staleTime: 60000,
    retry: 1,
  });

  const { data: signals = [] } = useQuery({
    queryKey: ['rf-history', asset.id],
    // Bounded to the 60 most recent signals (not just range_filter — macd
    // signals also carry rf_value, see scanner.js) so this query doesn't grow
    // with the asset's whole signal history; the table only needs the last 8.
    queryFn: () => backend.entities.SignalEvent.filter({ asset_id: asset.id }, '-created_date', 60),
    staleTime: 30000,
  });

  const analysis = useMemo(() => {
    if (!candles) return null;
    const closed = candles.filter(c => c.isClosed);
    let rf;
    try {
      rf = calculateRangeFilter(closed, asset.rf_period || 20, asset.rf_multiplier || 3.5);
    } catch {
      return null;
    }
    const { filterValues, hBand, lBand, direction } = rf.series;
    const start = Math.max(0, closed.length - DISPLAY_BARS);

    const chartData = closed.slice(start).map((c, idx) => {
      const i = start + idx;
      return {
        time: moment(c.closeTime).format('DD/MM HH:mm'),
        price: c.close,
        rf: filterValues[i],
        band: [lBand[i], hBand[i]],
        dir: direction[i],
      };
    });

    let flips = 0;
    for (let i = start + 1; i < closed.length; i++) {
      if (direction[i] !== direction[i - 1] && direction[i] !== 0 && direction[i - 1] !== 0) flips += 1;
    }

    const priceReturns = [];
    for (let i = start + 1; i < closed.length; i++) {
      priceReturns.push(((closed[i].close - closed[i - 1].close) / closed[i - 1].close) * 100);
    }
    const volatilityPct = stdDevPct(priceReturns);

    let upBars = 0; let downBars = 0;
    for (let i = start; i < closed.length; i++) {
      if (direction[i] === 1) upBars += 1;
      else if (direction[i] === -1) downBars += 1;
    }
    const bias = upBars > downBars ? 'Alta' : downBars > upBars ? 'Baixa' : 'Neutro';
    const biasColor = upBars > downBars ? '#00ff80' : downBars > upBars ? '#ff1478' : '#64748b';

    const first = chartData[0];
    const last = chartData[chartData.length - 1];
    const rfChangePct = first && last && first.rf ? ((last.rf - first.rf) / first.rf) * 100 : 0;
    const stability = Math.abs(rfChangePct) < 2 ? 'Estável' : Math.abs(rfChangePct) < 5 ? 'Moderada' : 'Volátil';
    const stabColor = Math.abs(rfChangePct) < 2 ? '#00ff80' : Math.abs(rfChangePct) < 5 ? '#ffd166' : '#ff1478';

    return { chartData, flips, volatilityPct, bias, biasColor, rfChangePct, stability, stabColor };
  }, [candles, asset.rf_period, asset.rf_multiplier]);

  const signalRows = useMemo(() => {
    return signals
      .filter(s => s.context?.rf_value != null)
      .sort((a, b) => new Date(b.created_date) - new Date(a.created_date))
      .slice(0, 8)
      .map(s => ({
        time: moment(s.created_date).format('DD/MM HH:mm'),
        dir: s.context.rf_direction,
        price: s.price_at_signal,
        rf: s.context.rf_value,
        signal: s.signal_type,
        tf: s.timeframe,
      }));
  }, [signals]);

  return (
    <div className="rounded-lg p-3 space-y-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
      {/* Header + timeframe filter */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5">
          <BarChart2 className="w-3 h-3" style={{ color: '#00e5ff' }} />
          <span className="text-[9px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
            Histórico Range Filter
          </span>
        </div>
        <div className="flex items-center gap-1">
          {TIMEFRAMES.map(tf => (
            <button key={tf} onClick={() => setTimeframe(tf)}
              className="px-2 py-0.5 rounded text-[9px] font-mono font-bold transition-all"
              style={timeframe === tf
                ? { background: 'rgba(0,229,255,0.15)', border: '1px solid rgba(0,229,255,0.4)', color: '#00e5ff' }
                : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
              {tf.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="text-[9px] font-mono text-muted-foreground animate-pulse text-center py-6">
          Carregando candles de {timeframe}...
        </div>
      )}

      {!isLoading && (error || !analysis) && (
        <div className="text-center py-4">
          <AlertTriangle className="w-4 h-4 mx-auto mb-1 text-muted-foreground opacity-30" />
          <div className="text-[9px] font-mono text-muted-foreground">
            Não foi possível calcular o Range Filter para {timeframe} agora.
          </div>
        </div>
      )}

      {!isLoading && analysis && (
        <>
          {/* Stability metrics */}
          <div className="grid grid-cols-4 gap-1.5">
            <div className="rounded px-2 py-1.5 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="text-[7px] font-mono text-muted-foreground uppercase">Mudança RF</div>
              <div className="text-[10px] font-mono font-bold" style={{ color: analysis.rfChangePct >= 0 ? '#00ff80' : '#ff1478' }}>
                {analysis.rfChangePct >= 0 ? '+' : ''}{analysis.rfChangePct.toFixed(2)}%
              </div>
            </div>
            <div className="rounded px-2 py-1.5 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="text-[7px] font-mono text-muted-foreground uppercase">Volatilidade</div>
              <div className="text-[10px] font-mono font-bold" style={{ color: '#00e5ff' }}>{analysis.volatilityPct.toFixed(2)}%</div>
            </div>
            <div className="rounded px-2 py-1.5 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="text-[7px] font-mono text-muted-foreground uppercase">Flips de direção</div>
              <div className="text-[10px] font-mono font-bold text-foreground">{analysis.flips}</div>
            </div>
            <div className="rounded px-2 py-1.5 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="text-[7px] font-mono text-muted-foreground uppercase">Bias / Estabilidade</div>
              <div className="text-[10px] font-mono font-bold" style={{ color: analysis.biasColor }}>{analysis.bias}</div>
              <div className="text-[8px] font-mono" style={{ color: analysis.stabColor }}>{analysis.stability}</div>
            </div>
          </div>

          {/* Price + RF + bands chart */}
          <div style={{ height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={analysis.chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <YAxis domain={['auto', 'auto']} hide />
                <XAxis dataKey="time" hide />
                <Tooltip
                  contentStyle={{ background: 'rgba(10,13,22,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace' }}
                  labelStyle={{ color: 'rgba(255,255,255,0.5)', fontSize: 9 }}
                  formatter={(value, name) => {
                    if (name === 'band') return [`$${fmt(value[0])} ~ $${fmt(value[1])}`, 'Banda RF'];
                    if (name === 'rf') return [`$${fmt(value)}`, 'RF'];
                    if (name === 'price') return [`$${fmt(value)}`, 'Preço'];
                    return [value, name];
                  }}
                />
                <Area type="monotone" dataKey="band" stroke="none" fill="rgba(0,229,255,0.08)" isAnimationActive={false} />
                <Line type="monotone" dataKey="price" stroke="rgba(255,255,255,0.55)" strokeWidth={1} dot={false} />
                <Line type="monotone" dataKey="rf" stroke="#00e5ff" strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: '#00e5ff' }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* Recent real signals table */}
      {signalRows.length > 0 && (
        <div className="space-y-0.5 max-h-32 overflow-y-auto pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
          <div className="text-[8px] font-mono text-muted-foreground uppercase tracking-wider px-1 pb-0.5">Sinais recentes</div>
          {signalRows.map((d, i) => (
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
      )}
    </div>
  );
}
