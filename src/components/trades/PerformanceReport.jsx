import React, { useMemo } from 'react';
import { TrendingUp, TrendingDown, Target, Activity, AlertTriangle, Award } from 'lucide-react';

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

function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function MetricCard({ icon: Icon, label, value, sublabel, color, glowColor }) {
  return (
    <div className="rounded-xl p-4 relative overflow-hidden"
      style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full opacity-10"
        style={{ background: `radial-gradient(circle, ${glowColor}, transparent 70%)`, transform: 'translate(30%, -30%)' }} />
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4" style={{ color }} />
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="text-2xl font-bold font-mono" style={{ color }}>{value}</div>
      {sublabel && <div className="text-[9px] font-mono text-muted-foreground mt-1">{sublabel}</div>}
    </div>
  );
}

export default function PerformanceReport({ trades }) {
  const metrics = useMemo(() => {
    const valid = trades
      .filter(op => calcPnl(op) !== null && op.created_date && op.closed_at)
      .sort((a, b) => new Date(a.created_date) - new Date(b.created_date));

    if (valid.length === 0) return { hasData: false };

    const pnls = valid.map(op => {
      const pnl = calcPnl(op);
      // Weight: 50% if TP1 hit but stopped on runner (BE), full otherwise
      let weight = 1;
      if (op.status === 'STOP_HIT' && op.tp1_hit) weight = 0.5;
      else if (op.status === 'INVALIDATED') weight = 0.5;
      return pnl * weight;
    });

    const totalPnl = pnls.reduce((sum, p) => sum + p, 0);
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const winRate = (wins.length / valid.length) * 100;

    const grossProfit = wins.reduce((sum, p) => sum + p, 0);
    const grossLoss = Math.abs(losses.reduce((sum, p) => sum + p, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

    // Max drawdown: largest peak-to-trough decline in cumulative P&L
    let cumulative = 0;
    let peak = 0;
    let maxDD = 0;
    for (const pnl of pnls) {
      cumulative += pnl;
      if (cumulative > peak) peak = cumulative;
      const dd = peak - cumulative;
      if (dd > maxDD) maxDD = dd;
    }

    return {
      hasData: true,
      totalPnl,
      winRate,
      maxDrawdown: maxDD,
      profitFactor,
      avgWin,
      avgLoss,
      totalTrades: valid.length,
      wins: wins.length,
      losses: losses.length,
    };
  }, [trades]);

  if (!metrics.hasData) {
    return (
      <div className="rounded-xl p-8 text-center"
        style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <Activity className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
        <p className="text-sm text-muted-foreground">Sem trades fechados para relatório.</p>
      </div>
    );
  }

  const pfDisplay = metrics.profitFactor >= 999 ? '∞' : metrics.profitFactor.toFixed(2);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Award className="w-4 h-4" style={{ color: '#00e5ff' }} />
        <h2 className="text-base font-bold text-foreground/80">Relatório de Performance</h2>
        <span className="text-[10px] font-mono text-muted-foreground">({metrics.totalTrades} trades fechados)</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <MetricCard
          icon={TrendingUp}
          label="PnL Acumulado"
          value={fmtPct(metrics.totalPnl)}
          sublabel={`${metrics.wins}W / ${metrics.losses}L`}
          color={metrics.totalPnl >= 0 ? '#00ff80' : '#ff1478'}
          glowColor={metrics.totalPnl >= 0 ? 'rgba(0,255,128,0.4)' : 'rgba(255,20,120,0.4)'}
        />
        <MetricCard
          icon={Target}
          label="Taxa de Acerto"
          value={`${metrics.winRate.toFixed(1)}%`}
          sublabel={`${metrics.wins} acertos de ${metrics.totalTrades}`}
          color={metrics.winRate >= 50 ? '#00ff80' : '#ff9f43'}
          glowColor={metrics.winRate >= 50 ? 'rgba(0,255,128,0.4)' : 'rgba(255,159,67,0.4)'}
        />
        <MetricCard
          icon={AlertTriangle}
          label="Drawdown Máx"
          value={`-${metrics.maxDrawdown.toFixed(2)}%`}
          sublabel="Pico → Fundo"
          color="#ff1478"
          glowColor="rgba(255,20,120,0.4)"
        />
        <MetricCard
          icon={Activity}
          label="Profit Factor"
          value={pfDisplay}
          sublabel={metrics.profitFactor >= 1.5 ? '✓ Saudável' : metrics.profitFactor >= 1 ? '⚠ Marginal' : '✗ Baixo'}
          color={metrics.profitFactor >= 1.5 ? '#00ff80' : '#ff9f43'}
          glowColor={metrics.profitFactor >= 1.5 ? 'rgba(0,255,128,0.4)' : 'rgba(255,159,67,0.4)'}
        />
        <MetricCard
          icon={TrendingUp}
          label="Ganho Médio"
          value={fmtPct(metrics.avgWin)}
          sublabel="por trade vencedor"
          color="#00ff80"
          glowColor="rgba(0,255,128,0.4)"
        />
        <MetricCard
          icon={TrendingDown}
          label="Perda Média"
          value={fmtPct(-metrics.avgLoss)}
          sublabel="por trade perdedor"
          color="#ff1478"
          glowColor="rgba(255,20,120,0.4)"
        />
      </div>
    </div>
  );
}