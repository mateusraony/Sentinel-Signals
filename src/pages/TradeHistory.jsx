import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/entities';
import { History, TrendingUp, TrendingDown, Filter, BarChart2, ChevronDown, ChevronUp, Search } from 'lucide-react';
import PnLChart from '@/components/trades/PnLChart';
import moment from 'moment';

const CLOSED_STATUSES = ['TP2_HIT', 'STOP_HIT', 'INVALIDATED', 'CLOSED'];

function fmt(price) {
  if (!price && price !== 0) return '—';
  if (price >= 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function calcPnl(op) {
  const isBuy = op.side === 'BUY';
  // Prefer real exit_price recorded at close time; fallback to derived price
  let exitPrice = op.exit_price ?? null;
  if (!exitPrice) {
    if (op.status === 'TP2_HIT') exitPrice = op.tp2;
    else if (op.status === 'STOP_HIT') exitPrice = op.tp1_hit ? op.entry_price : op.current_stop;
    else if (op.status === 'INVALIDATED' || op.status === 'CLOSED') exitPrice = op.current_stop;
  }
  if (!exitPrice || !op.entry_price) return null;
  return isBuy
    ? ((exitPrice - op.entry_price) / op.entry_price) * 100
    : ((op.entry_price - exitPrice) / op.entry_price) * 100;
}

function getExitPrice(op) {
  if (op.exit_price) return op.exit_price;
  if (op.status === 'TP2_HIT') return op.tp2;
  if (op.status === 'STOP_HIT') return op.tp1_hit ? op.entry_price : op.current_stop;
  return op.current_stop;
}

function getClosedAt(op) {
  return op.closed_at || op.updated_date;
}

function calcRR(op) {
  const isBuy = op.side === 'BUY';
  if (!op.entry_price || !op.current_stop || !op.tp2) return null;
  const risk = Math.abs(op.entry_price - op.current_stop);
  const reward = Math.abs(op.tp2 - op.entry_price);
  if (risk === 0) return null;
  return (reward / risk).toFixed(2);
}

const STATUS_MAP = {
  TP2_HIT:     { label: '🏆 TP2 Atingido',    color: '#00ff80', short: 'TP2' },
  STOP_HIT:    { label: '🛑 Stop',             color: '#ff1478', short: 'STOP' },
  INVALIDATED: { label: '⚠️ Invalidado',        color: '#ff9f43', short: 'INV' },
  CLOSED:      { label: '✖ Encerrado',          color: '#64748b', short: 'ENC' },
};

function HistoryCard({ op }) {
  const [expanded, setExpanded] = useState(false);
  const isBuy = op.side === 'BUY';
  const pnl = calcPnl(op);
  const rr = calcRR(op);
  const s = STATUS_MAP[op.status] || { label: op.status, color: '#64748b', short: '?' };
  const isWin = pnl !== null && pnl > 0;
  const isBE = op.status === 'STOP_HIT' && op.tp1_hit;

  const exitPrice = getExitPrice(op);
  const closedAt = getClosedAt(op);

  // Duration from signal creation to close
  const duration = op.created_date && closedAt
    ? moment.duration(moment(closedAt).diff(moment(op.created_date))).humanize()
    : null;

  const borderColor = isBE ? 'rgba(255,209,102,0.25)' : isWin ? 'rgba(0,255,128,0.2)' : pnl !== null ? 'rgba(255,20,120,0.2)' : 'rgba(255,255,255,0.06)';
  const glowColor = isBE ? 'rgba(255,209,102,0.04)' : isWin ? 'rgba(0,255,128,0.04)' : pnl !== null ? 'rgba(255,20,120,0.04)' : 'transparent';

  return (
    <div className="rounded-xl transition-all duration-200"
      style={{ background: 'rgba(10,13,22,0.8)', border: `1px solid ${borderColor}`, boxShadow: `0 0 20px ${glowColor}` }}>

      {/* Main row */}
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        {/* Side indicator */}
        <div className="w-1 self-stretch rounded-full shrink-0" style={{ background: isBuy ? '#00ff80' : '#ff1478' }} />

        {/* Symbol + meta */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-foreground">{op.symbol?.replace('USDT', '/USDT')}</span>
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.07)' }}>
              {op.timeframe?.toUpperCase()}
            </span>
            <span className="text-[9px] font-mono font-bold" style={{ color: isBuy ? '#00ff80' : '#ff1478' }}>
              {isBuy ? '▲' : '▼'} {op.side}
            </span>
            <span className="text-[9px] font-mono font-semibold px-2 py-0.5 rounded"
              style={{ background: `${s.color}15`, color: s.color, border: `1px solid ${s.color}30` }}>
              {isBE ? '🔄 Breakeven' : s.label}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[8px] font-mono text-muted-foreground flex-wrap">
            <span>📍 ${fmt(op.entry_price)}</span>
            {exitPrice && <span>🚪 ${fmt(exitPrice)}</span>}
            {rr && <span>⚖️ RR 1:{rr}</span>}
            {duration && <span>⏱ {duration}</span>}
            <span>🕐 Sinal: {moment(op.created_date).format('DD/MM/YY HH:mm')}</span>
            {closedAt && closedAt !== op.created_date && (
              <span>🔒 Enc.: {moment(closedAt).format('DD/MM/YY HH:mm')}</span>
            )}
          </div>
        </div>

        {/* P&L */}
        <div className="text-right shrink-0">
          {pnl !== null ? (
            <div className="text-base font-mono font-bold" style={{ color: isBE ? '#ffd166' : pnl >= 0 ? '#00ff80' : '#ff1478' }}>
              {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%
            </div>
          ) : <div className="text-sm font-mono text-muted-foreground">—</div>}
          {op.score > 0 && <div className="text-[9px] font-mono text-muted-foreground">score {op.score}/100</div>}
        </div>

        <span className="text-muted-foreground">{expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}</span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
          {/* Price breakdown grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: '📍 Entrada', value: op.entry_price, color: 'rgba(255,255,255,0.8)' },
              { label: '🛑 Stop Inicial', value: op.initial_stop, color: '#ff1478' },
              { label: '🎯 TP1', value: op.tp1, color: op.tp1_hit ? '#00ff80' : '#ffd166' },
              { label: '🏆 TP2', value: op.tp2, color: op.tp2_hit ? '#00ff80' : 'rgba(255,209,102,0.6)' },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="text-[9px] font-mono text-muted-foreground">{label}</div>
                <div className="text-sm font-mono font-bold mt-0.5" style={{ color }}>{value ? `$${fmt(value)}` : '—'}</div>
              </div>
            ))}
          </div>

          {/* Milestones */}
          <div className="flex flex-wrap gap-2 text-[9px] font-mono">
            <span className="px-2 py-1 rounded" style={{ background: op.tp1_hit ? 'rgba(0,255,128,0.1)' : 'rgba(255,255,255,0.04)', color: op.tp1_hit ? '#00ff80' : 'rgba(255,255,255,0.25)', border: `1px solid ${op.tp1_hit ? 'rgba(0,255,128,0.25)' : 'rgba(255,255,255,0.06)'}` }}>
              {op.tp1_hit ? '✅' : '○'} TP1
            </span>
            <span className="px-2 py-1 rounded" style={{ background: op.tp2_hit ? 'rgba(0,255,128,0.1)' : 'rgba(255,255,255,0.04)', color: op.tp2_hit ? '#00ff80' : 'rgba(255,255,255,0.25)', border: `1px solid ${op.tp2_hit ? 'rgba(0,255,128,0.25)' : 'rgba(255,255,255,0.06)'}` }}>
              {op.tp2_hit ? '✅' : '○'} TP2
            </span>
            <span className="px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.06)' }}>
              📊 {op.partial_percent || 50}% TP1 · {op.runner_percent || 50}% runner
            </span>
            <span className="px-2 py-1 rounded" style={{ background: 'rgba(0,229,255,0.06)', color: 'rgba(0,229,255,0.6)', border: '1px solid rgba(0,229,255,0.15)' }}>
              🔵 Saída: {{ RANGE_FILTER: 'RF', ATR_TRAILING: 'ATR Trail', HYBRID_RF_ATR: 'RF+ATR' }[op.exit_mode] || op.exit_mode || 'RF+ATR'}
            </span>
          </div>

          {/* Timestamps detalhados */}
          <div className="rounded-lg px-3 py-2.5 space-y-1.5" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="text-[9px] font-mono text-muted-foreground mb-1">⏱ Linha do Tempo</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-[9px] font-mono">
              <span className="text-muted-foreground">🟢 Sinal gerado: <span className="text-foreground/60">{moment(op.created_date).format('DD/MM/YY HH:mm:ss')}</span></span>
              {op.tp1_hit_at && (
                <span className="text-muted-foreground">🎯 TP1 atingido: <span style={{ color: '#00ff80' }}>{moment(op.tp1_hit_at).format('DD/MM/YY HH:mm:ss')}</span>{op.tp1_hit_price ? ` @ $${fmt(op.tp1_hit_price)}` : ''}</span>
              )}
              {op.tp2_hit_at && (
                <span className="text-muted-foreground">🏆 TP2 atingido: <span style={{ color: '#00ff80' }}>{moment(op.tp2_hit_at).format('DD/MM/YY HH:mm:ss')}</span>{op.tp2_hit_price ? ` @ $${fmt(op.tp2_hit_price)}` : ''}</span>
              )}
              {op.stop_hit_at && (
                <span className="text-muted-foreground">🛑 Stop atingido: <span style={{ color: '#ff1478' }}>{moment(op.stop_hit_at).format('DD/MM/YY HH:mm:ss')}</span>{op.stop_hit_price ? ` @ $${fmt(op.stop_hit_price)}` : ''}</span>
              )}
              {closedAt && (
                <span className="text-muted-foreground">🔒 Encerrado em: <span className="text-foreground/60">{moment(closedAt).format('DD/MM/YY HH:mm:ss')}</span></span>
              )}
            </div>
            <div className="text-[8px] font-mono text-muted-foreground mt-1">
              🕐 Candle: {op.candle_open_time ? moment(op.candle_open_time).utcOffset(-3).format('DD/MM HH:mm') : '—'} → {op.candle_close_time ? moment(op.candle_close_time).utcOffset(-3).format('HH:mm') : '—'} BRT · {op.candle_status === 'CLOSED' ? '✅ Fechado' : '⏳ Aberto'}
            </div>
          </div>

          {/* Signal reasons */}
          {op.signal_reasons?.length > 0 && (
            <div className="rounded-lg px-3 py-2.5 space-y-1" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div className="text-[9px] font-mono text-muted-foreground mb-1.5">🔍 Motivos técnicos que geraram o sinal:</div>
              {op.signal_reasons.map((r, i) => (
                <div key={i} className="text-[9px] font-mono flex items-start gap-1.5" style={{ color: 'rgba(255,255,255,0.55)' }}>
                  <span style={{ color: '#00ff80', marginTop: 1 }}>·</span> {r}
                </div>
              ))}
            </div>
          )}

          {/* Closed reason */}
          {op.closed_reason && (
            <div className="text-[9px] font-mono px-3 py-2 rounded-lg" style={{ background: 'rgba(255,159,67,0.06)', border: '1px solid rgba(255,159,67,0.15)', color: '#ff9f43' }}>
              ⚠️ Motivo de encerramento: {op.closed_reason}
            </div>
          )}

          {/* Analysis hint */}
          <div className="text-[9px] font-mono px-3 py-2 rounded-lg leading-relaxed" style={{ background: 'rgba(0,229,255,0.04)', border: '1px solid rgba(0,229,255,0.1)', color: 'rgba(0,229,255,0.6)' }}>
            💡 {isWin
              ? `Operação lucrativa com ${pnl?.toFixed(2)}%${op.tp1_hit && op.tp2_hit ? ' — TP1 e TP2 atingidos, saída ideal.' : op.tp1_hit ? ' — TP1 atingido, runner não completou TP2.' : '.'}`
              : isBE ? 'Breakeven — stop movido para entrada após TP1. Capital preservado.'
              : pnl !== null ? `Operação com perda de ${Math.abs(pnl).toFixed(2)}%. Revisar o setup e contexto de mercado.`
              : 'Operação sem resultado calculável.'}
          </div>
        </div>
      )}
    </div>
  );
}

function DaySummary({ ops }) {
  const today = moment().startOf('day');
  const todayOps = ops.filter(o => moment(o.created_date).isAfter(today));
  const wins = todayOps.filter(o => o.status === 'TP2_HIT').length;
  const losses = todayOps.filter(o => o.status === 'STOP_HIT' && !o.tp1_hit).length;
  const be = todayOps.filter(o => o.status === 'STOP_HIT' && o.tp1_hit).length;
  const totalPnl = todayOps.reduce((acc, o) => acc + (calcPnl(o) ?? 0), 0);
  const wr = todayOps.length > 0 ? Math.round((wins / todayOps.length) * 100) : 0;

  return (
    <div className="rounded-xl p-4" style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3">📅 Resumo do Dia — {moment().format('DD/MM/YYYY')}</div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Total', value: todayOps.length, color: '#00e5ff' },
          { label: '🏆 TP2', value: wins, color: '#00ff80' },
          { label: '🔄 BE', value: be, color: '#ffd166' },
          { label: '🛑 Stop', value: losses, color: '#ff1478' },
          { label: 'Win Rate', value: `${wr}%`, color: wr >= 50 ? '#00ff80' : '#ff9f43' },
        ].map(({ label, value, color }) => (
          <div key={label} className="text-center rounded-lg py-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="text-[9px] font-mono text-muted-foreground mb-1">{label}</div>
            <div className="text-lg font-mono font-bold" style={{ color }}>{value}</div>
          </div>
        ))}
      </div>
      {totalPnl !== 0 && (
        <div className="mt-3 text-center">
          <span className="text-[10px] font-mono text-muted-foreground">Performance do dia: </span>
          <span className="text-sm font-mono font-bold" style={{ color: totalPnl >= 0 ? '#00ff80' : '#ff1478' }}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}%
          </span>
        </div>
      )}
    </div>
  );
}

