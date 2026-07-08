import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Crown, Swords, TrendingUp, TrendingDown } from 'lucide-react';
import { fetch24hStats } from '@/lib/marketDataProvider';

function fmt(price) {
  if (!price && price !== 0) return '—';
  if (price >= 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function dirCfg(dir) {
  if (dir === 1) return { icon: '▲', color: '#00ff80', label: 'Bull' };
  if (dir === -1) return { icon: '▼', color: '#ff1478', label: 'Bear' };
  return { icon: '—', color: '#64748b', label: 'Neu' };
}

function computeOpportunity(states, signal, tradeOp) {
  let score = 0;
  const reasons = [];

  const tfs = ['1h', '4h', '1d'];
  const dirs = tfs.map(tf => states.find(s => s.timeframe === tf)?.rf_direction).filter(d => d !== undefined && d !== 0);
  const allAligned = dirs.length >= 2 && dirs.every(d => d === dirs[0]);
  if (allAligned) { score += 25; reasons.push('TFs alinhados'); }

  if (signal) { score += 30; reasons.push('Sinal RF ativo'); }

  const sigScore = signal?.context?.score || tradeOp?.score || 0;
  if (sigScore >= 85) { score += 15; reasons.push(`Score ${sigScore}`); }
  else if (sigScore >= 75) { score += 8; }

  const TERMINAL = ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'];
  const hasActive = tradeOp && !TERMINAL.includes(tradeOp.status);
  if (!hasActive && signal) { score += 10; reasons.push('Pronto para entrada'); }
  if (hasActive) { score -= 15; reasons.push('Já em operação'); }

  const state1h = states.find(s => s.timeframe === '1h');
  if (state1h?.rsi_zone === 'oversold' && signal?.signal_type === 'BUY') { score += 5; reasons.push('RSI sobrevenda'); }
  if (state1h?.rsi_zone === 'overbought' && signal?.signal_type === 'SELL') { score += 5; reasons.push('RSI sobrecompra'); }

  return { score, reasons, hasActive };
}

function MetricRow({ label, value, color }) {
  return (
    <div className="flex items-center justify-between py-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
      <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">{label}</span>
      <span className="text-[10px] font-mono font-semibold" style={{ color: color || 'rgba(255,255,255,0.7)' }}>
        {value}
      </span>
    </div>
  );
}

function CompareColumn({ asset, states, signal, tradeOp, stats, opp, isWinner, label }) {
  const TERMINAL = ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'];
  const hasActive = tradeOp && !TERMINAL.includes(tradeOp.status);
  const price = states.find(s => s.timeframe === '1h')?.last_close || states[0]?.last_close;
  const change = stats?.priceChangePercent;
  const score = signal?.context?.score || tradeOp?.score || 0;
  const sigSide = signal?.signal_type || tradeOp?.side;

  const winnerBorder = isWinner ? 'rgba(0,255,128,0.35)' : 'rgba(255,255,255,0.06)';
  const winnerGlow = isWinner ? '0 0 20px rgba(0,255,128,0.08)' : 'none';

  return (
    <div className="rounded-xl p-4 relative overflow-hidden transition-all"
      style={{ background: 'rgba(10,13,22,0.82)', backdropFilter: 'blur(20px)', border: `1px solid ${winnerBorder}`, boxShadow: winnerGlow }}>

      {isWinner && (
        <div className="absolute top-0 right-0 px-2.5 py-1 rounded-bl-lg flex items-center gap-1"
          style={{ background: 'rgba(0,255,128,0.12)', borderLeft: '1px solid rgba(0,255,128,0.25)', borderBottom: '1px solid rgba(0,255,128,0.25)' }}>
          <Crown className="w-3 h-3" style={{ color: '#00ff80' }} />
          <span className="text-[9px] font-mono font-bold" style={{ color: '#00ff80' }}>Melhor</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(0,229,255,0.1)', color: '#00e5ff', border: '1px solid rgba(0,229,255,0.2)' }}>
          {label}
        </span>
        <span className="font-bold text-sm text-foreground">{asset.display_name}</span>
      </div>

      {/* Price + 24h */}
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="text-lg font-bold font-mono text-foreground">${fmt(price)}</div>
          {change !== undefined && (
            <div className="text-[11px] font-mono" style={{ color: change >= 0 ? '#00ff80' : '#ff1478' }}>
              {change >= 0 ? '+' : ''}{change.toFixed(2)}% 24h
            </div>
          )}
        </div>
        {sigSide && (
          <span className="flex items-center gap-1 text-xs font-mono font-bold px-3 py-1.5 rounded-lg"
            style={sigSide === 'BUY'
              ? { background: 'rgba(0,255,128,0.15)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.4)' }
              : { background: 'rgba(255,20,120,0.15)', color: '#ff1478', border: '1px solid rgba(255,20,120,0.4)' }}>
            {sigSide === 'BUY' ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            {sigSide}
          </span>
        )}
      </div>

      {/* TF Alignment */}
      <div className="mb-3">
        <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider mb-1.5">Tendência Multi-TF</div>
        <div className="flex items-center gap-2">
          {['1h', '4h', '1d'].map(tf => {
            const s = states.find(st => st.timeframe === tf);
            const d = dirCfg(s?.rf_direction);
            return (
              <div key={tf} className="flex-1 text-center rounded-lg py-2"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.04)' }}>
                <div className="text-[8px] font-mono text-muted-foreground">{tf.toUpperCase()}</div>
                <div className="text-sm font-mono font-bold" style={{ color: d.color }}>{d.icon}</div>
                <div className="text-[8px] font-mono" style={{ color: d.color }}>{d.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Indicators */}
      <div className="rounded-lg px-3 py-1 mb-3" style={{ background: 'rgba(255,255,255,0.02)' }}>
        {(() => {
          const s1h = states.find(s => s.timeframe === '1h');
          const s4h = states.find(s => s.timeframe === '4h');
          return (
            <>
              <MetricRow label="RF Valor (4h)" value={s4h ? `$${fmt(s4h.rf_filter_value)}` : '—'} color="rgba(0,229,255,0.7)" />
              <MetricRow label="RSI (1h)" value={s1h?.rsi_value ? s1h.rsi_value.toFixed(0) : '—'}
                color={s1h?.rsi_zone === 'overbought' ? '#ff1478' : s1h?.rsi_zone === 'oversold' ? '#00ff80' : 'rgba(255,255,255,0.7)'} />
              <MetricRow label="MACD Hist" value={s1h?.macd_histogram !== undefined ? (s1h.macd_histogram > 0 ? '▲ Pos' : '▼ Neg') : '—'}
                color={s1h?.macd_histogram > 0 ? '#00ff80' : s1h?.macd_histogram < 0 ? '#ff1478' : '#64748b'} />
              <MetricRow label="EMA Trend" value={s1h?.trend_ema === 'bullish' ? '▲ Bull' : s1h?.trend_ema === 'bearish' ? '▼ Bear' : '— Neu'}
                color={s1h?.trend_ema === 'bullish' ? '#00ff80' : s1h?.trend_ema === 'bearish' ? '#ff1478' : '#64748b'} />
              <MetricRow label="Score" value={score > 0 ? `${score}/100` : '—'}
                color={score >= 85 ? '#00ff80' : score >= 75 ? '#ffd166' : 'rgba(255,255,255,0.5)'} />
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }} />
              <MetricRow label="Trade" value={hasActive ? `${tradeOp.status}` : signal ? 'Aguardando' : 'Livre'}
                color={hasActive ? '#00e5ff' : signal ? '#ffd166' : '#64748b'} />
            </>
          );
        })()}
      </div>

      {/* Opportunity score */}
      <div className="rounded-lg px-3 py-2.5" style={{ background: isWinner ? 'rgba(0,255,128,0.06)' : 'rgba(255,255,255,0.02)', border: `1px solid ${isWinner ? 'rgba(0,255,128,0.15)' : 'rgba(255,255,255,0.04)'}` }}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">Oportunidade</span>
          <span className="text-lg font-bold font-mono" style={{ color: opp.score >= 50 ? '#00ff80' : opp.score >= 25 ? '#ffd166' : '#64748b' }}>
            {opp.score}
          </span>
        </div>
        {opp.reasons.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {opp.reasons.map((r, i) => (
              <span key={i} className="text-[8px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(0,255,128,0.08)', color: 'rgba(0,255,128,0.7)', border: '1px solid rgba(0,255,128,0.12)' }}>
                {r}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ComparePanel({ assetA, assetB, statesA, statesB, signalA, signalB, opA, opB }) {
  const { data: statsA } = useQuery({
    queryKey: ['24h-stats', assetA.symbol],
    queryFn: () => fetch24hStats(assetA.symbol),
    staleTime: 30000,
  });
  const { data: statsB } = useQuery({
    queryKey: ['24h-stats', assetB.symbol],
    queryFn: () => fetch24hStats(assetB.symbol),
    staleTime: 30000,
  });

  const oppA = computeOpportunity(statesA, signalA, opA);
  const oppB = computeOpportunity(statesB, signalB, opB);
  const winner = oppA.score > oppB.score ? 'A' : oppB.score > oppA.score ? 'B' : null;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Swords className="w-4 h-4" style={{ color: '#00e5ff' }} />
        <h2 className="text-base font-bold text-foreground">Comparação Lado-a-Lado</h2>
        {winner && (
          <span className="text-[10px] font-mono px-2.5 py-1 rounded-lg flex items-center gap-1"
            style={{ background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.25)', color: '#00ff80' }}>
            <Crown className="w-3 h-3" />
            {winner === 'A' ? assetA.display_name : assetB.display_name}
          </span>
        )}
      </div>

      {/* Columns */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CompareColumn asset={assetA} states={statesA} signal={signalA} tradeOp={opA} stats={statsA} opp={oppA} isWinner={winner === 'A'} label="A" />
        <CompareColumn asset={assetB} states={statesB} signal={signalB} tradeOp={opB} stats={statsB} opp={oppB} isWinner={winner === 'B'} label="B" />
      </div>
    </div>
  );
}