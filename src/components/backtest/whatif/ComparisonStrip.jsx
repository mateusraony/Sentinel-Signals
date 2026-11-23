import React from 'react';
import { GREEN, RED, AMBER, fmtR, fmtPct } from './ui';

// "O que mudou?": o resultado atual lado a lado com o do padrão (mesmos candles), com a seta e a cor da diferença. A expectância diz se a
// diferença cabe na margem de erro (ver compareSummaries em src/lib/whatIf.js) — com poucas operações quase nada é "real".
export const CELLS = [
  { key: 'expectancyR', label: 'Expectância líquida', fmt: fmtR, good: 'up' },
  { key: 'winRate', label: 'Taxa de acerto', fmt: (v) => fmtPct(v), good: 'up' },
  { key: 'profitFactor', label: 'Profit Factor', fmt: (v) => (v === null || v === undefined ? '—' : v.toFixed(2)), good: 'up' },
  { key: 'maxDrawdownPct', label: 'Máx. drawdown', fmt: (v) => (v === null || v === undefined ? '—' : v === 0 ? '0.0%' : `-${v.toFixed(1)}%`), good: 'down' },
  { key: 'counted', label: 'Operações', fmt: (v) => (v === null || v === undefined ? '—' : String(v)), good: 'neutral' },
];

export function Delta({ cell, m }) {
  if (m.delta === null) return <span className="text-11px text-muted-foreground">—</span>;
  const tiny = Math.abs(m.delta) < 1e-9;
  if (tiny) return <span className="text-11px text-muted-foreground">= igual ao padrão</span>;
  const up = m.delta > 0;
  const good = cell.good === 'neutral' ? null : (cell.good === 'up' ? up : !up);
  const color = good === null ? 'rgba(255,255,255,0.7)' : good ? GREEN : RED;
  const abs = Math.abs(m.delta);
  const txt = cell.key === 'expectancyR' ? `${abs.toFixed(2)}R` : cell.key === 'counted' ? String(abs) : cell.key === 'profitFactor' ? abs.toFixed(2) : `${abs.toFixed(1)} p.p.`;
  return <span className="text-11px font-mono tabular-nums" style={{ color }}>{up ? '▲ +' : '▼ −'}{txt}</span>;
}

export default function ComparisonStrip({ cmp, isDefault, stale }) {
  if (!cmp) return null;
  const exp = cmp.expectancyR;
  // Todas as métricas iguais (e medidas): o que mudou nos controles não alterou operação nenhuma — melhor dizer isso do que falar de "margem de erro".
  const identical = exp.delta !== null && CELLS.every(c => cmp[c.key].delta === null || Math.abs(cmp[c.key].delta) < 1e-9);
  return (
    <section aria-label="Atual comparado com o padrão" className="rounded-md px-4 py-3 space-y-2" style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.06)', opacity: stale ? 0.6 : 1 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-xs font-semibold text-foreground/80">Atual × padrão</h3>
        <span className="text-xs text-muted-foreground">
          {isDefault ? 'Os parâmetros são os do padrão — não há diferença para mostrar.' : 'mesmos candles, só os parâmetros mudam'}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {CELLS.map(c => {
          const m = cmp[c.key];
          return (
            <div key={c.key}>
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className="text-lg font-mono font-medium tabular-nums leading-tight text-foreground">{c.fmt(m.cur)}</div>
              <div className="text-11px text-muted-foreground">padrão {c.fmt(m.base)}</div>
              {!isDefault && <Delta cell={c} m={m} />}
            </div>
          );
        })}
      </div>
      {!isDefault && identical && (
        <p className="text-xs text-muted-foreground">Mexer nisso não mudou nenhuma operação nesta janela: o resultado é idêntico ao do padrão.</p>
      )}
      {!isDefault && !identical && exp.delta !== null && (
        <p className="text-xs" style={{ color: exp.withinNoise ? 'rgba(255,255,255,0.62)' : AMBER }}>
          {cmp.noiseR === null
            ? 'Poucas operações para medir a margem de erro: não dá para dizer se a diferença é real.'
            : exp.withinNoise
              ? `A diferença de expectância (${fmtR(exp.delta)}) cabe na margem de erro (±${cmp.noiseR.toFixed(2)}R): provavelmente é ruído, não melhora de verdade.`
              : `A diferença de expectância (${fmtR(exp.delta)}) é maior que a margem de erro (±${cmp.noiseR.toFixed(2)}R) — ainda assim confirme em outro período antes de confiar.`}
        </p>
      )}
    </section>
  );
}
