import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function TickerBar() {
  const { data: states = [] } = useQuery({
    queryKey: ['asset-states'],
    queryFn: () => backend.entities.AssetState.list(),
    refetchInterval: 60000
  });

  const { data: assets = [] } = useQuery({
    queryKey: ['all-assets-ticker'],
    queryFn: () => backend.entities.MonitoredAsset.filter({ is_active: true })
  });

  const items = assets.map((asset) => {
    const state = states.find((s) => s.asset_id === asset.id && s.timeframe === '1h');
    return { asset, state };
  }).filter((i) => i.state?.last_close);

  if (items.length === 0) return null;

  const doubled = [...items, ...items]; // loop seamless

  return (
    <div className="h-8 border-b border-border/50 bg-card/30 backdrop-blur-sm flex items-center overflow-hidden rounded-lg my-1">
      <div className="flex items-center gap-2 px-3 shrink-0 border-r border-border/40">
        <div className="live-dot" />
        <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">Live</span>
      </div>
      <div className="ticker-container flex-1">
        <div className="ticker-inner">
          {doubled.map((item, i) => {
            const dir = item.state?.rf_direction;
            const isBull = dir === 1;
            const isBear = dir === -1;
            return (
              <span key={i} className="inline-flex items-center gap-2 px-6 text-xs font-mono">
                <span className="text-muted-foreground">{item.asset.symbol}</span>
                <span className={cn(
                  "font-semibold",
                  isBull && "value-positive",
                  isBear && "value-negative",
                  !isBull && !isBear && "value-neutral"
                )}>
                  ${item.state.last_close?.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
                {isBull && <TrendingUp className="w-3 h-3 arrow-up-glow" />}
                {isBear && <TrendingDown className="w-3 h-3 arrow-down-glow" />}
                <span className="text-border/60">•</span>
              </span>);

          })}
        </div>
      </div>
    </div>);

}