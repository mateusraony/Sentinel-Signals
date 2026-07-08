import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export default function SignalBadge({ signal, size = 'md' }) {
  const isBuy = signal === 'BUY';
  const isSell = signal === 'SELL';
  const isNone = !signal || signal === 'NONE';

  const pad = size === 'sm' ? '2px 8px' : '4px 12px';
  const fs = size === 'sm' ? 11 : 13;
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';

  if (isNone) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md font-mono font-semibold"
        style={{ padding: pad, fontSize: fs, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.3)' }}
      >
        <Minus className={iconSize} />
        <span>—</span>
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md font-mono font-bold ${isBuy ? 'buy-badge-glow' : 'sell-badge-glow'}`}
      style={{ padding: pad, fontSize: fs }}
    >
      {isBuy
        ? <TrendingUp className={iconSize} />
        : <TrendingDown className={iconSize} />
      }
      <span>{signal}</span>
    </span>
  );
}