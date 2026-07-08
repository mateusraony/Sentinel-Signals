import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import { TrendingUp, TrendingDown, Activity } from 'lucide-react';
import { fetchCandles } from '@/lib/marketDataProvider';
import moment from 'moment';

function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

/**
 * Calculate cumulative PnL % from closed trade operations.
 * Assumes equal position size per trade (normalized).
 */
function calcPortfolioCurve(trades) {
  const closed = trades
    .filter(t => t.closed_at && t.entry_price && t.exit_price)
    .sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at));

  if (closed.length === 0) return [];

  let cumulative = 0;
  return closed.map((t, i) => {
    const isBuy = t.side === 'BUY';
    const pnlPct = isBuy
      ? ((t.exit_price - t.entry_price) / t.entry_price) * 100
      : ((t.entry_price - t.exit_price) / t.entry_price) * 100;

    // Weight: 50% if TP1 hit only (partial), 100% if TP2, full loss if stop
    let weight = 1;
    if (t.status === 'STOP_HIT' && t.tp1_hit) weight = 0.5; // BE on runner
    else if (t.status === 'STOP_HIT' && !t.tp1_hit) weight = 1;
    else if (t.status === 'TP2_HIT') weight = 1;
    else if (t.status === 'INVALIDATED') weight = 0.5;

    cumulative += pnlPct * weight;
    return {
      date: moment(t.closed_at).format('DD/MM HH:mm'),
      timestamp: new Date(t.closed_at).getTime(),
      tradePnl: pnlPct * weight,
      portfolio: cumulative,
      symbol: t.symbol?.replace('USDT', '/USDT'),
      side: t.side,
      status: t.status,
    };
  });
}

/**
 * Fetch BTC daily candles as market benchmark and normalize to % change
 * over the same period as the trades.
 */
function useMarketBenchmark(firstTradeTs, lastTradeTs) {
  return useQuery({
    queryKey: ['market-benchmark', firstTradeTs, lastTradeTs],
    queryFn: async () => {
      // Fetch enough daily candles to cover the trade period
      const candles = await fetchCandles('BTCUSDT', '1d', 60);
      const closed = candles.filter(c => c.isClosed);
      if (closed.length < 2) return [];

      // Find the candle closest to the first trade
      const startIdx = closed.findIndex(c => c.closeTime >= firstTradeTs);
      const baseIdx = startIdx > 0 ? startIdx - 1 : 0;
      const basePrice = closed[baseIdx].close;

      return closed
        .filter(c => c.closeTime >= closed[baseIdx].closeTime)
        .map(c => ({
          timestamp: c.closeTime,
          date: moment(c.closeTime).format('DD/MM HH:mm'),
          market: ((c.close - basePrice) / basePrice) * 100,
        }));
    },
    enabled: !!firstTradeTs && !!lastTradeTs,
    staleTime: 5 * 60 * 1000,
  });
}

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  return (
    <div className="rounded-lg p-3 text-xs font-mono"
      style={{ background: 'rgba(10,13,22,0.95)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
      <div className="text-[10px] text-muted-foreground mb-1.5">{data?.date}</div>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5" style={{ color: entry.color }}>
            <span className="w-2 h-2 rounded-full" style={{ background: entry.color }} />
            {entry.name === 'portfolio' ? 'Minha Carteira' : entry.name === 'market' ? 'BTC (Mercado)' : entry.name}
          </span>
          <span className="font-bold" style={{ color: entry.value >= 0 ? '#00ff80' : '#ff1478' }}>
            {fmtPct(entry.value)}
          </span>
        </div>
      ))}
      {data?.symbol && (
        <div className="mt-1.5 pt-1.5 text-[9px] text-muted-foreground" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          Trade: {data.symbol} {data.side} → {data.status}
        </div>
      )}
    </div>
  );
}

