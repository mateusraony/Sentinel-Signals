import React from 'react';
import { TrendingUp, Target, Activity, Zap } from 'lucide-react';
import { summarizeOps } from '@/lib/tradeMetrics';

export default function PerformanceBar({ assets, tradeOps, recentSignals }) {
  const ACTIVE = ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'];

  const activeOps = tradeOps.filter(o => ACTIVE.includes(o.status));
  const perf = summarizeOps(tradeOps);
  const wins = perf.wins;
  const winRate = perf.counted > 0 ? Math.round(perf.winRate) : null;

  const buyOps = activeOps.filter(o => o.side === 'BUY').length;
  const sellOps = activeOps.filter(o => o.side === 'SELL').length;

  const signals24h = recentSignals.filter(s => {
    return Date.now() - new Date(s.created_date).getTime() < 24 * 60 * 60 * 1000;
  }).length;

  const stats = [
    {
      icon: Target,
      label: 'Ops Ativas',
      value: activeOps.length,
      sub: activeOps.length > 0 ? `${buyOps}↑ ${sellOps}↓` : '—',
      color: '#00ff80',
    },
    {
      icon: TrendingUp,
      label: 'Win Rate',
      value: winRate !== null ? `${winRate}%` : '—',
      sub: perf.counted > 0 ? `${wins}/${perf.counted} trades` : 'sem histórico',
      color: winRate !== null ? (winRate >= 50 ? '#00ff80' : '#ff9f43') : '#64748b',
    },
    {
      icon: Activity,
      label: 'Sinais 24h',
      value: signals24h,
      sub: `${recentSignals.filter(s => s.priority === 'high' && Date.now() - new Date(s.created_date).getTime() < 24*60*60*1000).length} alta prio`,
      color: '#00e5ff',
    },
    {
      icon: Zap,
      label: 'Monitorados',
      value: assets.length,
      sub: `${assets.filter(a => a.scan_status === 'success').length} com dados`,
      color: '#ffd166',
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-1">
      {stats.map((s, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl px-4 py-3"
          style={{ background: 'rgba(12,15,26,0.7)', border: '1px solid rgba(255,255,255,0.05)', backdropFilter: 'blur(12px)' }}>
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
            style={{ background: `${s.color}18`, border: `1px solid ${s.color}30` }}>
            <s.icon className="w-3.5 h-3.5" style={{ color: s.color }} />
          </div>
          <div>
            <div className="text-[10px] font-mono text-muted-foreground leading-none mb-0.5">{s.label}</div>
            <div className="font-bold font-mono text-base leading-none" style={{ color: s.color }}>{s.value}</div>
            <div className="text-[9px] font-mono text-muted-foreground mt-0.5">{s.sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}