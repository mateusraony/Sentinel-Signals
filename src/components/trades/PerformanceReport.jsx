import React, { useMemo } from 'react';
import { TrendingUp, TrendingDown, Target, Activity, AlertTriangle, Award } from 'lucide-react';
import { summarizeOps } from '@/lib/tradeMetrics';
import { MetricSummaryCard } from '@/components/MetricSummaryCard';
import { drawdownColor, winRateColor, profitFactorColor, profitFactorLabel, metricGlow } from '@/lib/metricColorRanges';

function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

export default function PerformanceReport({ trades }) {
  const metrics = useMemo(() => {
    const s = summarizeOps(trades);
    if (s.counted === 0) return { hasData: false };

    return {
      hasData: true,
      totalPnl: s.totalPnlPct,
      winRate: s.winRate,
      maxDrawdown: s.maxDrawdownPct,
      profitFactor: s.profitFactor,
      avgWin: s.avgWinPct,
      avgLoss: s.avgLossPct,
      totalTrades: s.counted,
      wins: s.wins,
      losses: s.losses,
      be: s.be,
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

  const pf = metrics.profitFactor;
  const pfDisplay = pf === null ? (metrics.wins > 0 ? '∞' : '—') : pf.toFixed(2);
  const pfColor = profitFactorColor(pf, metrics.wins > 0);
  const pfLabel = profitFactorLabel(pf, metrics.wins > 0);
  const wrColor = winRateColor(metrics.winRate);
  const ddColor = drawdownColor(metrics.maxDrawdown);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Award className="w-4 h-4" style={{ color: '#00e5ff' }} />
        <h2 className="text-base font-bold text-foreground/80">Relatório de Performance</h2>
        <span className="text-10px font-mono text-muted-foreground">({metrics.totalTrades} trades fechados)</span>
      </div>
      {/* Legenda única (não repetida por card, que quebrava o grid — achado
          da revisão pós-PR #396, docs/claude/ui-audit-criticos.md) */}
      <p className="text-9px font-mono text-muted-foreground/70">
        PnL Acumulado é soma % simples, não composta.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <MetricSummaryCard valueClassName="text-2xl"
          icon={TrendingUp}
          label="PnL Acumulado"
          value={fmtPct(metrics.totalPnl)}
          sublabel={`${metrics.wins}W · ${metrics.be}BE · ${metrics.losses}L`}
          color={metrics.totalPnl >= 0 ? '#00ff80' : '#ff1478'}
          glowColor={metrics.totalPnl >= 0 ? 'rgba(0,255,128,0.4)' : 'rgba(255,20,120,0.4)'}
        />
        <MetricSummaryCard valueClassName="text-2xl"
          icon={Target}
          label="Taxa de Acerto"
          value={`${metrics.winRate.toFixed(1)}%`}
          sublabel={`${metrics.wins}W · ${metrics.be}BE · ${metrics.losses}L de ${metrics.totalTrades}`}
          color={wrColor}
          glowColor={metricGlow(wrColor)}
        />
        <MetricSummaryCard valueClassName="text-2xl"
          icon={AlertTriangle}
          label="Drawdown Máx"
          value={`-${metrics.maxDrawdown.toFixed(2)}%`}
          sublabel="Pico → Fundo"
          color={ddColor}
          glowColor={metricGlow(ddColor)}
        />
        <MetricSummaryCard valueClassName="text-2xl"
          icon={Activity}
          label="Profit Factor"
          value={pfDisplay}
          sublabel={pfLabel}
          color={pfColor}
          glowColor={metricGlow(pfColor)}
          tooltip="Soma dos ganhos ÷ soma das perdas (valor absoluto). Acima de 1 = ganhos superam perdas no total; ≥ 1,5 é o piso considerado saudável aqui. '∞' quando não houve nenhuma perda na amostra."
        />
        <MetricSummaryCard valueClassName="text-2xl"
          icon={TrendingUp}
          label="Ganho Médio"
          value={fmtPct(metrics.avgWin)}
          sublabel="por trade vencedor"
          color="#00ff80"
          glowColor="rgba(0,255,128,0.4)"
        />
        <MetricSummaryCard valueClassName="text-2xl"
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