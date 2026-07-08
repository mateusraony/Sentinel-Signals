import React from 'react';
import SignalBadge from './SignalBadge';
import { PriorityBadge } from './StrengthBadge';
import moment from 'moment';
import { Activity, ChevronRight } from 'lucide-react';

export default function RecentAlertsList({ signals = [] }) {
  const rangeFilterSignals = signals.filter(s => s.source === 'range_filter');

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-4 h-4" style={{ color: '#00ff80' }} />
        <h2 className="text-base font-bold text-foreground tracking-tight">Alertas Recentes</h2>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(0,255,128,0.08)', border: '1px solid rgba(0,255,128,0.2)', color: 'rgba(0,255,128,0.7)' }}
        >{rangeFilterSignals.length}</span>
      </div>

      <div className="glass-card rounded-xl overflow-hidden">
        {rangeFilterSignals.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <div className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <Activity className="w-5 h-5 opacity-30" />
            </div>
            <p className="text-sm">Nenhum alerta. Execute um Scan para começar.</p>
          </div>
        ) : (
          <div>
            {rangeFilterSignals.slice(0, 8).map((signal, i) => (
              <div key={signal.id}
                className="px-4 py-3 flex items-center gap-3 hover:bg-white/[0.02] transition-colors cursor-pointer group"
                style={{ borderTop: i > 0 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}
              >
                <SignalBadge signal={signal.signal_type} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{signal.symbol}</span>
                    <span className="text-[10px] font-mono text-muted-foreground">{signal.timeframe?.toUpperCase()}</span>
                    <PriorityBadge priority={signal.priority} />
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate mt-0.5">{signal.reason}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] font-mono text-muted-foreground">{moment(signal.created_date).fromNow()}</span>
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}