export default function PortfolioVsMarket({ trades }) {
  const portfolioCurve = useMemo(() => calcPortfolioCurve(trades), [trades]);

  const firstTs = portfolioCurve[0]?.timestamp;
  const lastTs = portfolioCurve[portfolioCurve.length - 1]?.timestamp;
  const { data: marketCurve = [] } = useMarketBenchmark(firstTs, lastTs);

  // Merge portfolio and market data by closest timestamp
  const mergedData = useMemo(() => {
    if (portfolioCurve.length === 0) return [];

    // For each portfolio point, find the closest market point
    return portfolioCurve.map(p => {
      let closestMarket = null;
      let minDiff = Infinity;
      for (const m of marketCurve) {
        const diff = Math.abs(m.timestamp - p.timestamp);
        if (diff < minDiff) {
          minDiff = diff;
          closestMarket = m;
        }
      }
      return {
        ...p,
        market: closestMarket?.market ?? null,
      };
    });
  }, [portfolioCurve, marketCurve]);

  if (portfolioCurve.length < 2) {
    return (
      <div className="glass-card rounded-xl p-8 text-center">
        <Activity className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
        <p className="text-sm text-muted-foreground">
          Dados insuficientes para o gráfico comparativo.
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          É necessário pelo menos 2 trades fechados com preço de saída registrado.
        </p>
      </div>
    );
  }

  const finalPnl = portfolioCurve[portfolioCurve.length - 1]?.portfolio || 0;
  const finalMarket = mergedData[mergedData.length - 1]?.market || 0;
  const outperform = finalPnl > finalMarket;

  return (
    <div className="rounded-xl p-4"
      style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(255,255,255,0.06)' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4" style={{ color: '#00e5ff' }} />
          <h3 className="text-sm font-bold text-foreground">Carteira vs Mercado (BTC)</h3>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: '#00ff80' }} />
            <span style={{ color: 'rgba(255,255,255,0.5)' }}>Carteira</span>
            <span className="font-bold" style={{ color: finalPnl >= 0 ? '#00ff80' : '#ff1478' }}>
              {fmtPct(finalPnl)}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: '#ff9f43' }} />
            <span style={{ color: 'rgba(255,255,255,0.5)' }}>BTC</span>
            <span className="font-bold" style={{ color: finalMarket >= 0 ? '#00ff80' : '#ff1478' }}>
              {fmtPct(finalMarket)}
            </span>
          </span>
          {outperform && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded"
              style={{ background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.25)', color: '#00ff80' }}>
              <TrendingUp className="w-3 h-3" /> Superando
            </span>
          )}
          {!outperform && finalMarket !== 0 && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded"
              style={{ background: 'rgba(255,20,120,0.1)', border: '1px solid rgba(255,20,120,0.25)', color: '#ff1478' }}>
              <TrendingDown className="w-3 h-3" /> Atrás
            </span>
          )}
        </div>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={mergedData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <defs>
            <linearGradient id="portfolioGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#00ff80" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#00ff80" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis
            dataKey="date"
            tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 9, fontFamily: 'monospace' }}
            tickLine={{ stroke: 'rgba(255,255,255,0.08)' }}
            axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
            minTickGap={40}
          />
          <YAxis
            tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 9, fontFamily: 'monospace' }}
            tickLine={{ stroke: 'rgba(255,255,255,0.08)' }}
            axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
            tickFormatter={(v) => `${v.toFixed(1)}%`}
            width={48}
          />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'monospace' }} />
          <Area
            type="monotone"
            dataKey="portfolio"
            name="portfolio"
            stroke="#00ff80"
            strokeWidth={2}
            fill="url(#portfolioGrad)"
            dot={{ fill: '#00ff80', r: 3 }}
            activeDot={{ r: 5, fill: '#00ff80' }}
          />
          <Line
            type="monotone"
            dataKey="market"
            name="market"
            stroke="#ff9f43"
            strokeWidth={1.5}
            strokeDasharray="5 3"
            dot={false}
            activeDot={{ r: 4, fill: '#ff9f43' }}
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Summary bar */}
      <div className="flex items-center justify-between mt-3 pt-3 text-[10px] font-mono"
        style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <span style={{ color: 'rgba(255,255,255,0.35)' }}>
          {portfolioCurve.length} trades fechados · {portfolioCurve[0]?.date} → {portfolioCurve[portfolioCurve.length - 1]?.date}
        </span>
        <span style={{ color: outperform ? '#00ff80' : 'rgba(255,255,255,0.35)' }}>
          Diferença: {fmtPct(finalPnl - finalMarket)}
        </span>
      </div>
    </div>
  );
}