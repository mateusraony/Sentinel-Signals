import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import {
  Loader2, Target, History, XCircle, Eye,
  TrendingUp, TrendingDown, AlertTriangle, CheckCircle2,
  BarChart2, Edit3, X, Search, Calendar
} from 'lucide-react';
import TradeCard from '@/components/dashboard/TradeCard';
import TradeEntryMarkers from '@/components/trades/TradeEntryMarkers';
import PortfolioVsMarket from '@/components/trades/PortfolioVsMarket';
import PerformanceReport from '@/components/trades/PerformanceReport';
import { fetch24hStats } from '@/lib/marketDataProvider';
import moment from 'moment';

const ACTIVE_STATUSES = ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'];
const CLOSED_STATUSES = ['TP2_HIT', 'STOP_HIT', 'INVALIDATED', 'CLOSED'];

function fmt(price) {
  if (!price && price !== 0) return '—';
  if (price >= 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

/** Horizontal Risk/Reward visual bar */
function RRBar({ op }) {
  const { data: stats } = useQuery({
    queryKey: ['rr-price', op.symbol],
    queryFn: () => fetch24hStats(op.symbol),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  const isBuy = op.side === 'BUY';
  const stop = op.current_stop, entry = op.entry_price, tp1 = op.tp1, tp2 = op.tp2;
  if (!stop || !entry || !tp1 || !tp2) return null;
  const low = isBuy ? stop : tp2, high = isBuy ? tp2 : stop;
  const range = high - low;
  if (range <= 0) return null;
  const pct = (v) => ((v - low) / range) * 100;
  const entryPct = pct(entry), tp1Pct = pct(tp1);
  const currentPrice = stats ? (parseFloat(stats.highPrice + stats.lowPrice) / 2) : null;
  const currentPct = currentPrice ? Math.max(0, Math.min(100, pct(currentPrice))) : null;

  return (
    <div className="mt-2 mb-1 px-1">
      <div className="flex justify-between text-[8px] font-mono text-muted-foreground mb-1">
        <span>Stop</span><span>Entrada</span><span>TP1</span><span>TP2</span>
      </div>
      <div className="relative h-2 w-full rounded-full overflow-visible" style={{ background: 'rgba(255,255,255,0.06)' }}>
        {isBuy
          ? <div className="absolute h-full rounded-l-full" style={{ left: 0, width: `${entryPct}%`, background: 'rgba(255,20,120,0.4)' }} />
          : <div className="absolute h-full rounded-r-full" style={{ left: `${entryPct}%`, right: 0, background: 'rgba(255,20,120,0.4)' }} />}
        {isBuy
          ? <div className="absolute h-full" style={{ left: `${entryPct}%`, width: `${tp1Pct - entryPct}%`, background: 'rgba(0,255,128,0.35)' }} />
          : <div className="absolute h-full" style={{ left: `${tp1Pct}%`, width: `${entryPct - tp1Pct}%`, background: 'rgba(0,255,128,0.35)' }} />}
        {isBuy
          ? <div className="absolute h-full rounded-r-full" style={{ left: `${tp1Pct}%`, right: 0, background: 'rgba(0,255,128,0.6)' }} />
          : <div className="absolute h-full rounded-l-full" style={{ left: 0, width: `${tp1Pct}%`, background: 'rgba(0,255,128,0.6)' }} />}
        {[{ p: entryPct, c: 'rgba(255,255,255,0.8)' }, { p: tp1Pct, c: '#ffd166' }, { p: isBuy ? 100 : 0, c: '#00ff80' }].map((m, i) => (
          <div key={i} className="absolute top-0 bottom-0 w-0.5" style={{ left: `${m.p}%`, background: m.c, transform: 'translateX(-50%)' }} />
        ))}
        {currentPct !== null && (
          <div className="absolute -top-1 -bottom-1 w-0.5 rounded-full"
            style={{ left: `${currentPct}%`, background: '#00e5ff', boxShadow: '0 0 4px #00e5ff', transform: 'translateX(-50%)' }} />
        )}
      </div>
      <div className="flex justify-between text-[8px] font-mono mt-0.5" style={{ color: 'rgba(255,255,255,0.25)' }}>
        <span>${fmt(stop)}</span><span>${fmt(entry)}</span><span>${fmt(tp1)}</span><span>${fmt(tp2)}</span>
      </div>
    </div>
  );
}

/** Modal for editing an active operation */
function EditModal({ op, onClose, onSave }) {
  const [stop, setStop] = useState(op.current_stop ?? '');
  const [tp1, setTp1] = useState(op.tp1 ?? '');
  const [tp2, setTp2] = useState(op.tp2 ?? '');
  const [status, setStatus] = useState(op.status ?? 'SIGNAL_CONFIRMED');
  const [exitPrice, setExitPrice] = useState(op.exit_price ?? '');

  const fieldStyle = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: 'rgba(255,255,255,0.85)',
    outline: 'none',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-sm rounded-2xl p-5 space-y-4"
        style={{ background: 'rgba(10,13,22,0.98)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 0 40px rgba(0,0,0,0.5)' }}>
        <div className="flex items-center justify-between">
          <div>
            <div className="font-bold text-sm text-foreground">{op.symbol?.replace('USDT', '/USDT')}</div>
            <div className="text-[9px] font-mono text-muted-foreground">{op.timeframe?.toUpperCase()} · {op.side}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/[0.05] transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="space-y-3">
          {/* Status manual */}
          <div>
            <label className="text-[9px] font-mono mb-1 block" style={{ color: '#00e5ff' }}>Status Manual</label>
            <select value={status} onChange={e => setStatus(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-xs font-mono"
              style={fieldStyle}>
              <option value="SIGNAL_CONFIRMED">SIGNAL_CONFIRMED — Aguardando entrada</option>
              <option value="RUNNER_ACTIVE">RUNNER_ACTIVE — TP1 atingido, runner ativo</option>
              <option value="TP2_HIT">TP2_HIT — TP2 atingido (win)</option>
              <option value="STOP_HIT">STOP_HIT — Stop atingido</option>
              <option value="INVALIDATED">INVALIDATED — Invalidado</option>
              <option value="CLOSED">CLOSED — Encerrado manualmente</option>
            </select>
          </div>

          {/* Preço de saída (para status terminais) */}
          {['TP2_HIT','STOP_HIT','INVALIDATED','CLOSED'].includes(status) && (
            <div>
              <label className="text-[9px] font-mono mb-1 block" style={{ color: '#ffd166' }}>Preço de Saída (exit_price)</label>
              <input type="number" step="any" value={exitPrice} onChange={e => setExitPrice(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-xs font-mono" style={fieldStyle} />
            </div>
          )}

          {[
            { label: 'Stop Atual', value: stop, set: setStop, color: '#ff1478' },
            { label: 'TP1', value: tp1, set: setTp1, color: '#ffd166' },
            { label: 'TP2', value: tp2, set: setTp2, color: '#00ff80' },
          ].map(({ label, value, set, color }) => (
            <div key={label}>
              <label className="text-[9px] font-mono mb-1 block" style={{ color }}>{label}</label>
              <input type="number" step="any" value={value} onChange={e => set(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-xs font-mono" style={fieldStyle} />
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={onClose}
            className="flex-1 py-2 rounded-lg text-[10px] font-mono transition-all"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
            Cancelar
          </button>
          <button
            onClick={() => {
              const data = {
                status,
                current_stop: stop ? parseFloat(stop) : undefined,
                tp1: tp1 ? parseFloat(tp1) : undefined,
                tp2: tp2 ? parseFloat(tp2) : undefined,
              };
              if (exitPrice) data.exit_price = parseFloat(exitPrice);
              if (['TP2_HIT','STOP_HIT','INVALIDATED','CLOSED'].includes(status)) {
                data.closed_at = new Date().toISOString();
                data.closed_reason = 'Alterado manualmente';
              }
              if (status === 'RUNNER_ACTIVE') data.tp1_hit = true;
              onSave(data);
            }}
            className="flex-1 py-2 rounded-lg text-[10px] font-mono font-bold transition-all"
            style={{ background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }}>
            Salvar Alterações
          </button>
        </div>
      </div>
    </div>
  );
}

/** Monitoring card */
function MonitoringCard({ signal }) {
  const isBuy = signal.signal_type === 'BUY';
  return (
    <div className="rounded-xl p-4 space-y-2.5"
      style={{ background: 'rgba(12,15,26,0.75)', backdropFilter: 'blur(20px)', border: isBuy ? '1px solid rgba(0,255,128,0.15)' : '1px solid rgba(255,20,120,0.15)' }}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-foreground">{signal.symbol?.replace('USDT', '/USDT')}</span>
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.07)' }}>
              {signal.timeframe?.toUpperCase()}
            </span>
            <span className="flex items-center gap-0.5 text-[10px] font-mono font-bold px-2 py-0.5 rounded"
              style={isBuy
                ? { background: 'rgba(0,255,128,0.1)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.25)' }
                : { background: 'rgba(255,20,120,0.1)', color: '#ff1478', border: '1px solid rgba(255,20,120,0.25)' }}>
              {isBuy ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {signal.signal_type}
            </span>
          </div>
          <div className="text-[9px] font-mono text-muted-foreground mt-0.5">{moment(signal.created_date).fromNow()}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] font-mono font-semibold text-foreground">${fmt(signal.price_at_signal)}</div>
          <div className="text-[9px] font-mono" style={{ color: '#ffd166' }}>Score: {signal.context?.score || 0}/100</div>
        </div>
      </div>
      <div style={{ height: 1, background: 'rgba(255,255,255,0.05)' }} />
      <div className="text-[9px] font-mono text-muted-foreground leading-relaxed line-clamp-2">{signal.reason}</div>
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#ffd166', boxShadow: '0 0 4px #ffd166', display: 'inline-block' }} />
        <span className="text-[9px] font-mono" style={{ color: '#ffd166' }}>Aguardando confirmação de entrada</span>
      </div>
    </div>
  );
}

/** History row */
function HistoryRow({ op }) {
  const isBuy = op.side === 'BUY';
  // Use real recorded exit_price first, then fallback to derived
  let exitPrice = op.exit_price ?? null;
  if (!exitPrice) {
    if (op.status === 'TP2_HIT') exitPrice = op.tp2;
    else if (op.status === 'STOP_HIT') exitPrice = op.tp1_hit ? op.entry_price : op.current_stop;
    else if (op.status === 'INVALIDATED' || op.status === 'CLOSED') exitPrice = op.current_stop;
  }

  let pnlPct = null;
  if (exitPrice && op.entry_price) {
    pnlPct = isBuy
      ? ((exitPrice - op.entry_price) / op.entry_price) * 100
      : ((op.entry_price - exitPrice) / op.entry_price) * 100;
  }

  const STATUS_MAP = {
    TP2_HIT:     { label: '🏆 TP2', color: '#00ff80' },
    STOP_HIT:    { label: op.tp1_hit ? '🔄 BE' : '🛑 Stop', color: op.tp1_hit ? '#ffd166' : '#ff1478' },
    INVALIDATED: { label: '⚠ Inv.', color: '#ff9f43' },
    CLOSED:      { label: '✗ Enc.', color: '#64748b' },
  };
  const s = STATUS_MAP[op.status] || { label: op.status, color: '#64748b' };

  return (
    <div className="rounded-xl px-4 py-2.5 flex items-center gap-3 transition-opacity"
      style={{ background: 'rgba(12,15,26,0.55)', border: '1px solid rgba(255,255,255,0.05)', opacity: 0.8 }}>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="font-semibold text-xs text-foreground shrink-0">{op.symbol?.replace('USDT', '/USDT')}</span>
        <span className="text-[9px] font-mono text-muted-foreground">{op.timeframe?.toUpperCase()}</span>
        <span className="text-[9px] font-mono font-bold" style={{ color: isBuy ? '#00ff80' : '#ff1478' }}>{op.side}</span>
        <span className="text-[9px] font-mono text-muted-foreground hidden sm:block">${fmt(op.entry_price)}</span>
        {exitPrice && <span className="text-[9px] font-mono text-muted-foreground hidden md:block">→ ${fmt(exitPrice)}</span>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {pnlPct !== null && (
          <span className="text-sm font-mono font-bold" style={{ color: pnlPct >= 0 ? '#00ff80' : '#ff1478' }}>
            {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
          </span>
        )}
        <span className="text-[9px] font-mono font-semibold" style={{ color: s.color }}>{s.label}</span>
        <span className="text-[9px] font-mono text-muted-foreground hidden sm:block">{moment(op.created_date).format('DD/MM HH:mm')}</span>
      </div>
    </div>
  );
}

export default function Trades() {
  const [showHistory, setShowHistory] = useState(false);
  const [showChart, setShowChart] = useState(true);
  const [filterTf, setFilterTf] = useState('all');
  const [filterSide, setFilterSide] = useState('all');
  const [search, setSearch] = useState('');
  const [datePreset, setDatePreset] = useState('all');
  const [editingOp, setEditingOp] = useState(null);
  const queryClient = useQueryClient();

  // Reset filters on global event
  useEffect(() => {
    const handler = () => { setSearch(''); setFilterTf('all'); setFilterSide('all'); setDatePreset('all'); };
    window.addEventListener('app-reset-filters', handler);
    return () => window.removeEventListener('app-reset-filters', handler);
  }, []);

  const dateRange = useMemo(() => {
    if (datePreset === 'all') return null;
    const now = moment();
    let from, to;
    switch (datePreset) {
      case 'today': from = now.clone().startOf('day'); to = now.clone().endOf('day'); break;
      case 'week': from = now.clone().startOf('week'); to = now.clone().endOf('week'); break;
      case 'month': from = now.clone().startOf('month'); to = now.clone().endOf('month'); break;
      case 'last_month': from = now.clone().subtract(1, 'month').startOf('month'); to = now.clone().subtract(1, 'month').endOf('month'); break;
      case 'quarter': from = now.clone().startOf('quarter'); to = now.clone().endOf('quarter'); break;
      case 'year': from = now.clone().startOf('year'); to = now.clone().endOf('year'); break;
      default: return null;
    }
    return { from: from.toDate(), to: to.toDate() };
  }, [datePreset]);

  const { data: operations = [], isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['trade-operations'],
    queryFn: () => base44.entities.TradeOperation.list('-created_date', 100),
    refetchInterval: 15000,
  });

  const { data: recentSignals = [] } = useQuery({
    queryKey: ['recent-signals'],
    queryFn: () => base44.entities.SignalEvent.list('-created_date', 50),
    refetchInterval: 30000,
  });

  const closeMutation = useMutation({
    mutationFn: (id) => base44.entities.TradeOperation.update(id, { status: 'CLOSED', closed_reason: 'Encerrado manualmente' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trade-operations'] }),
  });

  const invalidateMutation = useMutation({
    mutationFn: (id) => base44.entities.TradeOperation.update(id, { status: 'INVALIDATED', closed_reason: 'Invalidado manualmente' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trade-operations'] }),
  });

  const editMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.TradeOperation.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trade-operations'] });
      setEditingOp(null);
    },
  });

  const active  = operations.filter(o => ACTIVE_STATUSES.includes(o.status));
  const history = operations.filter(o => CLOSED_STATUSES.includes(o.status));

  const activeKey = new Set(active.map(o => `${o.symbol}_${o.timeframe}`));
  const monitoringMap = new Map();
  recentSignals
    .filter(s => s.source === 'range_filter' && !activeKey.has(`${s.symbol}_${s.timeframe}`))
    .forEach(s => {
      const key = `${s.symbol}_${s.timeframe}`;
      if (!monitoringMap.has(key) || new Date(s.created_date) > new Date(monitoringMap.get(key).created_date))
        monitoringMap.set(key, s);
    });
  const monitoringList = [...monitoringMap.values()];

  const applyFilters = (list) => list
    .filter(o => filterTf === 'all' || o.timeframe === filterTf)
    .filter(o => filterSide === 'all' || (o.side || o.signal_type) === filterSide)
    .filter(o => !search || o.symbol?.toLowerCase().includes(search.toLowerCase()))
    .filter(o => {
      if (!dateRange) return true;
      const d = new Date(o.created_date);
      return d >= dateRange.from && d <= dateRange.to;
    });

  const [secAgo, setSecAgo] = useState(0);
  useEffect(() => {
    if (!dataUpdatedAt) return;
    const interval = setInterval(() => setSecAgo(Math.floor((Date.now() - dataUpdatedAt) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [dataUpdatedAt]);

  const TF_BTNS = ['all', '1h', '4h', '1d'];
  const SIDE_BTNS = ['all', 'BUY', 'SELL'];

  return (
    <>
      {editingOp && (
        <EditModal
          op={editingOp}
          onClose={() => setEditingOp(null)}
          onSave={(data) => editMutation.mutate({ id: editingOp.id, data })}
        />
      )}

      <div className="space-y-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Gestão de Operações</p>
            <h1 className="text-3xl font-bold text-foreground tracking-tight">Plano de Trade</h1>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="live-dot" style={{ width: 5, height: 5 }} />
              <span className="text-muted-foreground">Atualizado há {secAgo}s</span>
            </span>
            <span className="text-muted-foreground">
              {monitoringList.length} monitorando · {active.length} ativas · {history.length} histórico
            </span>
          </div>
        </div>

        {/* Performance Report + Charts */}
        {applyFilters(history).length > 0 && (
          <div className="space-y-4">
            <PerformanceReport trades={applyFilters(history)} />
            <div>
            <button onClick={() => setShowChart(!showChart)}
              className="flex items-center gap-2 mb-3 group">
              <BarChart2 className="w-4 h-4" style={{ color: '#00e5ff' }} />
              <h2 className="text-base font-bold text-foreground/80 group-hover:text-foreground transition-colors">
                Performance Acumulada
              </h2>
              <span className="text-[10px] font-mono" style={{ color: '#00e5ff' }}>
                {showChart ? '▲ esconder' : '▼ mostrar'}
              </span>
            </button>
            {showChart && (
              <>
                <TradeEntryMarkers history={applyFilters(history)} />
                <div className="mt-4">
                  <PortfolioVsMarket trades={applyFilters(history)} />
                </div>
              </>
            )}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <input type="text" placeholder="Buscar operação..." value={search} onChange={e => setSearch(e.target.value)}
              className="pl-7 pr-3 h-8 w-44 rounded-lg text-[10px] font-mono outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.75)' }} />
          </div>

          <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(255,255,255,0.08)' }} />

          {/* Date presets */}
          <Calendar className="w-3 h-3 text-muted-foreground shrink-0" />
          {[
            { id: 'all', label: 'Tudo' },
            { id: 'today', label: 'Hoje' },
            { id: 'week', label: 'Semana' },
            { id: 'month', label: 'Mês' },
            { id: 'last_month', label: 'Mês Passado' },
            { id: 'quarter', label: 'Trimestre' },
            { id: 'year', label: 'Ano' },
          ].map(p => (
            <button key={p.id} onClick={() => setDatePreset(p.id)}
              className="text-[10px] font-mono px-2.5 py-1 rounded-md transition-all"
              style={datePreset === p.id
                ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(0,229,255,0.9)' }
                : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
              {p.label}
            </button>
          ))}

          <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(255,255,255,0.08)' }} />

          {TF_BTNS.map(tf => (
            <button key={tf} onClick={() => setFilterTf(tf)}
              className="text-[10px] font-mono px-2.5 py-1 rounded-md transition-all"
              style={filterTf === tf
                ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(0,229,255,0.9)' }
                : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
              {tf === 'all' ? 'Todos TF' : tf.toUpperCase()}
            </button>
          ))}
          <div className="w-px h-4 mx-1" style={{ background: 'rgba(255,255,255,0.08)' }} />
          {SIDE_BTNS.map(side => (
            <button key={side} onClick={() => setFilterSide(side)}
              className="text-[10px] font-mono px-2.5 py-1 rounded-md transition-all"
              style={filterSide === side
                ? side === 'BUY' ? { background: 'rgba(0,255,128,0.12)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }
                  : side === 'SELL' ? { background: 'rgba(255,20,120,0.12)', border: '1px solid rgba(255,20,120,0.3)', color: '#ff1478' }
                  : { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(0,229,255,0.9)' }
                : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
              {side === 'all' ? 'Todos' : side}
            </button>
          ))}
        </div>

        {/* Monitoring section */}
        {monitoringList.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Eye className="w-4 h-4" style={{ color: '#ffd166' }} />
              <h2 className="text-base font-bold text-foreground">Em Monitoramento</h2>
              <span className="text-xs font-mono" style={{ color: '#ffd166' }}>
                ({applyFilters(monitoringList.map(s => ({ ...s, side: s.signal_type }))).length})
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {applyFilters(monitoringList.map(s => ({ ...s, side: s.signal_type }))).map(signal => (
                <MonitoringCard key={signal.id} signal={signal} />
              ))}
            </div>
          </div>
        )}

        {/* Active Operations */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Target className="w-4 h-4" style={{ color: '#00ff80' }} />
            <h2 className="text-base font-bold text-foreground">Operações Ativas</h2>
            <span className="text-xs font-mono text-muted-foreground">({applyFilters(active).length})</span>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : applyFilters(active).length === 0 ? (
            <div className="glass-card rounded-xl p-12 text-center">
              <Target className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
              <p className="text-muted-foreground text-sm">Nenhuma operação ativa.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {applyFilters(active).map(op => (
                <div key={op.id} className="rounded-xl overflow-hidden"
                  style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                  <TradeCard operation={op} />
                  <RRBar op={op} />

                  {/* Action buttons — always visible */}
                  <div className="flex items-center gap-1.5 p-2"
                    style={{ background: 'rgba(6,8,15,0.6)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    {/* Edit */}
                    <button
                      onClick={() => setEditingOp(op)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all hover:opacity-90"
                      style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
                      <Edit3 className="w-3 h-3" />
                      Editar
                    </button>
                    {/* Invalidar */}
                    <button
                      onClick={() => {
                        if (window.confirm(`Invalidar ${op.symbol} ${op.side}?`)) invalidateMutation.mutate(op.id);
                      }}
                      disabled={invalidateMutation.isPending}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all hover:opacity-90"
                      style={{ background: 'rgba(255,159,67,0.08)', border: '1px solid rgba(255,159,67,0.2)', color: '#ff9f43' }}>
                      <AlertTriangle className="w-3 h-3" />
                      Invalidar
                    </button>
                    {/* Encerrar */}
                    <button
                      onClick={() => {
                        if (window.confirm(`Encerrar ${op.symbol} ${op.side}?`)) closeMutation.mutate(op.id);
                      }}
                      disabled={closeMutation.isPending}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-mono ml-auto transition-all hover:opacity-90"
                      style={{ background: 'rgba(255,20,120,0.1)', border: '1px solid rgba(255,20,120,0.25)', color: '#ff1478' }}>
                      <XCircle className="w-3 h-3" />
                      Encerrar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* History */}
        {history.length > 0 && (
          <div>
            <button onClick={() => setShowHistory(!showHistory)} className="flex items-center gap-2 mb-3 group">
              <History className="w-4 h-4 text-muted-foreground group-hover:text-foreground/60 transition-colors" />
              <h2 className="text-base font-bold text-foreground/60 group-hover:text-foreground/80 transition-colors">
                Histórico Completo
              </h2>
              <span className="text-xs font-mono text-muted-foreground">({applyFilters(history).length})</span>
              <span className="text-[10px] font-mono" style={{ color: '#00e5ff' }}>
                {showHistory ? '▲ esconder' : '▼ mostrar'}
              </span>
            </button>

            {showHistory && (
              <div className="space-y-1.5">
                {(() => {
                  const filtered = applyFilters(history);
                  const wins = filtered.filter(o => o.status === 'TP2_HIT').length;
                  const losses = filtered.filter(o => o.status === 'STOP_HIT' && !o.tp1_hit).length;
                  const be = filtered.filter(o => o.status === 'STOP_HIT' && o.tp1_hit).length;
                  return (
                    <div className="flex items-center gap-4 px-3 py-2 rounded-lg mb-3 text-[10px] font-mono"
                      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <span style={{ color: '#00ff80' }}>✓ TP2: {wins}</span>
                      <span style={{ color: '#ffd166' }}>↔ BE: {be}</span>
                      <span style={{ color: '#ff1478' }}>✗ Stop: {losses}</span>
                      <span className="text-muted-foreground">Total: {filtered.length}</span>
                    </div>
                  );
                })()}
                {applyFilters(history).map(op => <HistoryRow key={op.id} op={op} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}