import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { TrendingUp, TrendingDown, Zap } from 'lucide-react';
import { fetch24hStats } from '@/lib/marketDataProvider';
import { base44 } from '@/api/base44Client';
import moment from 'moment';
import ProximityBar from '@/components/dashboard/ProximityBar';

function fmt(price) {
  if (!price && price !== 0) return '—';
  if (price >= 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.001) return price.toFixed(4);
  return price.toFixed(6);
}

function Dot({ color, filled = true }) {
  return (
    <span style={{
      display: 'inline-block', width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
      background: filled ? color : 'transparent',
      border: `1.5px solid ${color}`,
      boxShadow: filled ? `0 0 4px ${color}80` : 'none',
    }} />
  );
}

function IndicatorDots({ state }) {
  if (!state) return null;
  const rfDir = state.rf_direction;
  const rfColor = rfDir === 1 ? '#00ff80' : rfDir === -1 ? '#ff1478' : '#64748b';
  const rfLabel = rfDir === 1 ? 'Bull' : rfDir === -1 ? 'Bear' : 'Neu';
  const macdH = state.macd_histogram || 0;
  const macdColor = macdH > 0 ? '#00ff80' : macdH < 0 ? '#ff1478' : '#64748b';
  const emaTrend = state.trend_ema;
  const emaColor = emaTrend === 'bullish' ? '#00ff80' : emaTrend === 'bearish' ? '#ff1478' : '#ffd166';
  const rsiZone = state.rsi_zone;
  const rsiColor = rsiZone === 'overbought' ? '#ff1478' : rsiZone === 'oversold' ? '#00ff80' : '#64748b';
  const rsiVal = state.rsi_value ? state.rsi_value.toFixed(0) : '—';

  return (
    <div className="flex items-center gap-3 sm:gap-2 flex-wrap">
      <span className="flex items-center gap-1">
        <Dot color={rfColor} />
        <span className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>RF</span>
        <span className="text-[10px] font-mono font-semibold" style={{ color: rfColor }}>{rfLabel}</span>
      </span>
      <span className="flex items-center gap-1">
        <Dot color={macdColor} />
        <span className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>MACD</span>
        <span className="text-[10px] font-mono" style={{ color: macdColor }}>{macdH > 0 ? '▲' : macdH < 0 ? '▼' : '—'}</span>
      </span>
      <span className="flex items-center gap-1">
        <Dot color={emaColor} />
        <span className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>EMA</span>
        <span className="text-[10px] font-mono" style={{ color: emaColor }}>{emaTrend === 'bullish' ? '▲' : emaTrend === 'bearish' ? '▼' : '—'}</span>
      </span>
      <span className="flex items-center gap-1">
        <Dot color={rsiColor} filled={rsiZone !== 'neutral'} />
        <span className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>RSI</span>
        <span className="text-[10px] font-mono" style={{ color: rsiColor }}>{rsiVal}</span>
      </span>
    </div>
  );
}

/** Multi-TF trend mini row — shown as subtle overlay on hover */
function TFTrendRow({ states }) {
  const tfs = ['1h', '4h', '1d'];
  return (
    <div className="flex items-center gap-2.5 flex-wrap">
      {tfs.map(tf => {
        const s = states?.find(st => st.timeframe === tf);
        if (!s) return (
          <span key={tf} className="text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.18)' }}>
            {tf.toUpperCase()} —
          </span>
        );
        const dir = s.rf_direction;
        const color = dir === 1 ? '#00ff80' : dir === -1 ? '#ff1478' : '#64748b';
        const arrow = dir === 1 ? '▲' : dir === -1 ? '▼' : '—';
        const label = dir === 1 ? 'Bull' : dir === -1 ? 'Bear' : 'Neu';
        return (
          <span key={tf} className="flex items-center gap-0.5 text-[9px] font-mono">
            <span style={{ color: 'rgba(255,255,255,0.3)' }}>{tf.toUpperCase()}</span>
            <span style={{ color }}>{arrow}{label}</span>
          </span>
        );
      })}
    </div>
  );
}

