import React, { useMemo } from 'react';
import moment from 'moment';
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ReferenceDot } from 'recharts';
import { GREEN, RED, BLUE, TOOLTIP_STYLE, AXIS_TICK, fmtR } from './ui';

const OUTCOME_COLOR = { WIN: GREEN, LOSS: RED, BE: 'rgba(255,255,255,0.45)' };

// O preço de fechamento com cada operação desenhada em cima: faixa verde/vermelha/cinza do começo ao fim da operação (ganho / perda / empate),
// ponto grande = entrada (verde compra, vermelho venda), ponto pequeno = saída. Serve para VER onde o simulador entrou e saiu.
export default function TradesPriceChart({ points, trades, symbol }) {
  const byI = useMemo(() => new Map(points.map(p => [p.i, p.t])), [points]);
  if (!points.length) return null;
  const label = `Gráfico do preço de ${symbol ?? 'ativo'} com ${trades.length} operações simuladas marcadas`;
  return (
    <div>
      <div style={{ height: 300 }} role="img" aria-label={label} aria-details="whatif-trades-table">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="i" type="number" domain={['dataMin', 'dataMax']} tick={AXIS_TICK}
              tickFormatter={(i) => (byI.has(i) ? moment(byI.get(i)).format('DD/MM') : '')} />
            <YAxis domain={['auto', 'auto']} tick={AXIS_TICK} width={56} tickFormatter={(v) => (v >= 100 ? v.toFixed(0) : v.toFixed(2))} />
            {trades.map((t, k) => (
              <ReferenceArea key={`a${k}`} x1={t.entryI} x2={t.exitI} fill={OUTCOME_COLOR[t.outcome] ?? OUTCOME_COLOR.BE} fillOpacity={0.14} strokeOpacity={0} />
            ))}
            <Line type="monotone" dataKey="close" stroke={BLUE} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            {trades.map((t, k) => (
              <ReferenceDot key={`e${k}`} x={t.entryI} y={t.entry} r={4.5} fill={t.side === 'BUY' ? GREEN : RED} stroke="rgba(0,0,0,0.5)" ifOverflow="extendDomain" />
            ))}
            {trades.map((t, k) => (
              <ReferenceDot key={`x${k}`} x={t.exitI} y={t.exit} r={3} fill={OUTCOME_COLOR[t.outcome] ?? OUTCOME_COLOR.BE} stroke="rgba(0,0,0,0.5)" ifOverflow="extendDomain" />
            ))}
            <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(i) => (byI.has(i) ? moment(byI.get(i)).format('DD/MM/YYYY HH:mm') : '')} formatter={(v) => [Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 }), 'fechamento']} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-11px text-muted-foreground mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        <span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: GREEN }} /> entrada de compra</span>
        <span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: RED }} /> entrada de venda</span>
        <span>faixa verde = ganhou · vermelha = perdeu · cinza = empate</span>
      </p>
      {trades.length > 0 && (
        <table id="whatif-trades-table" className="sr-only">
          <caption>Operações simuladas</caption>
          <thead><tr><th scope="col">Operação</th><th scope="col">Lado</th><th scope="col">Entrada</th><th scope="col">Saída</th><th scope="col">Resultado em R</th></tr></thead>
          <tbody>
            {trades.map((t, k) => (
              <tr key={k}><td>{k + 1}</td><td>{t.side}</td><td>{byI.has(t.entryI) ? moment(byI.get(t.entryI)).format('DD/MM/YYYY') : '—'}</td><td>{byI.has(t.exitI) ? moment(byI.get(t.exitI)).format('DD/MM/YYYY') : '—'}</td><td>{fmtR(t.r)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
