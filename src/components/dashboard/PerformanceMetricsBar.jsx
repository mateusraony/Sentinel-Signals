import React, { useMemo } from 'react';
import { TrendingUp, TrendingDown, Target, Shield, BarChart2, Zap } from 'lucide-react';

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

function MetricCard({ icon: Icon, label, value, sub, color, glowColor }) {
  return (
    <div className="flex items-center gap-3 rounded-xl px-4 py-3 flex-1 min-w-0"
      style={{
        background: 'rgba(10,13,22,0.85)',
        border: `1px solid ${glowColor ?? 'rgba(255,255,255,0.06)'}`,
        boxShadow: glowColor ? `0 0 20px ${glowColor}` : 'none',
        backdropFilter: 'blur(16px)',
      }}>
      <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
        style={{ background: `${color}18`, border: `1px solid ${color}30` }}>
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <div className="min-w-0">
        <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground leading-none mb-1">{label}</div>
        <div className="text-lg font-bold font-mono leading-none truncate" style={{ color }}>{value}</div>
        {sub && <div className="text-[9px] font-mono mt-0.5 truncate" style={{ color: 'rgba(255,255,255,0.3)' }}>{sub}</div>}
      </div>
    </div>
  );
}

export default function PerformanceMetricsBar({ tradeOps }) {
  const metrics = useMemo(() => {
    const CLOSED = ['TP2_HIT', 'STOP_HIT', 'INVALIDATED', 'CLOSED'];
    const closed = (tradeOps || []).filter(o => CLOSED.includes(o.status));

    if (closed.length === 0) return null;

    // P&L acumulado
    let totalPnl = 0;
    let running = 0;
    let peak = 0;
    let maxDrawdown = 0;
    let wins = 0, losses = 0, be = 0;
    let winPnlSum = 0, lossPnlSum = 0;

    const sorted = [...closed].sort((a, b) => new Date(a.created_date) - new Date(b.created_date));

    sorted.forEach(op => {
      const pnl = calcPnl(op);
      if (pnl === null) return;
      running += pnl;
      totalPnl = running;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDrawdown) maxDrawdown = dd;
      const isBE = op.status === 'STOP_HIT' && op.tp1_hit;
      if (op.status === 'TP2_HIT') { wins++; winPnlSum += pnl; }
      else if (op.status === 'STOP_HIT' && !isBE) { losses++; lossPnlSum += Math.abs(pnl); }
      else be++;
    });

    const total = wins + losses + be;
    const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
    const avgWin = wins > 0 ? (winPnlSum / wins) : 0;
    const avgLoss = losses > 0 ? (lossPnlSum / losses) : 0;
    const rr = avgLoss > 0 ? (avgWin / avgLoss) : null;

    const active = (tradeOps || []).filter(o => ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'].includes(o.status));

    return { totalPnl, maxDrawdown, winRate, wins, losses, be, total, avgWin, avgLoss, rr, activeCount: active.length };
  }, [tradeOps]);

  if (!metrics) return null;

  const { totalPnl, maxDrawdown, winRate, wins, losses, be, total, avgWin, avgLoss, rr, activeCount } = metrics;

  const pnlColor = totalPnl >= 0 ? '#00ff80' : '#ff1478';
  const pnlGlow = totalPnl >= 0 ? 'rgba(0,255,128,0.06)' : 'rgba(255,20,120,0.06)';
  const wrColor = winRate >= 60 ? '#00ff80' : winRate >= 45 ? '#ffd166' : '#ff1478';
  const ddColor = maxDrawdown > 15 ? '#ff1478' : maxDrawdown > 8 ? '#ff9f43' : '#00ff80';

  return (
    <div className="rounded-2xl p-4"
      style={{ background: 'rgba(6,8,15,0.7)', border: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(20px)' }}>
      {/* Section label */}
      <div className="flex items-center gap-2 mb-3">
        <BarChart2 className="w-3.5 h-3.5" style={{ color: '#00e5ff' }} />
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Performance Real</span>
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
          {total} trades fechados
        </span>
        {activeCount > 0 && (
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1"
            style={{ background: 'rgba(0,255,128,0.08)', border: '1px solid rgba(0,255,128,0.2)', color: '#00ff80' }}>
            <Zap className="w-2.5 h-2.5" />{activeCount} ativas
          </span>
        )}
      </div>

      {/* Metric grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <MetricCard
          icon={totalPnl >= 0 ? TrendingUp : TrendingDown}
          label="P&L Acumulado"
          value={`${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%`}
          sub={`${wins}W · ${be}BE · ${losses}L`}
          color={pnlColor}
          glowColor={pnlGlow}
        />
        <MetricCard
          icon={Target}
          label="Win Rate"
          value={`${winRate}%`}
          sub={`Avg win +${avgWin.toFixed(1)}% / loss -${avgLoss.toFixed(1)}%`}
          color={wrColor}
          glowColor={winRate >= 60 ? 'rgba(0,255,128,0.05)' : undefined}
        />
        <MetricCard
          icon={Shield}
          label="Max Drawdown"
          value={`-${maxDrawdown.toFixed(2)}%`}
          sub={maxDrawdown < 5 ? 'Risco controlado ✓' : maxDrawdown < 15 ? 'Atenção moderada' : 'Drawdown alto ⚠️'}
          color={ddColor}
          glowColor={maxDrawdown > 15 ? 'rgba(255,20,120,0.06)' : undefined}
        />
        <MetricCard
          icon={BarChart2}
          label="Risk/Reward"
          value={rr !== null ? `${rr.toFixed(2)}:1` : '—'}
          sub={rr !== null ? (rr >= 2 ? 'Excelente R:R ✓' : rr >= 1.5 ? 'Bom R:R' : 'R:R abaixo do ideal') : 'Dados insuficientes'}
          color={rr !== null ? (rr >= 2 ? '#00ff80' : rr >= 1.5 ? '#ffd166' : '#ff9f43') : '#64748b'}
        />
      </div>
    </div>
  );
}