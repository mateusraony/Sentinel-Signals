import React from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

// Extraído de TelegramSettings.jsx para ser reusado também por
// AssetConfigPanel.jsx (filtro de notificação por ativo, known-risks item 47)
// — mesmo componente, sem duplicar a lógica de seleção nem o estilo.
//
// Achado M-17 do Raio-X de UI/UX (docs/known-risks.md item 230): opções
// como RF/SMC/MACD/RSI eram siglas "nuas" — cada `option` pode ganhar um
// campo opcional `tooltip` (texto do glossário da auditoria) que envolve o
// próprio botão num Tooltip do Radix, sem mudar onClick/seleção/estilo.
export default function MultiToggle({ options, selected, onChange }) {
  const toggle = (id) => {
    if (selected.includes(id)) onChange(selected.filter(x => x !== id));
    else onChange([...selected, id]);
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => {
        const on = selected.includes(o.id);
        const button = (
          <button key={o.id} onClick={() => toggle(o.id)}
            className={`text-10px font-mono px-2 py-1 rounded-md transition-all${o.tooltip ? ' cursor-help' : ''}`}
            tabIndex={o.tooltip ? 0 : undefined}
            style={on
              ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.35)', color: '#00e5ff' }
              : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.35)' }}>
            {o.label}
          </button>
        );
        if (!o.tooltip) return button;
        return (
          <Tooltip key={o.id}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
              {o.tooltip}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