export default function AssetCard({ asset, states, latestSignal, tradeOp, onClick }) {
  const queryClient = useQueryClient();
  const availableTfs = states?.map(s => s.timeframe).filter(Boolean) || [];
  const defaultTf = availableTfs.includes('1h') ? '1h' : availableTfs[0] || '1h';
  const [selectedTf, setSelectedTf] = useState(defaultTf);
  const state1h = states?.find(s => s.timeframe === '1h');
  const state4h = states?.find(s => s.timeframe === '4h');
  const primaryState = states?.find(s => s.timeframe === selectedTf) || state1h || state4h || states?.[0];

  const { data: stats24h } = useQuery({
    queryKey: ['24h-stats', asset.symbol],
    queryFn: () => fetch24hStats(asset.symbol),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // "Activate signal" mutation — creates a TradeOperation from the signal
  const activateMutation = useMutation({
    mutationFn: (sig) => base44.entities.TradeOperation.create({
      symbol: sig.symbol,
      asset_id: sig.asset_id,
      timeframe: sig.timeframe,
      side: sig.signal_type,
      status: 'SIGNAL_CONFIRMED',
      score: sig.context?.score || 0,
      entry_price: sig.price_at_signal,
      signal_reasons: sig.reason ? [sig.reason] : [],
      candle_status: 'CLOSED',
      data_status: 'LIVE',
      partial_percent: 50,
      runner_percent: 50,
      exit_mode: 'HYBRID_RF_ATR',
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trade-operations'] });
      queryClient.invalidateQueries({ queryKey: ['trade-operations-dashboard'] });
    },
  });

  const lastPrice = primaryState?.last_close;
  const priceChange = stats24h?.priceChangePercent;

  const lastScanMs = asset.last_scan_at ? Date.now() - new Date(asset.last_scan_at).getTime() : null;
  const isStale = lastScanMs && lastScanMs > 2 * 60 * 60 * 1000;

  const TERMINAL = ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'];
  const hasActiveOp = tradeOp && !TERMINAL.includes(tradeOp.status);
  const opSide = tradeOp?.side;
  const sigSide = latestSignal?.signal_type;
  const isBuy = (opSide || sigSide) === 'BUY';
  const isSell = (opSide || sigSide) === 'SELL';

  const score = tradeOp?.score || latestSignal?.context?.score || 0;

  // Flash animation
  const [flashing, setFlashing] = useState(false);
  const prevTradeOpId = useRef(null);
  useEffect(() => {
    if (hasActiveOp && tradeOp?.id !== prevTradeOpId.current) {
      const age = tradeOp?.created_date ? Date.now() - new Date(tradeOp.created_date).getTime() : Infinity;
      if (age < 5 * 60 * 1000) {
        setFlashing(true);
        const t = setTimeout(() => setFlashing(false), 4000);
        prevTradeOpId.current = tradeOp.id;
        return () => clearTimeout(t);
      }
      prevTradeOpId.current = tradeOp.id;
    }
  }, [tradeOp?.id, hasActiveOp]);

  // Signal flash for new signals without trade op (< 3min)
  const [sigFlashing, setSigFlashing] = useState(false);
  const prevSigId = useRef(null);
  useEffect(() => {
    if (latestSignal && !hasActiveOp && latestSignal.id !== prevSigId.current) {
      const age = latestSignal.created_date ? Date.now() - new Date(latestSignal.created_date).getTime() : Infinity;
      if (age < 3 * 60 * 1000) {
        setSigFlashing(true);
        const t = setTimeout(() => setSigFlashing(false), 3000);
        prevSigId.current = latestSignal.id;
        return () => clearTimeout(t);
      }
      prevSigId.current = latestSignal.id;
    }
  }, [latestSignal?.id, hasActiveOp]);

  let statusLabel = null;
  let statusColor = '#64748b';
  if (isStale) {
    statusLabel = '⚠️ STALE'; statusColor = '#ff9f43';
  } else if (hasActiveOp) {
    if (tradeOp.status === 'RUNNER_ACTIVE') { statusLabel = '⚡ Runner Ativo'; statusColor = '#00e5ff'; }
    else if (opSide === 'BUY') { statusLabel = '🟢 Compra Ativa'; statusColor = '#00ff80'; }
    else { statusLabel = '🔴 Venda Ativa'; statusColor = '#ff1478'; }
  } else if (latestSignal) {
    statusLabel = sigSide === 'BUY' ? '👀 Observando BUY' : '👀 Observando SELL';
    statusColor = sigSide === 'BUY' ? 'rgba(0,255,128,0.65)' : 'rgba(255,20,120,0.65)';
  }

  const showBadge = hasActiveOp ? opSide : (latestSignal ? sigSide : null);
  const strengthMap = { strong: '🔥 Forte', moderate: '⚡ Mod.', weak: '〰 Fraco' };
  const strengthLabel = strengthMap[latestSignal?.strength] || '⚡ Mod.';

  const candleCloseTime = primaryState?.last_candle_time;
  const candleOpen = candleCloseTime ? moment(candleCloseTime).utcOffset(-3).subtract(1, 'hour').format('DD/MM HH:mm') : null;
  const candleClose = candleCloseTime ? moment(candleCloseTime).utcOffset(-3).format('HH:mm') : null;

  // Border & glow
  let cardBorder = 'rgba(255,255,255,0.06)';
  let cardGlow = 'none';
  let flashStyle = '';
  if (flashing || sigFlashing) {
    const fc = isBuy ? '#00ff80' : '#ff1478';
    cardBorder = fc;
    cardGlow = `0 0 30px ${fc}60, 0 0 60px ${fc}30`;
    flashStyle = isBuy ? 'flash-buy' : 'flash-sell';
  } else if (hasActiveOp && isBuy) {
    cardBorder = 'rgba(0,255,128,0.22)'; cardGlow = '0 0 20px rgba(0,255,128,0.07)';
  } else if (hasActiveOp && isSell) {
    cardBorder = 'rgba(255,20,120,0.22)'; cardGlow = '0 0 20px rgba(255,20,120,0.07)';
  } else if (latestSignal && !hasActiveOp) {
    const bc = sigSide === 'BUY' ? 'rgba(0,255,128,0.12)' : 'rgba(255,20,120,0.12)';
    cardBorder = bc;
  } else if (isStale) {
    cardBorder = 'rgba(255,159,67,0.22)';
  }

  const priceVals = hasActiveOp
    ? [tradeOp.entry_price, tradeOp.initial_stop, tradeOp.tp1, tradeOp.tp2, tradeOp.current_stop]
    : [null, null, null, null, null];
  const priceColColors = [
    'rgba(255,255,255,0.75)', '#ff1478',
    tradeOp?.tp1_hit ? '#00ff80' : '#ffd166',
    tradeOp?.tp2_hit ? '#00ff80' : 'rgba(255,209,102,0.55)',
    tradeOp?.tp1_hit ? '#ffd166' : '#ff1478',
  ];

  const candleStatus = tradeOp?.candle_status || 'CLOSED';

  return (
    <>
      <style>{`
        @keyframes flash-buy { 0%,100%{box-shadow:0 0 20px rgba(0,255,128,0.07)} 50%{box-shadow:0 0 40px rgba(0,255,128,0.5),0 0 80px rgba(0,255,128,0.2)} }
        @keyframes flash-sell { 0%,100%{box-shadow:0 0 20px rgba(255,20,120,0.07)} 50%{box-shadow:0 0 40px rgba(255,20,120,0.5),0 0 80px rgba(255,20,120,0.2)} }
        .flash-buy { animation: flash-buy 0.8s ease-in-out 5; }
        .flash-sell { animation: flash-sell 0.8s ease-in-out 5; }
      `}</style>
      <div
        className={`rounded-xl p-4 relative overflow-hidden transition-all duration-300 cursor-pointer hover:scale-[1.01] ${flashStyle}`}
        onClick={onClick}
        style={{ background: 'rgba(10,13,22,0.82)', backdropFilter: 'blur(20px)', border: `1px solid ${cardBorder}`, boxShadow: cardGlow }}>

        {/* Row 1: Symbol + Price */}
        <div className="flex items-start justify-between mb-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-bold text-sm text-foreground tracking-tight">{asset.display_name}</span>
              <span className="text-[8px] font-mono text-muted-foreground">{asset.exchange?.toUpperCase() || 'BINANCE'}</span>
              <span className="flex items-center gap-0.5">
                <span style={{ width: 5, height: 5, borderRadius: '50%', display: 'inline-block', background: isStale ? '#ff9f43' : '#00ff80', boxShadow: isStale ? 'none' : '0 0 5px #00ff80' }} />
                <span className="text-[8px] font-mono" style={{ color: isStale ? '#ff9f43' : '#00ff80' }}>{isStale ? 'STALE' : 'LIVE'}</span>
              </span>
            </div>
            {/* TF Trend row — always visible, subtle */}
            <div className="mt-1">
              <TFTrendRow states={states} />
            </div>
            {candleCloseTime && (
              <div className="text-[8px] font-mono text-muted-foreground mt-0.5">🕐 {candleOpen} → {candleClose} BRT</div>
            )}
          </div>
          <div className="text-right shrink-0 ml-2">
            {lastPrice ? (
              <>
                <div className="font-bold font-mono text-sm text-foreground">${fmt(lastPrice)}</div>
                {priceChange !== undefined && priceChange !== null && (
                  <div className="text-[10px] font-mono" style={{ color: priceChange >= 0 ? '#00ff80' : '#ff1478' }}>
                    {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}%
                  </div>
                )}
              </>
            ) : <span className="text-xs text-muted-foreground">—</span>}
            <div className="text-[8px] font-mono mt-0.5" style={{ color: 'rgba(255,255,255,0.3)' }}>
              Score: <span style={{ color: score >= 85 ? '#00ff80' : score >= 65 ? '#ffd166' : '#ff9f43' }}>{score}</span>
            </div>
          </div>
        </div>

        {/* TF Quick Switcher — larger touch targets for mobile */}
        {availableTfs.length > 0 && (
          <div className="flex items-center gap-1.5 mb-2">
            {['1h','4h','1d'].filter(tf => availableTfs.includes(tf)).map(tf => {
              const tfState = states?.find(s => s.timeframe === tf);
              const rfDir = tfState?.rf_direction;
              const dirColor = rfDir === 1 ? '#00ff80' : rfDir === -1 ? '#ff1478' : null;
              const isSelected = selectedTf === tf;
              return (
                <button key={tf}
                  onClick={e => { e.stopPropagation(); setSelectedTf(tf); }}
                  className="flex items-center gap-1 text-xs font-mono font-bold px-3 py-1.5 rounded-lg transition-all hover:scale-105"
                  style={isSelected
                    ? { background: 'rgba(0,229,255,0.18)', border: '1px solid rgba(0,229,255,0.45)', color: '#00e5ff', minWidth: 44 }
                    : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.3)', minWidth: 44 }}>
                  {tf.toUpperCase()}
                  {dirColor && <span style={{ color: dirColor, fontSize: 10 }}>{rfDir === 1 ? '▲' : '▼'}</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* Signal badge + status — larger for touch, wraps gracefully on mobile */}
        <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            {showBadge && (
              <span className="flex items-center gap-1 text-sm font-mono font-bold px-4 py-1.5 rounded-lg"
                style={showBadge === 'BUY'
                  ? { background: 'rgba(0,255,128,0.15)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.4)', boxShadow: '0 0 12px rgba(0,255,128,0.15)' }
                  : { background: 'rgba(255,20,120,0.15)', color: '#ff1478', border: '1px solid rgba(255,20,120,0.4)', boxShadow: '0 0 12px rgba(255,20,120,0.15)' }}>
                {showBadge === 'BUY' ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                {showBadge}
              </span>
            )}
            {latestSignal && !hasActiveOp && (
              <span className="text-[10px] font-mono px-2 py-1 rounded"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.45)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {strengthLabel}
              </span>
            )}
          </div>
          {statusLabel && (
            <span className="text-[10px] font-mono font-semibold text-right" style={{ color: statusColor }}>{statusLabel}</span>
          )}
        </div>

        {/* Proximity indicator — yellow, shows when no signal/op but price near entry zone */}
        {!hasActiveOp && !latestSignal && primaryState && (
          <ProximityBar state={primaryState} />
        )}

        {/* Candle status */}
        {hasActiveOp && (
          <div className="text-[8px] font-mono mb-2" style={{ color: candleStatus === 'OPEN' ? '#ff9f43' : 'rgba(255,255,255,0.3)' }}>
            {candleStatus === 'OPEN' ? '⏳ Candle aberto — aguardando fechamento' : '✅ Candle fechado'}
          </div>
        )}

        <div className="mb-2.5" style={{ height: 1, background: 'rgba(255,255,255,0.05)' }} />
        <div className="mb-2.5"><IndicatorDots state={primaryState} /></div>

        {/* Price grid — responsive, scrollable on very small screens */}
        <div className="grid grid-cols-5 gap-1 mb-2.5 overflow-x-auto">
          {['Entrada', 'Stop', 'TP1', 'TP2', 'Stop+'].map((col, i) => (
            <div key={col} className="text-center px-1 py-1.5 rounded min-w-[48px]"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.04)' }}>
              <div className="text-[8px] font-mono text-muted-foreground mb-0.5 leading-tight truncate">{col}</div>
              <div className="text-[10px] font-mono font-semibold" style={{ color: priceVals[i] ? priceColColors[i] : 'rgba(255,255,255,0.15)' }}>
                {fmt(priceVals[i])}
              </div>
            </div>
          ))}
        </div>

        {/* Runner progress */}
        {hasActiveOp && tradeOp.status === 'RUNNER_ACTIVE' && (
          <div className="rounded-lg px-3 py-2 mb-2.5" style={{ background: 'rgba(0,229,255,0.05)', border: '1px solid rgba(0,229,255,0.15)' }}>
            <div className="flex items-center justify-between text-[9px] font-mono">
              <span style={{ color: '#00ff80' }}>✅ TP1 + {tradeOp.partial_percent || 50}% realizados</span>
              <span style={{ color: '#ffd166' }}>⚡ {tradeOp.runner_percent || 50}% em runner</span>
            </div>
          </div>
        )}

        {/* Activate button — only for signals without active op */}
        {latestSignal && !hasActiveOp && !isStale && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`Ativar operação ${sigSide} em ${asset.display_name}?`))
                activateMutation.mutate(latestSignal);
            }}
            disabled={activateMutation.isPending}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-mono font-bold mt-1 transition-all"
            style={sigSide === 'BUY'
              ? { background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }
              : { background: 'rgba(255,20,120,0.1)', border: '1px solid rgba(255,20,120,0.3)', color: '#ff1478' }}>
            <Zap className="w-3 h-3" />
            {activateMutation.isPending ? 'Ativando...' : `Ativar ${sigSide} agora`}
          </button>
        )}

        {/* Click hint */}
        <div className="absolute bottom-1.5 right-2.5 text-[7px] font-mono opacity-0 hover:opacity-100 transition-opacity" style={{ color: 'rgba(255,255,255,0.15)' }}>
          detalhes →
        </div>
      </div>
    </>
  );
}