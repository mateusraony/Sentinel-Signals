import React from 'react';

// Peças visuais comuns dos painéis do What-If (mesmo padrão das páginas redesenhadas: marcador azul no título, painel plano).
export const PANEL_STYLE = { background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.06)' };
export const GREEN = '#5db586';
export const RED = '#e06a5b';
export const AMBER = '#dd9a4a';
export const BLUE = '#8db4e2';
export const TOOLTIP_STYLE = { background: 'rgba(24,23,21,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace' };
export const AXIS_TICK = { fontSize: 11, fill: 'rgba(255,255,255,0.62)' };

export function SectionTitle({ children, hint = null, right = null }) {
  return (
    <div className="flex items-center gap-2 px-1 flex-wrap">
      <span aria-hidden="true" style={{ width: 3, height: 16, borderRadius: 2, background: BLUE, display: 'inline-block' }} />
      <h2 className="text-sm font-semibold text-foreground/80">{children}</h2>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

export function Panel({ children, className = '', ...rest }) {
  return <div className={`rounded-md p-4 ${className}`} style={PANEL_STYLE} {...rest}>{children}</div>;
}

export const fmtR = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}R`);
export const fmtPct = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${v.toFixed(d)}%`);