export default function TradeHistory() {
  const [filterTf, setFilterTf] = useState('all');
  const [filterSide, setFilterSide] = useState('all');
  const [filterResult, setFilterResult] = useState('all'); // 'all' | 'win' | 'loss' | 'be'
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [filterMinPnl, setFilterMinPnl] = useState('');
  const [filterMaxPnl, setFilterMaxPnl] = useState('');
  const [search, setSearch] = useState('');
  const [showChart, setShowChart] = useState(true);
  const [sortBy, setSortBy] = useState('date_desc');

  const { data: operations = [], isLoading } = useQuery({
    queryKey: ['trade-history'],
    queryFn: () => base44.entities.TradeOperation.list('-created_date', 200),
    refetchInterval: 30000,
  });

  const history = operations.filter(o => CLOSED_STATUSES.includes(o.status));

  const filtered = useMemo(() => {
    let list = history.filter(op => {
      if (search && !op.symbol?.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterTf !== 'all' && op.timeframe !== filterTf) return false;
      if (filterSide !== 'all' && op.side !== filterSide) return false;
      if (filterResult !== 'all') {
        const pnl = calcPnl(op);
        if (filterResult === 'win' && !(op.status === 'TP2_HIT')) return false;
        if (filterResult === 'loss' && !(op.status === 'STOP_HIT' && !op.tp1_hit)) return false;
        if (filterResult === 'be' && !(op.status === 'STOP_HIT' && op.tp1_hit)) return false;
      }
      if (filterDateFrom && moment(op.created_date).isBefore(moment(filterDateFrom).startOf('day'))) return false;
      if (filterDateTo && moment(op.created_date).isAfter(moment(filterDateTo).endOf('day'))) return false;
      const pnl = calcPnl(op);
      if (filterMinPnl !== '' && (pnl === null || pnl < parseFloat(filterMinPnl))) return false;
      if (filterMaxPnl !== '' && (pnl === null || pnl > parseFloat(filterMaxPnl))) return false;
      return true;
    });

    if (sortBy === 'date_desc') list.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    else if (sortBy === 'date_asc') list.sort((a, b) => new Date(a.created_date) - new Date(b.created_date));
    else if (sortBy === 'pnl_desc') list.sort((a, b) => (calcPnl(b) ?? -999) - (calcPnl(a) ?? -999));
    else if (sortBy === 'pnl_asc') list.sort((a, b) => (calcPnl(a) ?? 999) - (calcPnl(b) ?? 999));
    else if (sortBy === 'score') list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return list;
  }, [history, filterTf, filterSide, filterResult, filterDateFrom, filterDateTo, filterMinPnl, filterMaxPnl, search, sortBy]);

  const wins = filtered.filter(o => o.status === 'TP2_HIT').length;
  const losses = filtered.filter(o => o.status === 'STOP_HIT' && !o.tp1_hit).length;
  const be = filtered.filter(o => o.status === 'STOP_HIT' && o.tp1_hit).length;
  const totalPnl = filtered.reduce((acc, o) => acc + (calcPnl(o) ?? 0), 0);
  const wr = filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : 0;

  const inputStyle = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)', outline: 'none', fontFamily: 'monospace', fontSize: 10 };
  const filterBtnStyle = (active) => active
    ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }
    : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' };

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Análise de Performance</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Histórico de Trades</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="live-dot" style={{ width: 5, height: 5 }} />
          <span className="text-[10px] font-mono text-muted-foreground">{history.length} trades fechados</span>
        </div>
      </div>

      {/* Day summary */}
      <DaySummary ops={history} />

      {/* P&L Chart */}
      {filtered.length > 1 && (
        <div>
          <button onClick={() => setShowChart(!showChart)} className="flex items-center gap-2 mb-3 group">
            <BarChart2 className="w-4 h-4" style={{ color: '#00e5ff' }} />
            <span className="text-sm font-bold text-foreground/80 group-hover:text-foreground transition-colors">Curva de Capital</span>
            <span className="text-[10px] font-mono" style={{ color: '#00e5ff' }}>{showChart ? '▲ esconder' : '▼ mostrar'}</span>
          </button>
          {showChart && <PnLChart history={filtered} />}
        </div>
      )}

      {/* Filters */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'rgba(10,13,22,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground mb-1">
          <Filter className="w-3 h-3" /> Filtros
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <input type="text" placeholder="Symbol..." value={search} onChange={e => setSearch(e.target.value)}
              className="pl-6 pr-3 py-1.5 rounded-lg w-28 text-[10px]" style={inputStyle} />
          </div>

          {/* Timeframe */}
          {['all', '1h', '4h', '1d'].map(tf => (
            <button key={tf} onClick={() => setFilterTf(tf)}
              className="text-[10px] font-mono px-2 py-1.5 rounded-lg transition-all"
              style={filterBtnStyle(filterTf === tf)}>
              {tf === 'all' ? 'Todos TF' : tf.toUpperCase()}
            </button>
          ))}

          <div className="w-px h-6 self-center" style={{ background: 'rgba(255,255,255,0.07)' }} />

          {/* Side */}
          {[{ id: 'all', label: 'Todos' }, { id: 'BUY', label: '▲ BUY' }, { id: 'SELL', label: '▼ SELL' }].map(s => (
            <button key={s.id} onClick={() => setFilterSide(s.id)}
              className="text-[10px] font-mono px-2 py-1.5 rounded-lg transition-all"
              style={filterSide === s.id && s.id === 'BUY' ? { background: 'rgba(0,255,128,0.12)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }
                : filterSide === s.id && s.id === 'SELL' ? { background: 'rgba(255,20,120,0.12)', border: '1px solid rgba(255,20,120,0.3)', color: '#ff1478' }
                : filterBtnStyle(filterSide === s.id)}>
              {s.label}
            </button>
          ))}

          <div className="w-px h-6 self-center" style={{ background: 'rgba(255,255,255,0.07)' }} />

          {/* Result */}
          {[{ id: 'all', label: 'Todos' }, { id: 'win', label: '🏆 Win' }, { id: 'be', label: '🔄 BE' }, { id: 'loss', label: '🛑 Loss' }].map(r => (
            <button key={r.id} onClick={() => setFilterResult(r.id)}
              className="text-[10px] font-mono px-2 py-1.5 rounded-lg transition-all"
              style={filterBtnStyle(filterResult === r.id)}>
              {r.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-[9px] font-mono text-muted-foreground">Data:</span>
          <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
            className="px-2 py-1 rounded-lg text-[10px]" style={inputStyle} />
          <span className="text-[9px] font-mono text-muted-foreground">até</span>
          <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
            className="px-2 py-1 rounded-lg text-[10px]" style={inputStyle} />

          <span className="text-[9px] font-mono text-muted-foreground ml-2">P&L%:</span>
          <input type="number" placeholder="min" value={filterMinPnl} onChange={e => setFilterMinPnl(e.target.value)}
            className="px-2 py-1 rounded-lg w-16 text-[10px]" style={inputStyle} />
          <span className="text-[9px] font-mono text-muted-foreground">a</span>
          <input type="number" placeholder="max" value={filterMaxPnl} onChange={e => setFilterMaxPnl(e.target.value)}
            className="px-2 py-1 rounded-lg w-16 text-[10px]" style={inputStyle} />

          <span className="text-[9px] font-mono text-muted-foreground ml-2">Ordenar:</span>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)}
            className="px-2 py-1 rounded-lg text-[10px]" style={inputStyle}>
            <option value="date_desc">📅 Mais recente</option>
            <option value="date_asc">📅 Mais antigo</option>
            <option value="pnl_desc">💹 Maior P&L</option>
            <option value="pnl_asc">💹 Menor P&L</option>
            <option value="score">🔥 Score</option>
          </select>

          {(search || filterTf !== 'all' || filterSide !== 'all' || filterResult !== 'all' || filterDateFrom || filterDateTo || filterMinPnl || filterMaxPnl) && (
            <button onClick={() => { setSearch(''); setFilterTf('all'); setFilterSide('all'); setFilterResult('all'); setFilterDateFrom(''); setFilterDateTo(''); setFilterMinPnl(''); setFilterMaxPnl(''); }}
              className="text-[9px] font-mono px-2 py-1 rounded-lg transition-all"
              style={{ background: 'rgba(255,20,120,0.08)', border: '1px solid rgba(255,20,120,0.2)', color: '#ff1478' }}>
              ✕ Limpar
            </button>
          )}
        </div>
      </div>

      {/* Summary strip */}
      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center gap-4 px-4 py-2.5 rounded-xl text-[10px] font-mono"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <span className="text-muted-foreground">{filtered.length} trades</span>
          <span style={{ color: '#00ff80' }}>🏆 {wins} win</span>
          <span style={{ color: '#ffd166' }}>🔄 {be} BE</span>
          <span style={{ color: '#ff1478' }}>🛑 {losses} loss</span>
          <span style={{ color: wr >= 50 ? '#00ff80' : '#ff9f43' }}>WR {wr}%</span>
          <span className="ml-auto font-bold" style={{ color: totalPnl >= 0 ? '#00ff80' : '#ff1478' }}>
            Total: {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}%
          </span>
        </div>
      )}

      {/* Trade cards */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl p-12 text-center" style={{ background: 'rgba(10,13,22,0.6)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <History className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
          <p className="text-muted-foreground text-sm">Nenhum trade encontrado com esses filtros.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(op => <HistoryCard key={op.id} op={op} />)}
        </div>
      )}
    </div>
  );
}