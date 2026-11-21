import React, { useMemo } from 'react';
import { TrendingUp, TrendingDown, Target, Activity, AlertTriangle } from 'lucide-react';
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
      <div className="glass-card rounded-md p-8 text-center">
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
        <span aria-hidden="true" style={{ width: 3, height: 16, borderRadius: 2, background: '#8db4e2', display: 'inline-block' }} />
        <h2 className="text-sm font-semibold text-foreground">Relatório de Performance</h2>
        <span className="text-xs font-mono text-muted-foreground">({metrics.totalTrades} trades fechados)</span>
      </div>
      {/* Legenda única (não repetida por card, que quebrava o grid — achado
          da revisão pós-PR #396, docs/claude/ui-audit-criticos.md) */}
      <p className="text-xs text-muted-foreground">
        PnL Acumulado é soma % simples, não composta.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <MetricSummaryCard flat valueClassName="text-2xl"
          icon={TrendingUp}
          label="PnL Acumulado"
          value={fmtPct(metrics.totalPnl)}
          sublabel={`${metrics.wins}W · ${metrics.be}BE · ${metrics.losses}L`}
          color={metrics.totalPnl >= 0 ? '#5db586' : '#e06a5b'}
          glowColor={metrics.totalPnl >= 0 ? 'rgba(93,181,134,0.4)' : 'rgba(224,106,91,0.4)'}
        />
        <MetricSummaryCard flat valueClassName="text-2xl"
          icon={Target}
          label="Taxa de Acerto"
          value={`${metrics.winRate.toFixed(1)}%`}
          sublabel={`${metrics.wins}W · ${metrics.be}BE · ${metrics.losses}L de ${metrics.totalTrades}`}
          color={wrColor}
          glowColor={metricGlow(wrColor)}
        />
        <MetricSummaryCard flat valueClassName="text-2xl"
          icon={AlertTriangle}
          label="Drawdown Máx"
          value={`-${metrics.maxDrawdown.toFixed(2)}%`}
          sublabel="Pico → Fundo"
          color={ddColor}
          glowColor={metricGlow(ddColor)}
        />
        <MetricSummaryCard flat valueClassName="text-2xl"
          icon={Activity}
          label="Profit Factor"
          value={pfDisplay}
          sublabel={pfLabel}
          color={pfColor}
          glowColor={metricGlow(pfColor)}
          tooltip="Soma dos ganhos ÷ soma das perdas (valor absoluto). Acima de 1 = ganhos superam perdas no total; ≥ 1,5 é o piso considerado saudável aqui. '∞' quando não houve nenhuma perda na amostra."
        />
        <MetricSummaryCard flat valueClassName="text-2xl"
          icon={TrendingUp}
          label="Ganho Médio"
          value={fmtPct(metrics.avgWin)}
          sublabel="por trade vencedor"
          color="#5db586"
          glowColor="rgba(93,181,134,0.4)"
        />
        <MetricSummaryCard flat valueClassName="text-2xl"
          icon={TrendingDown}
          label="Perda Média"
          value={fmtPct(-metrics.avgLoss)}
          sublabel="por trade perdedor"
          color="#e06a5b"
          glowColor="rgba(224,106,91,0.4)"
        />
      </div>
    </div>
  );
}