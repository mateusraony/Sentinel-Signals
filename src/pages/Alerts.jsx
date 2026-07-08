import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { Bell, Filter, Trash2, TrendingUp, TrendingDown, Search, X, AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import moment from 'moment';

const SOURCE_LABELS = {
  range_filter: 'Range Filter',
  rsi: 'RSI',
  macd: 'MACD',
  ema_cross: 'EMA Cross',
  confluence: 'Confluência',
};

const PRIORITY_CONFIG = {
  high:   { color: '#ff9f43', bg: 'rgba(255,159,67,0.12)', border: 'rgba(255,159,67,0.3)', label: '⚡ Alta' },
  medium: { color: 'rgba(255,255,255,0.5)', bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.1)', label: 'Média' },
  low:    { color: 'rgba(255,255,255,0.3)', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.07)', label: 'Baixa' },
};

export default function Alerts() {
  const [filterSource, setFilterSource] = useState('all');
  const [filterPriority, setFilterPriority] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedSignal, setSelectedSignal] = useState(null);
  const queryClient = useQueryClient();

  const { data: signals = [], isLoading } = useQuery({
    queryKey: ['all-signals'],
    queryFn: () => backend.entities.SignalEvent.list('-created_date', 200),
    refetchInterval: 15000,
  });

  const dismissMutation = useMutation({
    mutationFn: (id) => backend.entities.SignalEvent.update(id, { is_dismissed: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['all-signals'] }),
  });

  const filtered = signals.filter(s => {
    if (s.is_dismissed) return false;
    if (search && !s.symbol?.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterSource !== 'all' && s.source !== filterSource) return false;
    if (filterPriority !== 'all' && s.priority !== filterPriority) return false;
    if (filterType !== 'all' && s.signal_type !== filterType) return false;
    return true;
  });

  const highCount = signals.filter(s => !s.is_dismissed && s.priority === 'high').length;
  const buyCount = filtered.filter(s => s.signal_type === 'BUY').length;
  const sellCount = filtered.filter(s => s.signal_type === 'SELL').length;

  const hasActiveFilters = filterSource !== 'all' || filterPriority !== 'all' || filterType !== 'all' || search;

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Monitoramento</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Alertas</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[10px] font-mono">
            <div className="live-dot" style={{ width: 5, height: 5 }} />
            <span className="text-muted-foreground">{filtered.length} alertas</span>
          </div>
          {filtered.length > 0 && (
            <button
              onClick={() => { if (confirm('Descartar todos os alertas visíveis?')) filtered.forEach(s => dismissMutation.mutate(s.id)); }}
              disabled={dismissMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all hover:opacity-80"
              style={{ background: 'rgba(255,159,67,0.08)', border: '1px solid rgba(255,159,67,0.2)', color: '#ff9f43' }}>
              <X className="w-3 h-3" />Descartar todos
            </button>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Alta Prioridade', value: highCount, color: '#ff9f43', icon: AlertTriangle },
          { label: 'BUY', value: buyCount, color: '#00ff80', icon: TrendingUp },
          { label: 'SELL', value: sellCount, color: '#ff1478', icon: TrendingDown },
        ].map(({ label, value, color, icon: Icon }) => (
          <div key={label} className="rounded-xl px-4 py-3 flex items-center gap-3"
            style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Icon className="w-4 h-4 shrink-0" style={{ color }} />
            <div>
              <div className="text-[9px] font-mono text-muted-foreground">{label}</div>
              <div className="text-xl font-bold font-mono" style={{ color }}>{value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="rounded-xl p-3 space-y-2" style={{ background: 'rgba(10,13,22,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="w-3 h-3 text-muted-foreground shrink-0" />

          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <input type="text" placeholder="Buscar símbolo..." value={search} onChange={e => setSearch(e.target.value)}
              className="pl-6 pr-3 py-1.5 rounded-lg w-32 text-[10px] font-mono outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }} />
          </div>

          <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.08)' }} />

          {/* Tipo */}
          {[{ id: 'all', label: 'Todos' }, { id: 'BUY', label: '▲ BUY', color: '#00ff80' }, { id: 'SELL', label: '▼ SELL', color: '#ff1478' }].map(f => (
            <button key={f.id} onClick={() => setFilterType(f.id)}
              className="text-[9px] font-mono px-2 py-1.5 rounded-lg transition-all"
              style={filterType === f.id && f.color
                ? { background: `${f.color}15`, border: `1px solid ${f.color}40`, color: f.color }
                : filterType === f.id
                ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }
                : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
              {f.label}
            </button>
          ))}

          <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.08)' }} />

          {/* Prioridade */}
          {[{ id: 'all', label: 'Todas' }, { id: 'high', label: '⚡ Alta' }, { id: 'medium', label: 'Média' }, { id: 'low', label: 'Baixa' }].map(f => (
            <button key={f.id} onClick={() => setFilterPriority(f.id)}
              className="text-[9px] font-mono px-2 py-1.5 rounded-lg transition-all"
              style={filterPriority === f.id
                ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }
                : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
              {f.label}
            </button>
          ))}

          <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.08)' }} />

          {/* Fonte */}
          {['all', 'range_filter', 'rsi', 'macd', 'ema_cross'].map(src => (
            <button key={src} onClick={() => setFilterSource(src)}
              className="text-[9px] font-mono px-2 py-1.5 rounded-lg transition-all"
              style={filterSource === src
                ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }
                : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
              {src === 'all' ? 'Todas Fontes' : SOURCE_LABELS[src]}
            </button>
          ))}

          {hasActiveFilters && (
            <button onClick={() => { setSearch(''); setFilterSource('all'); setFilterPriority('all'); setFilterType('all'); }}
              className="ml-auto text-[9px] font-mono px-2 py-1.5 rounded-lg flex items-center gap-1 transition-all"
              style={{ background: 'rgba(255,20,120,0.08)', border: '1px solid rgba(255,20,120,0.2)', color: '#ff1478' }}>
              <X className="w-3 h-3" />Limpar
            </button>
          )}
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl p-12 text-center" style={{ background: 'rgba(10,13,22,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <Bell className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
          <p className="text-muted-foreground text-sm">Nenhum alerta com esses filtros.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(signal => {
            const isBuy = signal.signal_type === 'BUY';
            const prio = PRIORITY_CONFIG[signal.priority] || PRIORITY_CONFIG.low;
            return (
              <div key={signal.id}
                className="rounded-xl px-4 py-3 flex items-center gap-3 transition-all duration-200 cursor-pointer group hover:scale-[1.002]"
                style={{
                  background: 'rgba(10,13,22,0.82)',
                  backdropFilter: 'blur(12px)',
                  border: signal.priority === 'high'
                    ? (isBuy ? '1px solid rgba(0,255,128,0.3)' : '1px solid rgba(255,20,120,0.3)')
                    : (isBuy ? '1px solid rgba(0,255,128,0.1)' : '1px solid rgba(255,20,120,0.1)'),
                  boxShadow: signal.priority === 'high'
                    ? (isBuy ? '0 0 16px rgba(0,255,128,0.08)' : '0 0 16px rgba(255,20,120,0.08)')
                    : 'none',
                }}
                onClick={() => setSelectedSignal(signal)}>

                {/* Side bar */}
                <div className="w-0.5 self-stretch rounded-full shrink-0" style={{ background: isBuy ? '#00ff80' : '#ff1478' }} />

                {/* Signal badge */}
                <span className="flex items-center gap-1 text-xs font-mono font-bold px-3 py-1.5 rounded-lg shrink-0"
                  style={isBuy
                    ? { background: 'rgba(0,255,128,0.15)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.4)', boxShadow: '0 0 10px rgba(0,255,128,0.12)' }
                    : { background: 'rgba(255,20,120,0.15)', color: '#ff1478', border: '1px solid rgba(255,20,120,0.4)', boxShadow: '0 0 10px rgba(255,20,120,0.12)' }}>
                  {isBuy ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  {signal.signal_type}
                </span>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm text-foreground">{signal.symbol?.replace('USDT', '/USDT')}</span>
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.07)' }}>
                      {signal.timeframe?.toUpperCase()}
                    </span>
                    <span className="text-[8px] font-mono px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(0,229,255,0.06)', color: 'rgba(0,229,255,0.5)', border: '1px solid rgba(0,229,255,0.12)' }}>
                      {SOURCE_LABELS[signal.source] || signal.source}
                    </span>
                    <span className="text-[8px] font-mono px-1.5 py-0.5 rounded"
                      style={{ background: prio.bg, color: prio.color, border: `1px solid ${prio.border}` }}>
                      {prio.label}
                    </span>
                    {signal.context?.score > 0 && (
                      <span className="text-[8px] font-mono" style={{ color: signal.context.score >= 85 ? '#ffd166' : 'rgba(255,255,255,0.3)' }}>
                        🔥 {signal.context.score}/100
                      </span>
                    )}
                  </div>
                  {signal.reason && (
                    <p className="text-[10px] text-muted-foreground truncate mt-0.5">{signal.reason}</p>
                  )}
                </div>

                {/* Right side */}
                <div className="flex items-center gap-2 shrink-0">
                  {signal.price_at_signal && (
                    <span className="text-[10px] font-mono text-muted-foreground hidden sm:block">
                      ${signal.price_at_signal?.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </span>
                  )}
                  <span className="text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.25)' }}>
                    {moment(signal.created_date).format('DD/MM HH:mm')}
                  </span>
                  <button
                    className="p-2 rounded-lg transition-all hover:bg-rose-500/10"
                    onClick={(e) => { e.stopPropagation(); dismissMutation.mutate(signal.id); }}>
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-rose-400 transition-colors" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Dialog */}
      <Dialog open={!!selectedSignal} onOpenChange={(open) => !open && setSelectedSignal(null)}>
        <DialogContent style={{ background: 'rgba(14,17,28,0.97)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(24px)' }}>
          <DialogHeader>
            <DialogTitle className="font-mono flex items-center gap-2 text-sm">
              <span style={{ color: selectedSignal?.signal_type === 'BUY' ? '#00ff80' : '#ff1478' }}>
                {selectedSignal?.signal_type === 'BUY' ? '▲' : '▼'} {selectedSignal?.signal_type}
              </span>
              {selectedSignal?.symbol?.replace('USDT', '/USDT')} — {selectedSignal?.timeframe?.toUpperCase()}
            </DialogTitle>
          </DialogHeader>
          {selectedSignal && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['Fonte', SOURCE_LABELS[selectedSignal.source] || selectedSignal.source],
                  ['Preço', `$${selectedSignal.price_at_signal?.toLocaleString(undefined, { maximumFractionDigits: 6 })}`],
                  ['Horário', moment(selectedSignal.created_date).format('DD/MM/YYYY HH:mm:ss')],
                  ['Score', `${selectedSignal.context?.score || 0}/100`],
                ].map(([label, val]) => (
                  <div key={label} className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">{label}</p>
                    <p className="text-sm font-mono font-semibold text-foreground mt-0.5">{val}</p>
                  </div>
                ))}
              </div>
              {selectedSignal.reason && (
                <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider mb-1">Razão</p>
                  <p className="text-sm text-foreground/80">{selectedSignal.reason}</p>
                </div>
              )}
              {selectedSignal.context && (
                <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider mb-2">Contexto Técnico</p>
                  <pre className="text-[10px] font-mono overflow-x-auto" style={{ color: 'rgba(0,255,128,0.7)' }}>
                    {JSON.stringify(selectedSignal.context, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}