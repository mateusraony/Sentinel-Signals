import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { CalendarDays, TrendingUp, TrendingDown, Target, Zap } from 'lucide-react';
import { BarChart, Bar, ResponsiveContainer, Tooltip, Cell } from 'recharts';
import moment from 'moment';
import { isClosedOp, getClosedAt, calcRealizedPnlPct, summarizeOps } from '@/lib/tradeMetrics';

const WEEKDAY_LABELS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
// Consulta própria, dedicada — não reaproveita os feeds do Dashboard
// (limitados a 100 ops / 50 sinais para a lista de atividade recente, que
// numa semana de alto volume já não cobre a semana inteira). Mesmo limite
// de TradeOperation que MonthlyReport.jsx já usa para agregações mensais.
const WEEK_OPS_LIMIT = 500;
const WEEK_SIGNALS_LIMIT = 300;

export default function WeeklySummary() {
  const { data: tradeOps = [] } = useQuery({
    queryKey: ['weekly-summary-ops'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', WEEK_OPS_LIMIT),
    staleTime: 60000,
  });

  const { data: recentSignals = [] } = useQuery({
    queryKey: ['weekly-summary-signals'],
    queryFn: () => backend.entities.SignalEvent.list('-created_date', WEEK_SIGNALS_LIMIT),
    staleTime: 60000,
  });

  const data = useMemo(() => {
    const weekStart = moment().startOf('isoWeek');
    const weekOps = (tradeOps || []).filter(op => {
      if (!isClosedOp(op)) return false;
      const closedAt = getClosedAt(op) || op.created_date;
      return moment(closedAt).isSameOrAfter(weekStart);
    });
    const summary = summarizeOps(weekOps);
    const signalsThisWeek = (recentSignals || []).filter(s => moment(s.created_date).isSameOrAfter(weekStart)).length;

    const daily = WEEKDAY_LABELS.map((label, i) => {
      const day = moment(weekStart).add(i, 'days');
      const pnlPct = weekOps.reduce((sum, op) => {
        const closedAt = moment(getClosedAt(op) || op.created_date);
        return closedAt.isSame(day, 'day') ? sum + (calcRealizedPnlPct(op) || 0) : sum;
      }, 0);
      return { label, pnlPct: +pnlPct.toFixed(2), isFuture: day.isAfter(moment(), 'day') };
    });

    return {
      totalPnl: summary.totalPnlPct,
      winRate: summary.counted > 0 ? Math.round(summary.winRate) : null,
      counted: summary.counted,
      wins: summary.wins,
      losses: summary.losses,
      be: summary.be,
      signalsThisWeek,
      daily,
      weekRangeLabel: `${weekStart.format('DD/MM')} – ${moment(weekStart).add(6, 'days').format('DD/MM')}`,
    };
  }, [tradeOps, recentSignals]);

  const pnlColor = data.totalPnl >= 0 ? '#00ff80' : '#ff1478';

  return (
    <div className="rounded-2xl p-4"
      style={{ background: 'rgba(6,8,15,0.7)', border: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(20px)' }}>
      <div className="flex items-center gap-2 mb-3">
        <CalendarDays className="w-3.5 h-3.5" style={{ color: '#00e5ff' }} />
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Resumo da Semana</span>
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
          {data.weekRangeLabel}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="grid grid-cols-3 gap-2 md:col-span-2">
          <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-1.5 mb-1">
              {data.totalPnl >= 0 ? <TrendingUp className="w-3 h-3" style={{ color: pnlColor }} /> : <TrendingDown className="w-3 h-3" style={{ color: pnlColor }} />}
              <span className="text-[8px] font-mono uppercase text-muted-foreground">P&L Semana</span>
            </div>
            <div className="text-base font-bold font-mono" style={{ color: pnlColor }}>
              {data.totalPnl >= 0 ? '+' : ''}{data.totalPnl.toFixed(2)}%
            </div>
            <div className="text-[8px] font-mono text-muted-foreground mt-0.5">{data.wins}W · {data.be}BE · {data.losses}L</div>
          </div>
          <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-1.5 mb-1">
              <Target className="w-3 h-3" style={{ color: '#ffd166' }} />
              <span className="text-[8px] font-mono uppercase text-muted-foreground">Taxa de Acerto</span>
            </div>
            <div className="text-base font-bold font-mono" style={{ color: '#ffd166' }}>
              {data.winRate !== null ? `${data.winRate}%` : '—'}
            </div>
            <div className="text-[8px] font-mono text-muted-foreground mt-0.5">
              {data.counted > 0 ? `${data.counted} trades fechados` : 'sem trades ainda'}
            </div>
          </div>
          <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-1.5 mb-1">
              <Zap className="w-3 h-3" style={{ color: '#00e5ff' }} />
              <span className="text-[8px] font-mono uppercase text-muted-foreground">Sinais Processados</span>
            </div>
            <div className="text-base font-bold font-mono" style={{ color: '#00e5ff' }}>{data.signalsThisWeek}</div>
            <div className="text-[8px] font-mono text-muted-foreground mt-0.5">desde segunda-feira</div>
          </div>
        </div>

        <div className="rounded-xl px-3 py-2" style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="text-[8px] font-mono uppercase text-muted-foreground mb-1">P&L por dia</div>
          <div style={{ height: 64 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.daily} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
                <Tooltip
                  contentStyle={{ background: 'rgba(10,13,22,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace' }}
                  formatter={(value) => [`${value}%`, 'P&L']}
                  labelFormatter={(label) => label}
                />
                <Bar dataKey="pnlPct" radius={[2, 2, 0, 0]}>
                  {data.daily.map((d, i) => (
                    <Cell key={i} fill={d.isFuture ? 'rgba(255,255,255,0.06)' : d.pnlPct >= 0 ? '#00ff80' : d.pnlPct < 0 ? '#ff1478' : 'rgba(255,255,255,0.15)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-7 gap-0 text-center mt-0.5">
            {WEEKDAY_LABELS.map(l => <span key={l} className="text-[7px] font-mono text-muted-foreground">{l[0]}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}
