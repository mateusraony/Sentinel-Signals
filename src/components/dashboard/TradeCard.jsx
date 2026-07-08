import React, { useState } from 'react';
import moment from 'moment';
import { CheckCircle2, AlertTriangle, Clock, TrendingUp, TrendingDown, ChevronDown, ChevronUp, Zap } from 'lucide-react';

const STATUS_CONFIG = {
  SIGNAL_CONFIRMED: {
    label: '🟢 Entrada Confirmada', emoji: '🟢',
    desc: 'Aguardando preço atingir TP1',
    color: '#00ff80', bg: 'rgba(0,255,128,0.08)', border: 'rgba(0,255,128,0.28)',
  },
  RUNNER_ACTIVE: {
    label: '⚡ Runner Ativo', emoji: '⚡',
    desc: 'TP1 atingido — trailing stop ativo',
    color: '#ffd166', bg: 'rgba(255,209,102,0.08)', border: 'rgba(255,209,102,0.28)',
  },
  TP2_HIT: {
    label: '🏆 TP2 Atingido', emoji: '🏆',
    desc: 'Operação encerrada com lucro máximo',
    color: '#00ff80', bg: 'rgba(0,255,128,0.1)', border: 'rgba(0,255,128,0.4)',
  },
  STOP_HIT: {
    label: '🛑 Stop Atingido', emoji: '🛑',
    desc: 'Operação encerrada por stop',
    color: '#ff1478', bg: 'rgba(255,20,120,0.08)', border: 'rgba(255,20,120,0.28)',
  },
  INVALIDATED: {
    label: '⚠️ Invalidado', emoji: '⚠️',
    desc: 'Condição técnica deixou de existir',
    color: '#ff9f43', bg: 'rgba(255,159,67,0.08)', border: 'rgba(255,159,67,0.28)',
  },
  CLOSED: {
    label: '✖ Encerrado', emoji: '✖',
    desc: 'Encerrado manualmente',
    color: '#64748b', bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.2)',
  },
};

const DATA_STATUS = {
  LIVE:    { label: '🔴 LIVE',    color: '#00ff80' },
  STALE:   { label: '⚠️ STALE',  color: '#ff9f43' },
  OFFLINE: { label: '⛔ OFFLINE', color: '#ff1478' },
  ERROR:   { label: '❌ ERROR',   color: '#ff1478' },
};

