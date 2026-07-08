import React from 'react';
import { cn } from '@/lib/utils';
import { Crosshair, ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';

const ALIGNMENT_CONFIG = {
  aligned: { label: 'Alinhado', icon: Crosshair },
  partially_aligned: { label: 'Parcial', icon: Minus },
  against_trend: { label: 'Contra tendência', icon: Minus },
  unknown: { label: 'Indefinido', icon: Minus },
};

export default function AlignmentBanner({ alignment }) {
  if (!alignment) return null;

  const config = ALIGNMENT_CONFIG[alignment.alignment] || ALIGNMENT_CONFIG.unknown;
  const isBullish = alignment.direction === 'bullish';
  const isBearish = alignment.direction === 'bearish';

  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium",
      alignment.alignment === 'aligned' && isBullish && "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
      alignment.alignment === 'aligned' && isBearish && "bg-rose-500/10 border-rose-500/20 text-rose-400",
      alignment.alignment === 'partially_aligned' && "bg-amber-500/10 border-amber-500/20 text-amber-400",
      alignment.alignment === 'against_trend' && "bg-rose-500/10 border-rose-500/20 text-rose-400",
      alignment.alignment === 'unknown' && "bg-muted border-border text-muted-foreground",
    )}>
      {isBullish && <ArrowUpRight className="w-3.5 h-3.5" />}
      {isBearish && <ArrowDownRight className="w-3.5 h-3.5" />}
      {!isBullish && !isBearish && <config.icon className="w-3.5 h-3.5" />}
      <span>{config.label}</span>
      {alignment.description && (
        <span className="text-muted-foreground ml-1 hidden sm:inline">— {alignment.description}</span>
      )}
    </div>
  );
}