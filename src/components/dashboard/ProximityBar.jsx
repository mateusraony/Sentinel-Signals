import React from 'react';
import { Crosshair } from 'lucide-react';

/**
 * Calculates how close the current price is to triggering an RF signal.
 * Uses rf_filter_value, last_close, rf_direction from AssetState.
 * Returns null if insufficient data or already has active signal.
 *
 * Proximity levels:
 *   < 1%  → "MUITO PRÓXIMO" (very close, pulse)
 *   < 2%  → "PRÓXIMO" (close)
 *   < 3%  → "Observando" (watching)
 *   ≥ 3%  → null (not close enough to show)
 */
export function calcProximity(state) {
  if (!state || !state.rf_filter_value || !state.last_close) return null;
  const { rf_filter_value, last_close, rf_direction } = state;
  if (rf_direction === 0 || rf_direction === undefined || rf_direction === null) return null;

  const distance = Math.abs(last_close - rf_filter_value) / rf_filter_value * 100;
  if (distance >= 3.5) return null; // Not close enough

  const side = rf_direction === 1 ? 'BUY' : 'SELL';

  let level;
  if (distance < 1) level = 'very_close';
  else if (distance < 2) level = 'close';
  else level = 'watching';

  return { distance, side, level };
}

export default function ProximityBar({ state }) {
  const prox = calcProximity(state);
  if (!prox) return null;

  const { distance, side, level } = prox;
  const sideColor = side === 'BUY' ? '#00ff80' : '#ff1478';

  const config = {
    very_close: {
      label: 'MUITO PRÓXIMO',
      bg: 'rgba(255,209,102,0.15)',
      border: 'rgba(255,209,102,0.45)',
      color: '#ffd166',
      pulse: true,
      icon: '🔥',
    },
    close: {
      label: 'PRÓXIMO',
      bg: 'rgba(255,209,102,0.1)',
      border: 'rgba(255,209,102,0.3)',
      color: '#ffd166',
      pulse: false,
      icon: '⚡',
    },
    watching: {
      label: 'Observando',
      bg: 'rgba(255,209,102,0.05)',
      border: 'rgba(255,209,102,0.15)',
      color: 'rgba(255,209,102,0.6)',
      pulse: false,
      icon: '👀',
    },
  };

  const cfg = config[level];

  // Progress bar: 0% distance = full bar (at filter), 3.5% = empty
  const progress = Math.max(0, Math.min(100, ((3.5 - distance) / 3.5) * 100));

  return (
    <>
      {cfg.pulse && (
        <style>{`
          @keyframes prox-pulse {
            0%,100% { box-shadow: 0 0 6px rgba(255,209,102,0.2); }
            50% { box-shadow: 0 0 16px rgba(255,209,102,0.5), 0 0 32px rgba(255,209,102,0.15); }
          }
          .prox-pulse { animation: prox-pulse 1.5s ease-in-out infinite; }
        `}</style>
      )}
      <div
        className={`rounded-lg px-3 py-2 mb-2.5 ${cfg.pulse ? 'prox-pulse' : ''}`}
        style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="flex items-center gap-1 text-[10px] font-mono font-bold" style={{ color: cfg.color }}>
            <Crosshair className="w-3 h-3" />
            {cfg.icon} {cfg.label}
          </span>
          <span className="flex items-center gap-1.5 text-[10px] font-mono">
            <span style={{ color: sideColor }}>{side === 'BUY' ? '↑' : '↓'} {side}</span>
            <span style={{ color: 'rgba(255,255,255,0.35)' }}>{distance.toFixed(2)}%</span>
          </span>
        </div>
        {/* Progress bar showing proximity to filter */}
        <div className="relative h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
          <div
            className="absolute h-full rounded-full transition-all duration-500"
            style={{
              width: `${progress}%`,
              background: `linear-gradient(90deg, ${sideColor}80, #ffd166)`,
              boxShadow: level === 'very_close' ? '0 0 6px rgba(255,209,102,0.6)' : 'none',
            }}
          />
        </div>
      </div>
    </>
  );
}