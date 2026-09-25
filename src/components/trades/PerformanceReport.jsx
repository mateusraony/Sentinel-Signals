import React, { useMemo } from 'react';
import { TrendingUp, TrendingDown, Target, Activity, AlertTriangle, Award } from 'lucide-react';
import { summarizeOps } from '@/lib/tradeMetrics';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

// Achado M-6 do Raio-X: os cards de métrica aqui não tinham tooltip
// nenhum, diferente dos equivalentes em Backtest.jsx/MonthlyReport.jsx
// (prop `tooltip` opcional, mesmo molde). Só Profit Factor reaproveita
// texto já validado nos 2 irmãos — os outros 5 cards não têm precedente
// de tooltip em nenhuma tela do projeto.
function MetricCard({ icon: Icon, label, value, sublabel, color, glowColor, tooltip = undefined }) {
  return (
    <div className="rounded-xl p-4 relative overflow-hidden"
      style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full opacity-10"
        style={{ background: `radial-gradient(circle, ${glowColor}, transparent 70%)`, transform: 'translate(30%, -30%)' }} />
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4" style={{ color }} />
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger type="button" className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground cursor-help underline decoration-dotted underline-offset-2">
              {label}
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-[10px] font-mono normal-case tracking-normal leading-relaxed">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</span>
        )}
      </div>
      <div className="text-2xl font-bold font-mono" style={{ color }}>{value}</div>
      {sublabel && <div className="text-[9px] font-mono text-muted-foreground mt-1">{sublabel}</div>}
    </div>
  );
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
  const pfHealthy = pf === null ? metrics.wins > 0 : pf >= 1.5;
  const pfMarginal = pf !== null && pf >= 1 && pf < 1.5;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Award className="w-4 h-4" style={{ color: '#00e5ff' }} />
        <h2 className="text-base font-bold text-foreground/80">Relatório de Performance</h2>
        <span className="text-[10px] font-mono text-muted-foreground">({metrics.totalTrades} trades fechados)</span>
      </div>
      {/* Legenda única (não repetida por card, que quebrava o grid — achado
          da revisão pós-PR #396, docs/claude/ui-audit-criticos.md) */}
      <p className="text-[9px] font-mono text-muted-foreground/70">
        PnL Acumulado é soma % simples, não composta.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <MetricCard
          icon={TrendingUp}
          label="PnL Acumulado"
          value={fmtPct(metrics.totalPnl)}
          sublabel={`${metrics.wins}W · ${metrics.be}BE · ${metrics.losses}L`}
          color={metrics.totalPnl >= 0 ? '#00ff80' : '#ff1478'}
          glowColor={metrics.totalPnl >= 0 ? 'rgba(0,255,128,0.4)' : 'rgba(255,20,120,0.4)'}
        />
        <MetricCard
          icon={Target}
          label="Taxa de Acerto"
          value={`${metrics.winRate.toFixed(1)}%`}
          sublabel={`${metrics.wins}W · ${metrics.be}BE · ${metrics.losses}L de ${metrics.totalTrades}`}
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
          sublabel={pfHealthy ? '✓ Saudável' : pfMarginal ? '⚠ Marginal' : '✗ Baixo'}
          color={pfHealthy ? '#00ff80' : '#ff9f43'}
          glowColor={pfHealthy ? 'rgba(0,255,128,0.4)' : 'rgba(255,159,67,0.4)'}
          tooltip="Soma dos ganhos ÷ soma das perdas (valor absoluto). Acima de 1 = ganhos superam perdas no total; ≥ 1,5 é o piso considerado saudável aqui. '∞' quando não houve nenhuma perda na amostra."
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