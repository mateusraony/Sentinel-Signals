import React from 'react';
import { X, TrendingUp, TrendingDown, Clock, Activity } from 'lucide-react';
import moment from 'moment';

function fmt(price) {
  if (!price && price !== 0) return '—';
  if (price >= 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

const STATUS_CFG = {
  SIGNAL_CONFIRMED: { label: 'Entrada Confirmada', color: '#00ff80' },
  RUNNER_ACTIVE:    { label: 'Runner Ativo',        color: '#ffd166' },
  TP2_HIT:          { label: 'TP2 Atingido',        color: '#00ff80' },
  STOP_HIT:         { label: 'Stop Atingido',       color: '#ff1478' },
  INVALIDATED:      { label: 'Invalidado',          color: '#ff9f43' },
  CLOSED:           { label: 'Encerrado',           color: '#64748b' },
};

export default function AssetDrawer({ asset, signals, tradeOps, onClose }) {
  if (!asset) return null;

  const assetSignals = signals
    .filter(s => s.asset_id === asset.id)
    .sort((a, b) => new Date(b.created_date) - new Date(a.created_date))
    .slice(0, 8);

  const assetOps = tradeOps
    .filter(o => o.asset_id === asset.id)
    .sort((a, b) => new Date(b.created_date) - new Date(a.created_date));

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-sm z-50 flex flex-col"
        style={{ background: 'rgba(8,10,18,0.97)', border: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(24px)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div>
            <div className="font-bold text-base text-foreground">{asset.display_name}</div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[9px] font-mono text-muted-foreground">{asset.exchange?.toUpperCase()}</span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#00ff80', boxShadow: '0 0 4px #00ff80', display: 'inline-block' }} />
                <span className="text-[9px] font-mono" style={{ color: '#00ff80' }}>LIVE</span>
              </span>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/[0.05] transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Trade Operations */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Activity className="w-3.5 h-3.5" style={{ color: '#00e5ff' }} />
              <span className="text-xs font-bold text-foreground">Operações</span>
              <span className="text-[9px] font-mono text-muted-foreground">({assetOps.length})</span>
            </div>
            {assetOps.length === 0 ? (
              <p className="text-[10px] font-mono text-muted-foreground">Nenhuma operação registrada.</p>
            ) : (
              <div className="space-y-2">
                {assetOps.map(op => {
                  const cfg = STATUS_CFG[op.status] || { label: op.status, color: '#64748b' };
                  const isBuy = op.side === 'BUY';
                  return (
                    <div key={op.id} className="rounded-lg px-3 py-2.5"
                      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono font-bold" style={{ color: isBuy ? '#00ff80' : '#ff1478' }}>
                            {isBuy ? <TrendingUp className="inline w-3 h-3 mr-0.5" /> : <TrendingDown className="inline w-3 h-3 mr-0.5" />}
                            {op.side}
                          </span>
                          <span className="text-[9px] font-mono text-muted-foreground">{op.timeframe?.toUpperCase()}</span>
                        </div>
                        <span className="text-[9px] font-mono" style={{ color: cfg.color }}>{cfg.label}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5">
                        {[
                          { l: 'Entrada', v: op.entry_price },
                          { l: 'TP1', v: op.tp1 },
                          { l: 'TP2', v: op.tp2 },
                        ].map(({ l, v }) => (
                          <div key={l}>
                            <div className="text-[8px] font-mono text-muted-foreground">{l}</div>
                            <div className="text-[10px] font-mono text-foreground/70">${fmt(v)}</div>
                          </div>
                        ))}
                      </div>
                      <div className="text-[8px] font-mono text-muted-foreground mt-1.5 flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" />
                        {moment(op.created_date).format('DD/MM/YY HH:mm')}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Signals */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-3.5 h-3.5 flex items-center justify-center">
                <span className="w-2 h-2 rounded-full" style={{ background: '#ffd166', boxShadow: '0 0 4px #ffd166', display: 'inline-block' }} />
              </span>
              <span className="text-xs font-bold text-foreground">Sinais Recentes</span>
              <span className="text-[9px] font-mono text-muted-foreground">({assetSignals.length})</span>
            </div>
            {assetSignals.length === 0 ? (
              <p className="text-[10px] font-mono text-muted-foreground">Nenhum sinal registrado.</p>
            ) : (
              <div className="space-y-1.5">
                {assetSignals.map(sig => {
                  const isBuy = sig.signal_type === 'BUY';
                  return (
                    <div key={sig.id} className="flex items-start gap-2 px-3 py-2 rounded-lg"
                      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
                      <span className="mt-0.5 shrink-0 text-[10px] font-mono font-bold" style={{ color: isBuy ? '#00ff80' : '#ff1478' }}>
                        {isBuy ? '↑' : '↓'} {sig.signal_type}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[9px] font-mono text-muted-foreground">{sig.timeframe?.toUpperCase()}</span>
                          <span className="text-[9px] font-mono text-foreground/60">${fmt(sig.price_at_signal)}</span>
                          {sig.context?.score && (
                            <span className="text-[8px] font-mono" style={{ color: '#ffd166' }}>Score {sig.context.score}</span>
                          )}
                        </div>
                        <p className="text-[8px] font-mono text-muted-foreground mt-0.5 leading-tight line-clamp-2">{sig.reason}</p>
                        <div className="text-[8px] font-mono text-muted-foreground/60 mt-0.5">
                          {moment(sig.created_date).fromNow()}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}