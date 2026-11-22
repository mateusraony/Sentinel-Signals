import React from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { GREEN, RED, AMBER, TOOLTIP_STYLE, AXIS_TICK, fmtR, fmtPct, Panel } from './ui';

// Como o resultado se distribui: histograma do R de cada operação, por tipo de saída e por lado, e quanto do total depende de poucas operações.
function MiniTable({ title, head, rows }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-foreground/80 mb-1">{title}</h3>
      <div className="overflow-x-auto rounded-md" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
        <table className="w-full text-xs">
          <thead><tr className="text-left text-muted-foreground" style={{ background: 'rgba(18,17,15,0.9)' }}>{head.map(h => <th key={h} className="font-medium px-3 py-1.5">{h}</th>)}</tr></thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    </div>
  );
}

export default function OutcomeAnalysis({ histogram, exits, sides, concentration, total, positiveTotal = false }) {
  const hasData = total > 0;
  if (!hasData) return <Panel><p className="text-xs text-muted-foreground">Sem operações fechadas para analisar.</p></Panel>;
  const top5 = concentration?.top5Share;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel className="space-y-2">
        <h3 className="text-xs font-semibold text-foreground/80">Resultado de cada operação (em R)</h3>
        <div style={{ height: 200 }} role="img" aria-label={`Histograma do resultado em R: ${histogram.filter(b => b.count > 0).map(b => `${b.label}: ${b.count}`).join('; ')}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={histogram} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="label" tick={{ ...AXIS_TICK, fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={46} />
              <YAxis allowDecimals={false} tick={AXIS_TICK} width={28} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v} operação(ões)`, 'quantidade']} />
              <Bar dataKey="count" isAnimationActive={false}>{histogram.map((b, i) => <Cell key={i} fill={b.positive ? GREEN : RED} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-11px text-muted-foreground">1R = o risco inicial (distância até o stop). Perda cheia fica perto de −1R.</p>
      </Panel>

      <div className="space-y-4">
        <MiniTable title="Como terminaram" head={['Saída', 'Ops', '%', 'R médio']}
          rows={exits.map(e => (
            <tr key={e.key} style={{ borderTop: '1px solid rgba(255,255,255,0.03)' }}>
              <td className="px-3 py-1.5 text-foreground/85">{e.label}</td>
              <td className="px-3 py-1.5 font-mono tabular-nums">{e.count}</td>
              <td className="px-3 py-1.5 font-mono tabular-nums text-muted-foreground">{fmtPct(e.share * 100, 0)}</td>
              <td className="px-3 py-1.5 font-mono tabular-nums" style={{ color: e.avgR === null ? undefined : e.avgR >= 0 ? GREEN : RED }}>{fmtR(e.avgR)}</td>
            </tr>
          ))} />
        <MiniTable title="Compra × venda" head={['Lado', 'Ops', 'Acerto', 'R médio']}
          rows={sides.map(s => (
            <tr key={s.side} style={{ borderTop: '1px solid rgba(255,255,255,0.03)' }}>
              <td className="px-3 py-1.5 text-foreground/85">{s.side === 'BUY' ? 'Compra (BUY)' : 'Venda (SELL)'}</td>
              <td className="px-3 py-1.5 font-mono tabular-nums">{s.count}</td>
              <td className="px-3 py-1.5 font-mono tabular-nums text-muted-foreground">{s.count ? fmtPct((s.wins / s.count) * 100, 0) : '—'}</td>
              <td className="px-3 py-1.5 font-mono tabular-nums" style={{ color: s.avgR === null ? undefined : s.avgR >= 0 ? GREEN : RED }}>{fmtR(s.avgR)}</td>
            </tr>
          ))} />
        {positiveTotal && Number.isFinite(top5) && total >= 6 && (
          <p className="text-xs" style={{ color: top5 > 1 ? AMBER : 'rgba(255,255,255,0.62)' }}>
            {top5 > 1
              ? 'As 5 melhores operações sozinhas valem mais que o resultado total: sem elas o saldo seria negativo. Resultado frágil.'
              : `As 5 melhores operações respondem por ${(top5 * 100).toFixed(0)}% do resultado total: quanto maior, mais ele depende de poucos acertos.`}
          </p>
        )}
      </div>
    </div>
  );
}
