import React, { useMemo } from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { buildOutcomeBreakdown } from '@/lib/tradeOutcomesBreakdown';

/**
 * "Como terminaram" (item 293): as operações fechadas contadas pelo tipo de saída. Só leitura: a classificação mora em
 * `tradeOutcomesBreakdown.js` (puro, testado). Sem operação fechada, não renderiza nada. Cor nunca vai sozinha: o rótulo em texto e o número
 * acompanham sempre cada barra.
 */
export default function OutcomeBreakdown({ ops }) {
  const { total, items } = useMemo(() => buildOutcomeBreakdown(ops), [ops]);
  if (total === 0) return null;

  return (
    <div className="rounded-md p-4" role="group" aria-label="Como terminaram"
      style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex items-center gap-2 mb-3">
        <span aria-hidden="true" style={{ width: 3, height: 16, borderRadius: 2, background: '#8db4e2', display: 'inline-block' }} />
        <h2 className="text-sm font-semibold text-foreground/80">Como terminaram</h2>
        <span className="text-xs font-mono text-muted-foreground">({total} trades fechados)</span>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          // Coluna do número com largura FIXA: com `auto` cada linha media o seu "2 (17%)" e as barras terminavam em pontos diferentes.
          <li key={item.key} className="grid items-center gap-2 grid-cols-[8.5rem_1fr_4.5rem] sm:grid-cols-[11rem_1fr_4.5rem]">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-11px font-mono cursor-help truncate" tabIndex={0} style={{ color: item.color }}>{item.label}</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                {item.hint}
              </TooltipContent>
            </Tooltip>
            <div className="h-2 rounded-full overflow-hidden" aria-hidden="true" style={{ background: 'rgba(255,255,255,0.05)' }}>
              <div className="h-full rounded-full" data-testid={`outcome-bar-${item.key}`}
                style={{ width: `${item.pct}%`, minWidth: 2, background: item.color }} />
            </div>
            <span className="text-11px font-mono text-foreground/80 tabular-nums text-right">
              {item.count} <span className="text-muted-foreground">({item.pct < 1 ? '<1' : Math.round(item.pct)}%)</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
