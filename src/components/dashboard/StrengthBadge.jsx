import React from 'react';

const STRENGTH = {
  strong: { label: 'Forte', bg: 'rgba(0,255,128,0.1)', border: 'rgba(0,255,128,0.3)', color: '#00ff80' },
  moderate: { label: 'Moderado', bg: 'rgba(255,180,0,0.1)', border: 'rgba(255,180,0,0.3)', color: '#ffb400' },
  weak: { label: 'Fraco', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.3)' },
};

const PRIORITY = {
  high: { label: 'Alta', bg: 'rgba(255,20,120,0.1)', border: 'rgba(255,20,120,0.3)', color: '#ff1478' },
  medium: { label: 'Média', bg: 'rgba(255,180,0,0.1)', border: 'rgba(255,180,0,0.3)', color: '#ffb400' },
  low: { label: 'Baixa', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.3)' },
};

export function StrengthBadge({ strength }) {
  const c = STRENGTH[strength] || STRENGTH.weak;
  return (
    <span className="text-[10px] font-mono px-2 py-0.5 rounded"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.color }}
    >{c.label}</span>
  );
}

export function PriorityBadge({ priority }) {
  const c = PRIORITY[priority] || PRIORITY.low;
  return (
    <span className="text-[10px] font-mono px-2 py-0.5 rounded"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.color }}
    >{c.label}</span>
  );
}