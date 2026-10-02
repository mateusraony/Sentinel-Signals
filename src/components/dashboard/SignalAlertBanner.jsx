import React, { useEffect, useRef, useState } from 'react';
import { X, Bell } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import moment from 'moment';
// Auditoria do Telegram, Fase 4 (2026-10-02) — emoji do estágio e rótulo de
// prioridade vêm da MESMA fonte que telegram.js/adminTelegram.js (e, pro
// priorityLabel, Alerts.jsx) já usam, em vez de literais duplicados aqui.
import { NOTIFICATION_STAGES } from '@/lib/notificationVocabulary';
import { priorityLabel } from '@/lib/signalStatus';

/**
 * Banner that appears at the top of the Dashboard when a new RF signal is confirmed.
 * Auto-dismisses after 15s. Shows the last N unread signals.
 */
export default function SignalAlertBanner({ signals = [] }) {
  const [alerts, setAlerts] = useState([]);
  const seenIds = useRef(new Set());

  useEffect(() => {
    const cutoff = Date.now() - 5 * 60 * 1000; // only last 5min
    const fresh = signals.filter(s => {
      if (seenIds.current.has(s.id)) return false;
      if (s.source !== 'range_filter') return false;
      // Same flag Telegram uses (known-risks.md item 28) — a signal
      // suppressed by alert_cooldown_minutes shouldn't raise this banner
      // either; `notified === undefined` (older records) counts as notified.
      if (s.notified === false) return false;
      if (new Date(s.created_date).getTime() < cutoff) {
        seenIds.current.add(s.id);
        return false;
      }
      return true;
    });
    if (!fresh.length) return;
    fresh.forEach(s => seenIds.current.add(s.id));
    setAlerts(prev => [...fresh, ...prev].slice(0, 5));
  }, [signals]);

  // Auto-dismiss oldest after 15s
  useEffect(() => {
    if (!alerts.length) return;
    const timer = setTimeout(() => setAlerts(prev => prev.slice(0, -1)), 15000);
    return () => clearTimeout(timer);
  }, [alerts]);

  const dismiss = (id) => setAlerts(prev => prev.filter(a => a.id !== id));

  if (!alerts.length) return null;

  return (
    <div className="space-y-1.5">
      {alerts.map(sig => {
        const isBuy = sig.signal_type === 'BUY';
        const symbol = sig.symbol?.replace('USDT', '/USDT') || sig.symbol;
        const score = sig.context?.score || 0;
        const borderColor = isBuy ? 'rgba(0,255,128,0.45)' : 'rgba(255,20,120,0.45)';
        const bgColor = isBuy ? 'rgba(0,255,128,0.06)' : 'rgba(255,20,120,0.06)';
        const textColor = isBuy ? '#00ff80' : '#ff1478';

        return (
          <div key={sig.id}
            className="flex items-center gap-3 px-4 py-2.5 rounded-xl"
            style={{ background: bgColor, border: `1px solid ${borderColor}`, boxShadow: `0 0 16px ${isBuy ? 'rgba(0,255,128,0.08)' : 'rgba(255,20,120,0.08)'}` }}>
            {/* Fase 5 da auditoria do Telegram (2026-10-02), item 5.2 — achado
                real de acessibilidade: único animate-pulse do Dashboard sem o
                guard motion-reduce que AssetCard.jsx/SignalToast.jsx/
                TradeCard.jsx/index.css já têm. */}
            <Bell className="w-3.5 h-3.5 shrink-0 animate-pulse motion-reduce:animate-none" style={{ color: textColor }} />
            <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
              <span className="text-10px font-mono font-bold" style={{ color: textColor }}>
                {NOTIFICATION_STAGES.SIGNAL_DETECTED.emoji} SINAL {sig.signal_type}
              </span>
              <span className="font-bold text-xs text-foreground">{symbol}</span>
              <span className="text-9px font-mono px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.5)' }}>
                {sig.timeframe?.toUpperCase()}
              </span>
              {score > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-9px font-mono cursor-help" tabIndex={0} style={{ color: score >= 85 ? '#ffd166' : 'rgba(255,255,255,0.4)' }}>
                      🔥 Score {score}/100
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
                    Confluência de indicadores técnicos alinhados — não é uma probabilidade de acerto do trade.
                  </TooltipContent>
                </Tooltip>
              )}
              {sig.priority && (
                <span className="text-9px font-mono" style={{ color: sig.priority === 'high' ? '#ff9f43' : 'rgba(255,255,255,0.35)' }}>
                  {priorityLabel(sig.priority)} prioridade
                </span>
              )}
              <span className="text-9px font-mono text-muted-foreground">{moment(sig.created_date).fromNow()}</span>
            </div>
            <button onClick={() => dismiss(sig.id)}
              className="shrink-0 p-1 rounded hover:bg-white/[0.06] transition-colors">
              <X className="w-3 h-3 text-muted-foreground" />
            </button>
          </div>
        );
      })}
    </div>
  );
}