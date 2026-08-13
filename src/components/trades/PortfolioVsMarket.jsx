import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import { TrendingUp, TrendingDown, Activity } from 'lucide-react';
import moment from 'moment';
import { getClosedAt, summarizeOps } from '@/lib/tradeMetrics';
import { BENCHMARK_OPTIONS } from '@/lib/marketBenchmarks';

function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

/**
 * Cumulative realized PnL % from closed trade operations (equal position size
 * per trade). The partial/runner split comes from the shared metrics module —
 * the old heuristic 0.5 weight and the mandatory exit_price filter are gone,
 * so legacy ops without exit_price now enter via the per-status fallback.
 */
function calcPortfolioCurve(trades) {
  return summarizeOps(trades)
    .curve
    .filter(p => p.pnlPct !== null)
    .map(({ op, pnlPct, cumulativePct }) => {
      const closedAt = getClosedAt(op);
      return {
        date: moment(closedAt).format('DD/MM HH:mm'),
        timestamp: new Date(closedAt).getTime(),
        tradePnl: pnlPct,
        portfolio: cumulativePct,
        symbol: op.symbol?.replace('USDT', '/USDT'),
        side: op.side,
        status: op.status,
      };
    });
}

/**
 * Fetch the selected benchmark's curve (src/lib/marketBenchmarks.js) and
 * normalize to % change over the same period as the trades. BTC keeps the
 * original behavior (Binance candles); CDI/Selic/IPCA come from the Banco
 * Central (BCB SGS, taxa acumulada via juros compostos) — same "fetch direct
 * from the browser, no backend" pattern as BTC already used.
 */
function useMarketBenchmark(benchmarkKey, firstTradeTs, lastTradeTs) {
  return useQuery({
    queryKey: ['market-benchmark', benchmarkKey, firstTradeTs, lastTradeTs],
    queryFn: async () => {
      const option = BENCHMARK_OPTIONS.find((o) => o.key === benchmarkKey) ?? BENCHMARK_OPTIONS[0];
      const curve = await option.fetchCurve(firstTradeTs, lastTradeTs);
      return curve.map((point) => ({ ...point, date: moment(point.timestamp).format('DD/MM HH:mm') }));
    },
    enabled: !!firstTradeTs && !!lastTradeTs,
    staleTime: 5 * 60 * 1000,
  });
}

/** @param {{ active?: boolean, payload?: Array<any>, marketLabel?: string }} props */
function CustomTooltip({ active, payload, marketLabel }) {
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
            {entry.name === 'portfolio' ? 'Minha Carteira' : entry.name === 'market' ? `${marketLabel} (Mercado)` : entry.name}
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
  const [benchmarkKey, setBenchmarkKey] = useState('BTC');
  const benchmarkOption = BENCHMARK_OPTIONS.find((o) => o.key === benchmarkKey) ?? BENCHMARK_OPTIONS[0];
  const portfolioCurve = useMemo(() => calcPortfolioCurve(trades), [trades]);

  const firstTs = portfolioCurve[0]?.timestamp;
  const lastTs = portfolioCurve[portfolioCurve.length - 1]?.timestamp;
  const { data: marketCurve = [], isFetching: marketFetching } = useMarketBenchmark(benchmarkKey, firstTs, lastTs);

  // Merge portfolio and market data by "as-of" timestamp — never a future one.
  const mergedData = useMemo(() => {
    if (portfolioCurve.length === 0) return [];

    // Codex review (PR #108, P2): pick the LATEST market point at-or-before
    // this trade's timestamp, not just the nearest by absolute distance — a
    // trade late in a month could otherwise be matched to next month's IPCA
    // observation (sparse monthly series), showing data from the future.
    return portfolioCurve.map(p => {
      let latestMarket = null;
      for (const m of marketCurve) {
        if (m.timestamp <= p.timestamp && (!latestMarket || m.timestamp > latestMarket.timestamp)) {
          latestMarket = m;
        }
      }
      return {
        ...p,
        market: latestMarket?.market ?? null,
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
          É necessário pelo menos 2 trades fechados com resultado calculável.
        </p>
      </div>
    );
  }

  const finalPnl = portfolioCurve[portfolioCurve.length - 1]?.portfolio || 0;
  const lastMarketPoint = mergedData[mergedData.length - 1]?.market;
  // Codex review (PR #108, P2): a pending/failed/empty benchmark query used
  // to fall through `|| 0`, rendering as a real "+0.00%" and letting the
  // portfolio look like it's "Superando" a benchmark that never actually
  // loaded — routine for IPCA when the filtered trades fall between its
  // monthly observation dates. Track availability explicitly instead of
  // treating absence as a flat 0% benchmark.
  const hasMarketData = lastMarketPoint !== null && lastMarketPoint !== undefined;
  const finalMarket = hasMarketData ? lastMarketPoint : 0;
  const outperform = hasMarketData && finalPnl > finalMarket;

  return (
    <div className="rounded-xl p-4"
      style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(255,255,255,0.06)' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4" style={{ color: '#00e5ff' }} />
          <h3 className="text-sm font-bold text-foreground">Carteira vs Mercado ({benchmarkOption.label})</h3>
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
            <span style={{ color: 'rgba(255,255,255,0.5)' }}>{benchmarkOption.label}</span>
            <span className="font-bold" style={{ color: !hasMarketData ? 'rgba(255,255,255,0.3)' : finalMarket >= 0 ? '#00ff80' : '#ff1478' }}>
              {marketFetching ? '…' : hasMarketData ? fmtPct(finalMarket) : '—'}
            </span>
          </span>
          {outperform && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded"
              style={{ background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.25)', color: '#00ff80' }}>
              <TrendingUp className="w-3 h-3" /> Superando
            </span>
          )}
          {hasMarketData && !outperform && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded"
              style={{ background: 'rgba(255,20,120,0.1)', border: '1px solid rgba(255,20,120,0.25)', color: '#ff1478' }}>
              <TrendingDown className="w-3 h-3" /> Atrás
            </span>
          )}
        </div>
      </div>

      {/* Benchmark selector */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        {BENCHMARK_OPTIONS.map((option) => (
          <button key={option.key} onClick={() => setBenchmarkKey(option.key)}
            className="text-[10px] font-mono px-2.5 py-1 rounded-md transition-all"
            style={benchmarkKey === option.key
              ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(0,229,255,0.9)' }
              : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
            {option.label}
          </button>
        ))}
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
          <Tooltip content={<CustomTooltip marketLabel={benchmarkOption.label} />} />
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