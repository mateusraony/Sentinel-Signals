import TokenIcon from '@/components/TokenIcon';
import React from 'react';
import { Link } from 'react-router-dom';
import SignalBadge from './SignalBadge';
import { PriorityBadge } from './StrengthBadge';
import moment from 'moment';
import { Activity, ChevronRight, WifiOff } from 'lucide-react';

export default function RecentAlertsList({ signals = [], unavailable = false, assets = [], onSelectAsset }) {
  const rangeFilterSignals = signals.filter(s => s.source === 'range_filter');

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span style={{ width: 3, height: 16, borderRadius: 2, background: '#8db4e2', display: 'inline-block' }} />
          <h2 className="text-sm font-semibold text-foreground tracking-tight">Alertas recentes</h2>
          <span className="text-11px font-mono px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(93,181,134,0.08)', border: '1px solid rgba(93,181,134,0.2)', color: 'rgba(93,181,134,0.7)' }}
          >{rangeFilterSignals.length}</span>
        </div>
        {/* Achado A-14 do Raio-X de UI/UX: feed mostrava no máximo 8 itens
            sem indicar que /alerts tem o resto (mais volume + filtros). */}
        <Link to="/alerts" className="flex items-center gap-0.5 text-11px font-mono text-muted-foreground hover:text-foreground transition-colors">
          Ver todos <ChevronRight className="w-3 h-3" />
        </Link>
      </div>

      {unavailable || rangeFilterSignals.length === 0 ? (
        <div className="glass-card rounded-md overflow-hidden">
          {unavailable ? (
            <div className="text-center py-12 text-muted-foreground">
              <div className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center"
                style={{ background: 'rgba(221,154,74,0.06)', border: '1px solid rgba(221,154,74,0.15)' }}
              >
                <WifiOff className="w-5 h-5" style={{ color: '#dd9a4a', opacity: 0.6 }} />
              </div>
              <p className="text-sm">Não foi possível carregar os alertas recentes agora.</p>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <div className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <Activity className="w-5 h-5 opacity-30" />
              </div>
              <p className="text-sm">Nenhum alerta. Execute um Scan para começar.</p>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {rangeFilterSignals.slice(0, 8).map((signal) => {
            const asset = assets.find(a => a.id === signal.asset_id);
            const isSell = signal.signal_type === 'SELL';
            return (
              <div key={signal.id}
                {...(asset ? {
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': `${signal.symbol} — abrir ativo`,
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectAsset?.(asset); }
                  },
                } : {})}
                onClick={() => asset && onSelectAsset?.(asset)}
                className="glass-card rounded-md px-3.5 py-3 cursor-pointer group transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={{ borderLeft: `3px solid ${isSell ? '#e06a5b' : '#5db586'}` }}
              >
                <div className="flex items-center gap-2">
                  <TokenIcon symbol={signal.symbol} size={18} />
                  <span className="text-sm font-semibold text-foreground">{signal.symbol}</span>
                  <span className="text-11px font-mono text-muted-foreground ml-auto">{signal.timeframe?.toUpperCase()}</span>
                </div>
                <div className="flex items-center justify-between mt-2.5">
                  <SignalBadge signal={signal.signal_type} size="sm" />
                  <PriorityBadge priority={signal.priority} />
                </div>
                <p className="text-11px text-muted-foreground mt-2">{moment(signal.created_date).fromNow()}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}