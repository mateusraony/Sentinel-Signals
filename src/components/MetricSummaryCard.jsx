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
export function MetricSummaryCard({ icon: Icon, label, value, sublabel = undefined, color, glowColor, tooltip = undefined, valueClassName = 'text-xl' }) {
  return (
    <div className="rounded-xl p-4 relative overflow-hidden"
      style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
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
