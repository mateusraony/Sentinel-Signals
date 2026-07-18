import React, { useEffect, useRef, useState } from 'react';
import { TrendingUp, TrendingDown, X } from 'lucide-react';

/**
 * In-app visual notification for new signals.
 * Appears as a floating toast when a new range_filter signal arrives (< 3min).
 */
export default function SignalToast({ signals = [] }) {
  const [queue, setQueue] = useState([]);
  const seenIds = useRef(new Set());

  useEffect(() => {
    const cutoff = Date.now() - 3 * 60 * 1000;
    const fresh = signals.filter(s => {
      if (seenIds.current.has(s.id)) return false;
      if (s.source !== 'range_filter') return false;
      // Same flag Telegram uses (known-risks.md item 28) — a signal
      // suppressed by alert_cooldown_minutes shouldn't pop an in-app toast
      // either; `notified === undefined` (older records, pre-2026-07-18)
      // is treated as notified so existing history isn't hidden.
      if (s.notified === false) return false;
      if (new Date(s.created_date).getTime() < cutoff) {
        seenIds.current.add(s.id);
        return false;
      }
      return true;
    });

    if (fresh.length === 0) return;

    fresh.forEach(s => seenIds.current.add(s.id));

    setQueue(prev => [
      ...fresh.map(s => ({ ...s, _toastId: s.id + '_' + Date.now() })),
      ...prev,
    ].slice(0, 4)); // max 4 toasts
  }, [signals]);

  const dismiss = (toastId) => setQueue(prev => prev.filter(t => t._toastId !== toastId));

  // Auto-dismiss after 7s
  useEffect(() => {
    if (!queue.length) return;
    const timers = queue.map(t =>
      setTimeout(() => dismiss(t._toastId), 7000)
    );
    return () => timers.forEach(clearTimeout);
  }, [queue.map(t => t._toastId).join(',')]);

  if (!queue.length) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none"
      style={{ maxWidth: 320 }}>
      {queue.map(sig => {
        const isBuy = sig.signal_type === 'BUY';
        const symbol = sig.symbol?.replace('USDT', '/USDT') || sig.symbol;
        const score = sig.context?.score || 0;
        const borderColor = isBuy ? 'rgba(0,255,128,0.5)' : 'rgba(255,20,120,0.5)';
        const glowColor = isBuy ? 'rgba(0,255,128,0.15)' : 'rgba(255,20,120,0.15)';
        const textColor = isBuy ? '#00ff80' : '#ff1478';

        return (
          <div key={sig._toastId}
            className="rounded-xl px-4 py-3 pointer-events-auto animate-in slide-in-from-right-4 fade-in duration-300"
            style={{
              background: 'rgba(8,10,18,0.97)',
              border: `1px solid ${borderColor}`,
              boxShadow: `0 0 24px ${glowColor}, 0 4px 20px rgba(0,0,0,0.5)`,
              backdropFilter: 'blur(20px)',
            }}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <div className="flex items-center justify-center w-7 h-7 rounded-lg shrink-0"
                  style={{ background: isBuy ? 'rgba(0,255,128,0.12)' : 'rgba(255,20,120,0.12)', border: `1px solid ${borderColor}` }}>
                  {isBuy
                    ? <TrendingUp className="w-3.5 h-3.5" style={{ color: textColor }} />
                    : <TrendingDown className="w-3.5 h-3.5" style={{ color: textColor }} />
                  }
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-bold text-xs text-foreground">{symbol}</span>
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)' }}>
                      {sig.timeframe?.toUpperCase()}
                    </span>
                    <span className="text-[9px] font-mono font-bold" style={{ color: textColor }}>
                      {sig.signal_type}
                    </span>
                  </div>
                  <div className="text-[9px] font-mono mt-0.5" style={{ color: score >= 85 ? '#ffd166' : 'rgba(255,255,255,0.4)' }}>
                    Score {score}/100 · Sinal Confirmado
                  </div>
                </div>
              </div>
              <button onClick={() => dismiss(sig._toastId)}
                className="shrink-0 p-0.5 rounded hover:bg-white/10 transition-colors">
                <X className="w-3 h-3 text-muted-foreground" />
              </button>
            </div>
            {/* Progress bar */}
            <div className="mt-2 h-0.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div className="h-full rounded-full" style={{
                width: '100%',
                background: textColor,
                animation: 'shrink-progress 7s linear forwards',
                opacity: 0.5,
              }} />
            </div>
            <style>{`@keyframes shrink-progress { from { width: 100% } to { width: 0% } }`}</style>
          </div>
        );
      })}
    </div>
  );
}