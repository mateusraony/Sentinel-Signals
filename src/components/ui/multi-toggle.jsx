import React from 'react';

// Extraído de TelegramSettings.jsx para ser reusado também por
// AssetConfigPanel.jsx (filtro de notificação por ativo, known-risks item 47)
// — mesmo componente, sem duplicar a lógica de seleção nem o estilo.
export default function MultiToggle({ options, selected, onChange }) {
  const toggle = (id) => {
    if (selected.includes(id)) onChange(selected.filter(x => x !== id));
    else onChange([...selected, id]);
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => {
        const on = selected.includes(o.id);
        return (
          <button key={o.id} onClick={() => toggle(o.id)}
            className="text-[10px] font-mono px-2 py-1 rounded-md transition-all"
            style={on
              ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.35)', color: '#00e5ff' }
              : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.35)' }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