function fmt(price) {
  if (!price && price !== 0) return '—';
  if (price >= 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  return price.toFixed(2);
}

function fmtBRT(iso) {
  if (!iso) return '—';
  return moment(iso).utcOffset(-3).format('DD/MM HH:mm');
}

function ScoreBar({ score }) {
  const pct = Math.max(0, Math.min(100, score || 0));
  const color = pct >= 85 ? '#00ff80' : pct >= 65 ? '#ffd166' : '#ff9f43';
  const label = pct >= 85 ? '🔥 Forte' : pct >= 65 ? '⚡ Moderado' : '〰 Fraco';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}60` }} />
      </div>
      <span className="text-[10px] font-mono font-bold" style={{ color }}>{pct}/100</span>
      <span className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>{label}</span>
    </div>
  );
}

function TFTrendRow({ op }) {
  // Extraído do context do sinal — mostra direção RF por timeframe
  const dirs = {
    '1d': op.tf_1d_direction ?? null,
    '4h': op.tf_4h_direction ?? null,
    '1h': op.tf_1h_direction ?? null,
  };
  const tfs = Object.entries(dirs).filter(([, v]) => v !== null);
  if (!tfs.length) return null;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {tfs.map(([tf, dir]) => {
        const color = dir === 1 ? '#00ff80' : dir === -1 ? '#ff1478' : '#64748b';
        const icon = dir === 1 ? '▲' : dir === -1 ? '▼' : '—';
        const label = dir === 1 ? 'Bull' : dir === -1 ? 'Bear' : 'Neu';
        return (
          <span key={tf} className="flex items-center gap-1 text-[9px] font-mono">
            <span style={{ color: 'rgba(255,255,255,0.3)' }}>{tf.toUpperCase()}</span>
            <span style={{ color }}>{icon} {label}</span>
          </span>
        );
      })}
    </div>
  );
}

function PriceGrid({ op }) {
  const stopColor = op.tp1_hit ? '#ffd166' : '#ff1478';
  const stopLabel = op.tp1_hit ? '🔄 Stop (BE)' : '🛑 Stop';

  return (
    <div className="grid grid-cols-2 gap-2">
      {[
        { label: '📍 Entrada', value: op.entry_price, color: '#e2e8f0' },
        { label: stopLabel, value: op.current_stop, color: stopColor },
        { label: '🎯 TP1 ' + (op.tp1_hit ? '✅' : ''), value: op.tp1, color: op.tp1_hit ? '#00ff80' : '#ffd166' },
        { label: '🏆 TP2 ' + (op.tp2_hit ? '✅' : ''), value: op.tp2, color: op.tp2_hit ? '#00ff80' : 'rgba(255,209,102,0.55)' },
      ].map(({ label, value, color }) => (
        <div key={label} className="rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="text-[9px] font-mono text-muted-foreground mb-0.5">{label}</div>
          <div className="text-sm font-mono font-bold" style={{ color }}>${fmt(value)}</div>
        </div>
      ))}
    </div>
  );
}

function StatusBanner({ op }) {
  const banners = {
    SIGNAL_CONFIRMED: { text: '👀 Monitorando — aguardar preço avançar para TP1', color: '#00ff80', bg: 'rgba(0,255,128,0.06)' },
    RUNNER_ACTIVE:    { text: '🚀 Runner ativo — 50% realizado no TP1, deixar correr', color: '#ffd166', bg: 'rgba(255,209,102,0.06)' },
    TP2_HIT:          { text: '🏆 Encerrado com lucro máximo no TP2 — parabéns!', color: '#00ff80', bg: 'rgba(0,255,128,0.06)' },
    STOP_HIT:         { text: op.tp1_hit ? '🔄 Stop no breakeven — sem prejuízo' : '🛑 Stop atingido — revisar setup', color: op.tp1_hit ? '#ffd166' : '#ff1478', bg: op.tp1_hit ? 'rgba(255,209,102,0.06)' : 'rgba(255,20,120,0.06)' },
    INVALIDATED:      { text: '⚠️ Sinal invalidado — não operar agora', color: '#ff9f43', bg: 'rgba(255,159,67,0.06)' },
    CLOSED:           { text: '✖ Operação encerrada manualmente', color: '#64748b', bg: 'rgba(100,116,139,0.06)' },
  };
  const b = banners[op.status];
  if (!b) return null;
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: b.bg, border: `1px solid ${b.color}22` }}>
      <p className="text-[10px] font-mono leading-relaxed" style={{ color: b.color }}>{b.text}</p>
    </div>
  );
}

export default function TradeCard({ operation: op }) {
  const [showReasons, setShowReasons] = useState(false);
  const status = STATUS_CONFIG[op.status] || STATUS_CONFIG.CLOSED;
  const dataStatus = DATA_STATUS[op.data_status] || DATA_STATUS.LIVE;
  const isBuy = op.side === 'BUY';
  const tfLabel = op.timeframe?.toUpperCase();
  const exitModeLabel = { RANGE_FILTER: '🔵 RF', ATR_TRAILING: '🟡 ATR Trail', HYBRID_RF_ATR: '🟣 RF+ATR' }[op.exit_mode] || op.exit_mode;
  const reasons = op.signal_reasons || [];

  // Extract tf directions from signal_reasons or context (best effort)
  const tfOp = {
    tf_1d_direction: op.tf_1d_direction ?? null,
    tf_4h_direction: op.tf_4h_direction ?? null,
    tf_1h_direction: op.tf_1h_direction ?? null,
  };

  return (
    <div className="rounded-t-xl p-4 space-y-3 transition-all duration-300" style={{
      background: 'rgba(10,13,22,0.85)',
      backdropFilter: 'blur(20px)',
      borderLeft: `1px solid ${status.border}`,
      borderRight: `1px solid ${status.border}`,
      borderTop: `1px solid ${status.border}`,
      boxShadow: `0 0 24px ${status.bg}`,
    }}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-base text-foreground">{op.symbol?.replace('USDT', '/USDT')}</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.08)' }}>
            {tfLabel}
          </span>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded font-bold"
            style={isBuy
              ? { background: 'rgba(0,255,128,0.12)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.3)' }
              : { background: 'rgba(255,20,120,0.12)', color: '#ff1478', border: '1px solid rgba(255,20,120,0.3)' }}>
            {isBuy ? <TrendingUp className="inline w-3 h-3 mr-1" /> : <TrendingDown className="inline w-3 h-3 mr-1" />}
            {op.side}
          </span>
        </div>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded shrink-0 font-semibold"
          style={{ background: status.bg, color: status.color, border: `1px solid ${status.border}` }}>
          {status.label}
        </span>
      </div>

      {/* Status banner — plain language */}
      <StatusBanner op={op} />

      {/* Candle + data status */}
      <div className="flex items-center justify-between text-[9px] font-mono">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span>{fmtBRT(op.candle_open_time)} → {fmtBRT(op.candle_close_time)} BRT</span>
        </div>
        <div className="flex items-center gap-2">
          <span style={{ color: op.candle_status === 'CLOSED' ? '#00ff80' : '#ff9f43' }}>
            {op.candle_status === 'CLOSED' ? '✅ Fechado' : '⏳ Aberto'}
          </span>
          <span style={{ color: dataStatus.color }}>{dataStatus.label}</span>
        </div>
      </div>

      {/* TF Trend row */}
      <TFTrendRow op={tfOp} />

      {/* Score */}
      <ScoreBar score={op.score} />

      {/* Price grid */}
      <PriceGrid op={op} />

      {/* Gestão */}
      <div className="flex items-center justify-between text-[9px] font-mono text-muted-foreground px-0.5">
        <span>📊 {op.partial_percent}% TP1 · {op.runner_percent}% runner</span>
        <span style={{ color: 'rgba(0,229,255,0.7)' }}>{exitModeLabel}</span>
      </div>

      {/* Motivos técnicos */}
      {reasons.length > 0 && (
        <div>
          <button onClick={() => setShowReasons(!showReasons)}
            className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground/60 transition-colors">
            {showReasons ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            🔍 Motivos técnicos ({reasons.length})
          </button>
          {showReasons && (
            <div className="mt-2 space-y-1 pl-2">
              {reasons.map((r, i) => (
                <div key={i} className="text-[10px] font-mono text-muted-foreground flex items-start gap-1.5">
                  <span style={{ color: '#00ff80', marginTop: 1 }}>·</span> {r}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}