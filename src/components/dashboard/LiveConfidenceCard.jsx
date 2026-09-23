import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gauge, Copy, Check } from 'lucide-react';
import { backend } from '@/api/entities';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { summarizeOps } from '@/lib/tradeMetrics';
import { POLL_DIAGNOSTIC_MS } from '@/lib/pollingIntervals';
import { useCopyToClipboard } from '@/lib/clipboardText';

// Mesmo teto/queryKey de VirtualAccountCard.jsx — dados compartilhados via
// cache do TanStack Query, sem fetch extra.
const OPS_LIMIT = 500;

// Mesma convenção de rótulo já usada em TradeCard.jsx — de qual mercado da
// Binance veio o preço desta operação ('futures' = painel/navegador,
// 'spot' = cron 24h). Ver docs/known-risks.md item 4/178.
const MARKET_SOURCE_LABEL = { spot: 'Spot', futures: 'Futures' };

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
    refetchInterval: POLL_DIAGNOSTIC_MS,
  });

  const { all, buy, sell, spot, futures, semFonte } = useMemo(() => ({
    all: summarizeOps(operations),
    buy: summarizeOps(operations.filter(op => op.side === 'BUY')),
    sell: summarizeOps(operations.filter(op => op.side === 'SELL')),
    // Eixo DIFERENTE de BUY/SELL acima (de onde veio o preço, não o lado da
    // operação) — item 186/178: já era gravado em toda op, mas nenhum
    // relatório agregado consumia. `market_source` só existe desde
    // 2026-09-14 (item 178); operações mais antigas caem em `semFonte`.
    spot: summarizeOps(operations.filter(op => op.market_source === 'spot')),
    futures: summarizeOps(operations.filter(op => op.market_source === 'futures')),
    semFonte: summarizeOps(operations.filter(op => op.market_source == null)),
  }), [operations]);

  // Hook antes do early return abaixo — regra de hooks do React não permite
  // chamada condicional.
  const { copied, copy } = useCopyToClipboard();

  if (all.total === 0) return null;

  // Só mostra a seção "por fonte" quando há pelo menos uma operação com (ou
  // sem) o campo — evita 3 linhas vazias enquanto a amostra ainda é pequena.
  const sourceRows = [
    { key: 'spot', label: MARKET_SOURCE_LABEL.spot, summary: spot },
    { key: 'futures', label: MARKET_SOURCE_LABEL.futures, summary: futures },
    { key: 'semFonte', label: 'Sem registro', summary: semFonte },
  ].filter(row => row.summary.total > 0);

  // Agregados por cohort, não lista de operação — formato próprio (não usa
  // formatTradeOpLine, que é pra linha-por-operação). Pedido do usuário pra
  // colar direto numa conversa.
  const fmtRow = (label, s) => {
    const expectancy = s.rCounted > 0 ? `${s.expectancyR >= 0 ? '+' : ''}${s.expectancyR.toFixed(3)}R` : '—';
    const ci = s.expectancyRCI95 ? ` IC[${s.expectancyRCI95[0].toFixed(3)}; ${s.expectancyRCI95[1].toFixed(3)}]` : '';
    return `${label}: ${s.counted}/${s.minTrades} ops · expectância ${expectancy}${ci} · ${s.conclusive ? 'CONCLUSIVO' : 'INCONCLUSIVO'}`;
  };
  const handleCopy = () => {
    const lines = [
      'Confiança ao Vivo (amostra real)',
      fmtRow('Geral', all), fmtRow('BUY', buy), fmtRow('SELL', sell),
      ...sourceRows.map(r => fmtRow(r.label, r.summary)),
    ];
    copy(lines.join('\n'));
  };

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
        <button onClick={handleCopy} type="button"
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono transition-all"
          style={copied
            ? { background: 'rgba(0,255,128,0.08)', border: '1px solid rgba(0,255,128,0.25)', color: '#00ff80' }
            : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copiado!' : 'Copiar'}
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
        <ConfidenceRow label="Geral" summary={all} />
        <ConfidenceRow label="BUY" summary={buy} />
        <ConfidenceRow label="SELL" summary={sell} />
      </div>
      {sourceRows.length > 0 && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">Por fonte de dado</span>
            <Tooltip>
              <TooltipTrigger type="button" className="text-[8px] font-mono px-1.5 py-0.5 rounded cursor-help"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.45)' }}>
                Spot × Futures
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px] text-[10px] font-mono normal-case tracking-normal leading-relaxed">
                Eixo diferente do BUY/SELL acima — aqui é de onde veio o preço da operação (cron 24h = Spot, painel aberto no navegador = Futures, item 4/178). Nunca combine com BUY/SELL no mesmo IC. &quot;Sem registro&quot; são operações de antes de 2026-09-14, quando esse campo passou a existir.
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
            {sourceRows.map(row => (
              <ConfidenceRow key={row.key} label={row.label} summary={row.summary} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
