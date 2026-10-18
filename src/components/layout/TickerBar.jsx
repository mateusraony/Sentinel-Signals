import React from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { POLL_OPERATIONAL_MS } from '@/lib/pollingIntervals';
import { fetch24hStats } from '@/lib/marketDataProvider';
import { describeChange24h, resolvePriceDisplay, queryChangeOptions, CHANGE_TONE_COLOR } from '@/lib/priceChange24h';
import { formatPrice } from '@/lib/priceProximity';
import { useNow } from '@/hooks/useNow';

export default function TickerBar() {
  const { data: states = [] } = useQuery({
    queryKey: ['asset-states'],
    queryFn: () => backend.entities.AssetState.list(),
    refetchInterval: POLL_OPERATIONAL_MS
  });

  const { data: assets = [] } = useQuery({
    queryKey: ['all-assets-ticker'],
    queryFn: () => backend.entities.MonitoredAsset.filter({ is_active: true })
  });

  const items = assets.map((asset) => {
    const state = states.find((s) => s.asset_id === asset.id && s.timeframe === '1h');
    return { asset, state };
  }).filter((i) => i.state?.last_close);

  // Item 279: 📈/📉 só pela variação de 24h que os cartões já carregaram
  // (mesma chave do AssetCard). `enabled: false` — só lê o cache, nunca busca:
  // a faixa aparece em todas as páginas e não pode multiplicar chamadas à Binance.
  const changes = useQueries({
    queries: items.map((i) => ({
      queryKey: ['24h-stats', i.asset.symbol],
      queryFn: () => fetch24hStats(i.asset.symbol),
      enabled: false,
    })),
  });
  // Relógio próprio: sem ele, um % que envelheceu continuaria parecendo fresco.
  const now = useNow();

  if (items.length === 0) return null;

  // Um descritor por ativo (não por cópia do loop). Preço e % do MESMO
  // instante quando o ticker está fresco; senão o fechamento da vela de 1h,
  // marcado como tal (item 279).
  const rows = items.map((item, idx) => {
    const change = describeChange24h(changes[idx]?.data, now, queryChangeOptions(changes[idx]));
    return { item, change, view: resolvePriceDisplay(change, item.state.last_close) };
  });
  const doubled = [...rows, ...rows]; // loop seamless

  return (
    <div className="h-8 border-b border-border/50 bg-card/30 backdrop-blur-sm flex items-center overflow-hidden rounded-lg my-1">
      <div className="flex items-center gap-2 px-3 shrink-0 border-r border-border/40">
        {/* Item 279: era "Live" com ponto pulsando, ao lado do fechamento da vela de 1h. */}
        <span className="text-10px text-muted-foreground font-mono tracking-widest">Preços</span>
      </div>
      <div className="ticker-container flex-1">
        <div className="ticker-inner">
          {doubled.map(({ item, change, view }, i) => (
            <span key={i} className="inline-flex items-center gap-2 px-6 text-xs font-mono">
              <span className="text-muted-foreground">{item.asset.symbol}</span>
              {/* Cor neutra: antes seguia a direção do Range Filter, o que ao
                  lado da variação de 24h podia dizer o contrário (item 279). */}
              <span className="font-semibold value-neutral">
                ${formatPrice(view.price)}
              </span>
              {view.isCandle && <span className="text-10px text-muted-foreground">fech. 1h</span>}
              {view.fresh && change.icon && (
                <span style={{ color: CHANGE_TONE_COLOR[change.tone] }}>
                  {change.icon} {change.signed} 24h
                </span>
              )}
              <span className="text-border/60">•</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
