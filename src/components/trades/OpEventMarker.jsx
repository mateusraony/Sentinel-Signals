import React from 'react';
import { CalendarClock } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { eventMarkersFor, markerLabel, markerExplanation } from '@/lib/opEventMarkers';

/**
 * Selo "Aberta durante o CPI (10/11)" do Histórico (Fase 5 do Contexto de Mercado, item 285). Só para eventos de ALTA importância e só quando há dado
 * confiável; é correlação (a dica diz isso), nunca causa. Sem contexto ou sem evento: não desenha nada.
 */
export default function OpEventMarker({ op, ctx, now = Date.now() }) {
  const hit = eventMarkersFor(op, ctx, now);
  if (!hit) return null;
  const explanation = markerExplanation(hit);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={`${markerLabel(hit)}. ${explanation}`} data-op-event-marker
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-9px font-mono cursor-help self-start"
          style={{ color: '#7dd3fc', background: 'rgba(56,189,248,0.10)', border: '1px solid rgba(56,189,248,0.30)' }}>
          <CalendarClock className="w-3 h-3" aria-hidden="true" />
          {markerLabel(hit)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px] text-10px font-mono normal-case tracking-normal leading-relaxed">{explanation}</TooltipContent>
    </Tooltip>
  );
}
