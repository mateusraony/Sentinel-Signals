import React from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

// Round 4 da nova varredura pós-Raio-X (2026-09-27): extraído de 3 cópias
// quase idênticas (`SummaryCard` em Backtest.jsx/MonthlyReport.jsx,
// `MetricCard` em PerformanceReport.jsx — família visual "glow card": glow
// radial decorativo no canto, ícone+label+tooltip opcional, valor grande
// abaixo). A família "box icon card" (PerformanceMetricsBar.jsx/
// VirtualAccountCard.jsx — ícone em caixa colorida à esquerda) é um
// componente visualmente diferente, ver MetricBoxCard.jsx — decisão do
// usuário: 2 componentes, não 1 unificado, pra zero mudança visual.
//
// `valueClassName` existe só porque PerformanceReport.jsx sempre usou
// `text-2xl` (não `text-xl` como os outros 2 consumidores) — preserva essa
// única divergência de pixel sem forçar um valor igual pros 3.
//
// Modo `flat` (21/11/2026, aba Trades): cartão plano igual ao do Dashboard — sem ícone, sem brilho no canto, rótulo em frase normal
// (não em maiúsculas espaçadas) e número em peso médio. Só a aba Trades liga; Backtest e Relatório Mensal seguem no desenho de antes
// (com as cores novas) até o usuário pedir o mesmo nelas. `className` deixa o chamador dar larguras diferentes aos cartões.
/** @param {{ icon?: any, label: any, value: any, sublabel?: any, color?: string, glowColor?: string, tooltip?: string, valueClassName?: string, flat?: boolean, className?: string }} props */
export function MetricSummaryCard({ icon: Icon, label, value, sublabel = undefined, color, glowColor, tooltip = undefined, valueClassName = 'text-xl', flat = false, className = '' }) {
  if (flat) {
    return (
      <div className={`glass-card rounded-md p-4 ${className}`}>
        <div className="mb-2">
          {tooltip ? (
            <Tooltip>
              <TooltipTrigger type="button" className="text-xs text-muted-foreground cursor-help underline decoration-dotted underline-offset-2 text-left">
                {label}
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                {tooltip}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-xs text-muted-foreground">{label}</span>
          )}
        </div>
        <div className={`${valueClassName} font-medium font-mono tabular-nums leading-none`} style={{ color }}>{value}</div>
        {sublabel && <div className="text-xs text-muted-foreground mt-2">{sublabel}</div>}
      </div>
    );
  }
  return (
    <div className={`rounded-md p-4 relative overflow-hidden ${className}`}
      style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full opacity-10"
        style={{ background: `radial-gradient(circle, ${glowColor}, transparent 70%)`, transform: 'translate(30%, -30%)' }} />
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4" style={{ color }} />
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger type="button" className="text-10px font-mono uppercase tracking-wider text-muted-foreground cursor-help underline decoration-dotted underline-offset-2">
              {label}
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-10px font-mono uppercase tracking-wider text-muted-foreground">{label}</span>
        )}
      </div>
      <div className={`${valueClassName} font-bold font-mono`} style={{ color }}>{value}</div>
      {sublabel && <div className="text-9px font-mono text-muted-foreground mt-1">{sublabel}</div>}
    </div>
  );
}

export default MetricSummaryCard;
