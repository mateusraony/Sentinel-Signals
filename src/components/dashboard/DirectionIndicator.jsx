import React from 'react';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';

export default function DirectionIndicator({ direction, label }) {
  const isUp = direction === 1;
  const isDown = direction === -1;

  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-[9px] font-mono tracking-widest uppercase"
        style={{ color: 'rgba(255,255,255,0.3)' }}
      >{label}</span>
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center"
        style={{
          background: isUp
            ? 'rgba(0,255,128,0.1)'
            : isDown
            ? 'rgba(255,20,120,0.1)'
            : 'rgba(255,255,255,0.04)',
          border: isUp
            ? '1px solid rgba(0,255,128,0.3)'
            : isDown
            ? '1px solid rgba(255,20,120,0.3)'
            : '1px solid rgba(255,255,255,0.08)',
          boxShadow: isUp
            ? '0 0 8px rgba(0,255,128,0.15)'
            : isDown
            ? '0 0 8px rgba(255,20,120,0.15)'
            : 'none',
        }}
      >
        {isUp && <ArrowUp className="w-3.5 h-3.5 arrow-up-glow" />}
        {isDown && <ArrowDown className="w-3.5 h-3.5 arrow-down-glow" />}
        {!isUp && !isDown && <Minus className="w-3 h-3 text-muted-foreground" />}
      </div>
    </div>
  );
}