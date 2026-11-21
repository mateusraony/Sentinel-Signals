import React from 'react';

const STRENGTH = {
  strong: { label: 'Forte', bg: 'rgba(93,181,134,0.1)', border: 'rgba(93,181,134,0.3)', color: '#5db586' },
  moderate: { label: 'Moderado', bg: 'rgba(255,180,0,0.1)', border: 'rgba(255,180,0,0.3)', color: '#ffb400' },
  weak: { label: 'Fraco', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.55)' },
};

const PRIORITY = {
  high: { label: 'Alta', bg: 'rgba(224,106,91,0.1)', border: 'rgba(224,106,91,0.3)', color: '#e06a5b' },
  medium: { label: 'Média', bg: 'rgba(255,180,0,0.1)', border: 'rgba(255,180,0,0.3)', color: '#ffb400' },
  low: { label: 'Baixa', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.55)' },
};

export function StrengthBadge({ strength }) {
  const c = STRENGTH[strength] || STRENGTH.weak;
  return (
    <span className="text-11px font-mono px-2 py-0.5 rounded"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.color }}
    >{c.label}</span>
  );
}

export function PriorityBadge({ priority }) {
  const c = PRIORITY[priority] || PRIORITY.low;
  return (
    <span className="text-11px font-mono px-2 py-0.5 rounded"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.color }}
    >{c.label}</span>
  );
}