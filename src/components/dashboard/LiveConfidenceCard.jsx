import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gauge, Copy, Check, AlertTriangle } from 'lucide-react';
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

function ConfidenceRow({ label, summary, divergenceWarning = false }) {
  const hasSamples = summary.rCounted > 0;
  const ci = summary.expectancyRCI95;
  const positive = hasSamples && summary.expectancyR >= 0;
  const badgeColor = summary.conclusive ? (positive ? '#00ff80' : '#ff1478') : '#ffd166';
  const badgeLabel = summary.conclusive ? (positive ? 'CONCLUSIVO +' : 'CONCLUSIVO −') : 'INCONCLUSIVO';

  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-8px font-mono uppercase text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1">
          {divergenceWarning && (
            <Tooltip>
              <TooltipTrigger type="button" className="flex items-center gap-0.5 text-8px font-mono px-1.5 py-0.5 rounded cursor-help"
                style={{ background: 'rgba(255,159,67,0.1)', border: '1px solid rgba(255,159,67,0.35)', color: '#ff9f43' }}>
                <AlertTriangle className="w-2.5 h-2.5" />DIVERGENTE
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
                BUY e SELL têm expectância (R por operação) em direções opostas — uma positiva, outra negativa. &quot;Geral&quot; mistura os dois numa média só, o que pode esconder essa discordância; prefira olhar as linhas BUY/SELL separadas.
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger type="button" className="text-8px font-mono px-1.5 py-0.5 rounded cursor-help"
              style={{ background: `${badgeColor}18`, border: `1px solid ${badgeColor}40`, color: badgeColor }}>
              {badgeLabel}
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
              {summary.conclusive
                ? 'CONCLUSIVO: o intervalo de confiança de 95% da expectância não cruza zero — a amostra já descarta "sem edge nenhum" nesse sentido (não prova o tamanho do edge).'
                : 'INCONCLUSIVO: amostra pequena demais ou o intervalo de confiança de 95% da expectância ainda cruza zero — não dá para descartar "sem edge nenhum" com esta amostra.'}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="text-base font-bold font-mono"
        style={{ color: hasSamples ? (positive ? '#00ff80' : '#ff1478') : 'rgba(255,255,255,0.3)' }}>
        {hasSamples ? `${positive ? '+' : ''}${summary.expectancyR.toFixed(3)}R` : '—'}
      </div>
      <div className="text-8px font-mono text-muted-foreground mt-0.5">
        {summary.counted}/{summary.minTrades} operações
        {ci ? (
          <Tooltip>
            <TooltipTrigger type="button" className="cursor-help underline decoration-dotted underline-offset-2">
              {` · IC [${ci[0].toFixed(3)}; ${ci[1].toFixed(3)}]`}
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
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

  const { all, buy, sell, spot, futures, semFonte, divergentGeral } = useMemo(() => {
    const buySummary = summarizeOps(operations.filter(op => op.side === 'BUY'));
    const sellSummary = summarizeOps(operations.filter(op => op.side === 'SELL'));
    // Achado A-10 do Raio-X de UI/UX: "Geral" mistura BUY/SELL numa média
    // só, sem avisar quando os dois lados divergem (ex. BUY com edge
    // positivo, SELL com edge negativo — "Geral" pode sair perto de zero
    // e esconder os dois). Critério simples de propósito: sinal bruto de
    // expectancyR oposto nos 2 lados, exigindo rCounted>0 nos dois — NÃO
    // exige `conclusive` (quase sempre false neste projeto, ver
    // tradeMetrics.js, provar o edge medido exigiria ~8.400 operações;
    // exigir isso faria o aviso nunca aparecer na prática).
    const buySign = buySummary.rCounted > 0 ? Math.sign(buySummary.expectancyR) : 0;
    const sellSign = sellSummary.rCounted > 0 ? Math.sign(sellSummary.expectancyR) : 0;
    return {
      all: summarizeOps(operations),
      buy: buySummary,
      sell: sellSummary,
      // Eixo DIFERENTE de BUY/SELL acima (de onde veio o preço, não o lado
      // da operação) — item 186/178: já era gravado em toda op, mas nenhum
      // relatório agregado consumia. `market_source` só existe desde
      // 2026-09-14 (item 178); operações mais antigas caem em `semFonte`.
      spot: summarizeOps(operations.filter(op => op.market_source === 'spot')),
      futures: summarizeOps(operations.filter(op => op.market_source === 'futures')),
      semFonte: summarizeOps(operations.filter(op => op.market_source == null)),
      divergentGeral: buySign !== 0 && sellSign !== 0 && buySign !== sellSign,
    };
  }, [operations]);

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
        <span className="text-10px font-mono uppercase tracking-widest text-muted-foreground">Confiança ao Vivo (amostra real)</span>
        <span className="text-9px font-mono px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
          cresce a cada operação fechada
        </span>
        <button onClick={handleCopy} type="button"
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-9px font-mono transition-all"
          style={copied
            ? { background: 'rgba(0,255,128,0.08)', border: '1px solid rgba(0,255,128,0.25)', color: '#00ff80' }
            : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copiado!' : 'Copiar'}
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
        <ConfidenceRow label="Geral" summary={all} divergenceWarning={divergentGeral} />
        <ConfidenceRow label="BUY" summary={buy} />
        <ConfidenceRow label="SELL" summary={sell} />
      </div>
      {sourceRows.length > 0 && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-9px font-mono uppercase tracking-widest text-muted-foreground">Por fonte de dado</span>
            <Tooltip>
              <TooltipTrigger type="button" className="text-8px font-mono px-1.5 py-0.5 rounded cursor-help"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.45)' }}>
                Spot × Futures
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px] text-10px font-mono normal-case tracking-normal leading-relaxed">
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
