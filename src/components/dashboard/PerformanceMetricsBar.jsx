import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp, TrendingDown, Target, Shield, BarChart2, Zap } from 'lucide-react';
import { backend } from '@/api/entities';
import { summarizeOps } from '@/lib/tradeMetrics';
import { POLL_DIAGNOSTIC_MS } from '@/lib/pollingIntervals';

function MetricCard({ icon: Icon, label, value, sub, color, glowColor = undefined }) {
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

// Mesma queryKey/teto de VirtualAccountCard.jsx e LiveConfidenceCard.jsx —
// os 4 cards de performance do Dashboard precisam concordar sobre a mesma
// amostra de operações (achado C-2 do Raio-X de UI/UX,
// docs/claude/ui-audit-criticos.md). Antes deste componente recebia
// `tradeOps` via prop (a lista de 100 operações recentes do Dashboard, sem
// filtro de status) — com mais de 100 operações no histórico, os números
// podiam divergir dos de VirtualAccountCard/LiveConfidenceCard. O React
// Query reaproveita o cache desta queryKey, sem requisição extra.
//
// `activeOpsCount` vem via prop (calculado em Dashboard.jsx a partir do
// tradeOps de 100 itens, ACTIVE_STATUSES) — não deriva da query de 500 deste
// componente. As duas queries têm teto/cadência de refetch diferentes; se o
// badge "N ativas" derivasse da de 500, ele podia divergir por até ~2min do
// StatsCard "Operações Ativas" do próprio Dashboard, visível na mesma tela
// (achado da revisão pós-PR #396, docs/claude/ui-audit-criticos.md).
export default function PerformanceMetricsBar({ activeOpsCount = 0 }) {
  const { data: tradeOps = [] } = useQuery({
    queryKey: ['trade-operations-closed-all'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', 500),
    refetchInterval: POLL_DIAGNOSTIC_MS,
  });

  const metrics = useMemo(() => {
    const s = summarizeOps(tradeOps);
    if (s.counted === 0) return null;

    const rr = s.avgLossPct > 0 ? s.avgWinPct / s.avgLossPct : null;

    return {
      totalPnl: s.totalPnlPct,
      maxDrawdown: s.maxDrawdownPct,
      winRate: Math.round(s.winRate),
      wins: s.wins,
      losses: s.losses,
      be: s.be,
      total: s.counted,
      avgWin: s.avgWinPct,
      avgLoss: s.avgLossPct,
      expectancyR: s.expectancyR,
      rr,
    };
  }, [tradeOps]);

  if (!metrics) return null;

  const { totalPnl, maxDrawdown, winRate, wins, losses, be, total, avgWin, avgLoss, expectancyR, rr } = metrics;

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
        {activeOpsCount > 0 && (
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1"
            style={{ background: 'rgba(0,255,128,0.08)', border: '1px solid rgba(0,255,128,0.2)', color: '#00ff80' }}>
            <Zap className="w-2.5 h-2.5" />{activeOpsCount} ativas
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
          sub={expectancyR !== null
            ? `Expectância ${expectancyR >= 0 ? '+' : ''}${expectancyR.toFixed(2)}R · +${avgWin.toFixed(1)}%/-${avgLoss.toFixed(1)}%`
            : `Avg win +${avgWin.toFixed(1)}% / loss -${avgLoss.toFixed(1)}%`}
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