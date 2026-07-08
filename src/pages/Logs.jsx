import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { ScrollText, Filter, RefreshCw, AlertTriangle, Info, Bug, AlertCircle, X, Search, Trash2 } from 'lucide-react';
import moment from 'moment';

const LEVEL_CONFIG = {
  info:  { icon: Info,          color: 'rgba(0,229,255,0.8)',   bg: 'rgba(0,229,255,0.08)',   border: 'rgba(0,229,255,0.2)',   label: 'INFO' },
  warn:  { icon: AlertTriangle, color: 'rgba(255,180,0,0.9)',   bg: 'rgba(255,180,0,0.08)',   border: 'rgba(255,180,0,0.25)',  label: 'WARN' },
  error: { icon: AlertCircle,   color: '#ff1478',               bg: 'rgba(255,20,120,0.08)',  border: 'rgba(255,20,120,0.25)', label: 'ERR'  },
  debug: { icon: Bug,           color: 'rgba(255,255,255,0.3)', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.07)',label: 'DBG'  },
};

export default function Logs() {
  const [filterLevel, setFilterLevel] = useState('all');
  const [filterModule, setFilterModule] = useState('all');
  const [search, setSearch] = useState('');

  const { data: logs = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['system-logs'],
    queryFn: () => base44.entities.SystemLog.list('-created_date', 200),
    refetchInterval: 15000,
  });

  const clearLogsMutation = useMutation({
    mutationFn: async () => {
      const old = logs.filter(l => moment().diff(moment(l.created_date), 'hours') > 24);
      await Promise.all(old.map(l => base44.entities.SystemLog.delete(l.id)));
    },
    onSuccess: () => refetch(),
  });

  const filtered = logs.filter(log => {
    if (filterLevel !== 'all' && log.level !== filterLevel) return false;
    if (filterModule !== 'all' && log.module !== filterModule) return false;
    if (search && !log.message?.toLowerCase().includes(search.toLowerCase()) && !log.symbol?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const modules = [...new Set(logs.map(l => l.module).filter(Boolean))];
  const errorCount = logs.filter(l => l.level === 'error').length;
  const warnCount  = logs.filter(l => l.level === 'warn').length;

  const hasActiveFilters = filterLevel !== 'all' || filterModule !== 'all' || search;

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Observabilidade</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Logs do Sistema</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
            <div className="live-dot" style={{ width: 5, height: 5 }} />
            <span>Auto-atualiza a cada 15s</span>
          </div>
          <button onClick={() => refetch()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
            <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} />Atualizar
          </button>
          <button onClick={() => clearLogsMutation.mutate()} disabled={clearLogsMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all hover:opacity-80"
            style={{ background: 'rgba(255,159,67,0.06)', border: '1px solid rgba(255,159,67,0.15)', color: '#ff9f43' }}>
            <Trash2 className="w-3 h-3" />Limpar antigos
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 md:grid-cols-4 gap-3">
        {[
          { label: 'Total', value: logs.length, color: '#00e5ff', icon: ScrollText },
          { label: 'Erros', value: errorCount, color: '#ff1478', icon: AlertCircle },
          { label: 'Warnings', value: warnCount, color: '#ff9f43', icon: AlertTriangle },
          { label: 'Info', value: logs.filter(l => l.level === 'info').length, color: 'rgba(0,229,255,0.7)', icon: Info },
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
      <div className="rounded-xl p-3" style={{ background: 'rgba(10,13,22,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="w-3 h-3 text-muted-foreground shrink-0" />

          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <input type="text" placeholder="Buscar na mensagem..." value={search} onChange={e => setSearch(e.target.value)}
              className="pl-6 pr-3 py-1.5 rounded-lg w-40 text-[10px] font-mono outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }} />
          </div>

          <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.08)' }} />

          {['all', 'error', 'warn', 'info', 'debug'].map(level => {
            const cfg = LEVEL_CONFIG[level];
            return (
              <button key={level} onClick={() => setFilterLevel(level)}
                className="text-[9px] font-mono px-2 py-1.5 rounded-lg transition-all"
                style={filterLevel === level
                  ? { background: cfg ? cfg.bg : 'rgba(0,229,255,0.12)', border: `1px solid ${cfg ? cfg.border : 'rgba(0,229,255,0.3)'}`, color: cfg ? cfg.color : '#00e5ff' }
                  : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
                {level === 'all' ? 'Todos' : cfg?.label || level.toUpperCase()}
              </button>
            );
          })}

          <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.08)' }} />

          <select value={filterModule} onChange={e => setFilterModule(e.target.value)}
            className="px-2 py-1.5 rounded-lg text-[10px] font-mono outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
            <option value="all">Todos módulos</option>
            {modules.map(m => <option key={m} value={m}>{m}</option>)}
          </select>

          {hasActiveFilters && (
            <button onClick={() => { setSearch(''); setFilterLevel('all'); setFilterModule('all'); }}
              className="ml-auto text-[9px] font-mono px-2 py-1.5 rounded-lg flex items-center gap-1 transition-all"
              style={{ background: 'rgba(255,20,120,0.08)', border: '1px solid rgba(255,20,120,0.2)', color: '#ff1478' }}>
              <X className="w-3 h-3" />Limpar
            </button>
          )}

          <span className="text-[9px] font-mono text-muted-foreground ml-1">{filtered.length} registros</span>
        </div>
      </div>

      {/* Log Feed */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl p-12 text-center" style={{ background: 'rgba(10,13,22,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <ScrollText className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
          <p className="text-muted-foreground text-sm">Nenhum log encontrado.</p>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden font-mono" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
          {filtered.map((log, i) => {
            const cfg = LEVEL_CONFIG[log.level] || LEVEL_CONFIG.info;
            return (
              <div key={log.id}
                className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.012]"
                style={{ background: i % 2 === 0 ? 'rgba(10,13,22,0.85)' : 'rgba(12,15,24,0.7)', borderTop: i > 0 ? '1px solid rgba(255,255,255,0.03)' : 'none' }}>

                <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                  <span className="text-[8px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest"
                    style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color }}>
                    {cfg.label}
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[9px] px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.4)' }}>
                      {log.module}
                    </span>
                    {log.symbol && <span className="text-[9px]" style={{ color: 'rgba(0,229,255,0.6)' }}>{log.symbol}</span>}
                    {log.timeframe && <span className="text-[9px]" style={{ color: 'rgba(255,255,255,0.3)' }}>{log.timeframe}</span>}
                    {log.duration_ms && <span className="text-[9px]" style={{ color: 'rgba(255,255,255,0.2)' }}>{log.duration_ms}ms</span>}
                  </div>
                  <p className="text-[11px] text-foreground/80 mt-0.5 leading-relaxed">{log.message}</p>
                  {log.details && (
                    <details className="mt-1">
                      <summary className="text-[9px] cursor-pointer select-none" style={{ color: 'rgba(255,255,255,0.25)' }}>ver payload →</summary>
                      <pre className="mt-1 text-[10px] overflow-x-auto py-1 rounded" style={{ color: 'rgba(0,255,128,0.6)', background: 'rgba(0,0,0,0.3)', padding: '4px 8px' }}>
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>

                <span className="text-[9px] shrink-0 pt-0.5" style={{ color: 'rgba(255,255,255,0.2)' }}>
                  {moment(log.created_date).format('HH:mm:ss')}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}