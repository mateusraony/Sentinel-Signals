import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { backend } from '@/api/entities';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { summarizeOps } from '@/lib/tradeMetrics';

// Mesmo teto/queryKey de VirtualAccountCard.jsx — dados compartilhados via
// cache do TanStack Query, sem fetch extra.
const OPS_LIMIT = 500;

function ConfidenceRow({ label, summary }) {
  const hasSamples = summary.rCounted > 0;
  const ci = summary.expectancyRCI95;
  const positive = hasSamples && summary.expectancyR >= 0;
  const badgeColor = summary.conclusive ? (positive ? '#00ff80' : '#ff1478') : '#ffd166';
  const badgeLabel = summary.conclusive ? (positive ? 'CONCLUSIVO +' : 'CONCLUSIVO −') : 'INCONCLUSIVO';

  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[8px] font-mono uppercase text-muted-foreground">{label}</span>
        <Tooltip>
          <TooltipTrigger type="button" className="text-[8px] font-mono px-1.5 py-0.5 rounded cursor-help"
            style={{ background: `${badgeColor}18`, border: `1px solid ${badgeColor}40`, color: badgeColor }}>
            {badgeLabel}
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-[10px] font-mono normal-case tracking-normal leading-relaxed">
            {summary.conclusive
              ? 'CONCLUSIVO: o intervalo de confiança de 95% da expectância não cruza zero — a amostra já descarta "sem edge nenhum" nesse sentido (não prova o tamanho do edge).'
              : 'INCONCLUSIVO: amostra pequena demais ou o intervalo de confiança de 95% da expectância ainda cruza zero — não dá para descartar "sem edge nenhum" com esta amostra.'}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="text-base font-bold font-mono"
        style={{ color: hasSamples ? (positive ? '#00ff80' : '#ff1478') : 'rgba(255,255,255,0.3)' }}>
        {hasSamples ? `${positive ? '+' : ''}${summary.expectancyR.toFixed(3)}R` : '—'}
      </div>
      <div className="text-[8px] font-mono text-muted-foreground mt-0.5">
        {summary.counted}/{summary.minTrades} operações
        {ci ? (
          <Tooltip>
            <TooltipTrigger type="button" className="cursor-help underline decoration-dotted underline-offset-2">
              {` · IC [${ci[0].toFixed(3)}; ${ci[1].toFixed(3)}]`}
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-[10px] font-mono normal-case tracking-normal leading-relaxed">
              Intervalo de confiança de 95% da expectância (R por operação). "Que vantagem esta amostra já descarta?" — quanto mais estreito, mais essa amostra restringe o edge real, exista ele ou não.
            </TooltipContent>
          </Tooltip>
        ) : ''}
      </div>
    </div>
  );
}

// Confiança ao vivo — aplica o MESMO gate de amostra/IC (summarizeOps,
// src/lib/tradeMetrics.js) que os relatórios de backtest já usam, mas sobre
// as operações REAIS de produção. Cresce sozinho a cada operação fechada
// pelo scan agendado, sem depender de rodar um backtest manual numa janela
// de calendário nova — ver docs/known-risks.md item 129. BUY/SELL aparecem
// separados porque são hipóteses estatísticas distintas desde o item 88;
// nunca combine os dois num IC só.
export default function LiveConfidenceCard() {
  const { data: operations = [] } = useQuery({
    queryKey: ['trade-operations-closed-all'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', OPS_LIMIT),
    refetchInterval: 30000,
  });

  const { all, buy, sell } = useMemo(() => ({
    all: summarizeOps(operations),
    buy: summarizeOps(operations.filter(op => op.side === 'BUY')),
    sell: summarizeOps(operations.filter(op => op.side === 'SELL')),
  }), [operations]);

  if (all.total === 0) return null;

  return (
    <div className="rounded-2xl p-4"
      style={{ background: 'rgba(6,8,15,0.7)', border: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(20px)' }}>
      <div className="flex items-center gap-2 mb-3">
        <Gauge className="w-3.5 h-3.5" style={{ color: '#00e5ff' }} />
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Confiança ao Vivo (amostra real)</span>
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
          cresce a cada operação fechada
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
        <ConfidenceRow label="Geral" summary={all} />
        <ConfidenceRow label="BUY" summary={buy} />
        <ConfidenceRow label="SELL" summary={sell} />
      </div>
    </div>
  );
}
