import React from 'react';

// Round 4 da nova varredura pós-Raio-X (2026-09-27): extraído de 2 cópias
// idênticas byte-a-byte (`MetricCard` em PerformanceMetricsBar.jsx e
// VirtualAccountCard.jsx — família visual "box icon card": ícone em caixa
// colorida à esquerda, boxShadow em vez de glow radial). Visualmente
// diferente da família "glow card" (ver MetricSummaryCard.jsx) — decisão
// do usuário: 2 componentes, não 1 unificado, pra zero mudança visual.
export function MetricBoxCard({ icon: Icon, label, value, sub, color, glowColor = undefined }) {
  return (
    <div className="flex items-center gap-3 rounded-xl px-4 py-3 flex-1 min-w-0"
      style={{
        background: 'rgba(10,13,22,0.85)',
        border: `1px solid ${glowColor ?? 'rgba(255,255,255,0.06)'}`,
        boxShadow: glowColor ? `0 0 20px ${glowColor}` : 'none',
        backdropFilter: 'blur(16px)',
      }}>
      <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
        style={{ background: `${color}18`, border: `1px solid ${color}30` }}>
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <div className="min-w-0">
        <div className="text-9px font-mono uppercase tracking-widest text-muted-foreground leading-none mb-1">{label}</div>
        <div className="text-lg font-bold font-mono leading-none truncate" style={{ color }}>{value}</div>
        {sub && <div className="text-9px font-mono mt-0.5 truncate" style={{ color: 'rgba(255,255,255,0.3)' }}>{sub}</div>}
      </div>
    </div>
  );
}

export default MetricBoxCard;
