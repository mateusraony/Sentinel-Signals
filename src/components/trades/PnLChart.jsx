import React, { useId, useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import moment from 'moment';
import { summarizeOps } from '@/lib/tradeMetrics';

/** @param {{ active?: boolean, payload?: Array<any>, label?: any }} props */
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const isWin = d.pnl >= 0;
  return (
    <div className="rounded-lg px-3 py-2"
      style={{ background: 'rgba(8,10,18,0.95)', border: '1px solid rgba(255,255,255,0.08)', minWidth: 140 }}>
      <div className="text-9px font-mono text-muted-foreground mb-1">{label}</div>
      <div className="text-11px font-mono font-bold" style={{ color: isWin ? '#00ff80' : '#ff1478' }}>
        {d.pnl >= 0 ? '+' : ''}{d.pnl?.toFixed(2)}%
      </div>
      <div className="text-9px font-mono text-muted-foreground">
        Acum: <span style={{ color: d.cumulative >= 0 ? '#00ff80' : '#ff1478' }}>
          {d.cumulative >= 0 ? '+' : ''}{d.cumulative?.toFixed(2)}%
        </span>
      </div>
      <div className="text-9px font-mono text-muted-foreground mt-0.5">{d.symbol} {d.side} {d.tf}</div>
    </div>
  );
};

export default function PnLChart({ history }) {
  // Achado M-9 do Raio-X: nº de trades não tem teto — mesma técnica do fix
  // em Backtest.jsx (item 226): aria-label vira resumo curto, tabela
  // `sr-only` linkada via aria-details carrega o dado ponto a ponto.
  // Achado do Codex review no PR #429 (item 228): `aria-describedby`
  // colapsaria a tabela inteira num texto único, lido de uma vez só e
  // perdendo a navegação por célula/linha — `aria-details` (ARIA 1.2)
  // preserva a estrutura, deixando a tabela navegável por conta própria.
  const tableId = useId();
  const { data, wins, losses } = useMemo(() => {
    const s = summarizeOps(history);
    return {
      wins: s.wins,
      losses: s.losses,
      data: s.curve
        .filter(p => p.pnlPct !== null)
        .map(({ op, pnlPct, cumulativePct }) => ({
          date: moment(op.created_date).format('DD/MM'),
          pnl: parseFloat(pnlPct.toFixed(2)),
          cumulative: parseFloat(cumulativePct.toFixed(2)),
          symbol: op.symbol?.replace('USDT', '/USDT'),
          side: op.side,
          tf: op.timeframe?.toUpperCase(),
          status: op.status,
        })),
    };
  }, [history]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 rounded-xl"
        style={{ background: 'rgba(12,15,26,0.6)', border: '1px solid rgba(255,255,255,0.05)' }}>
        <p className="text-10px font-mono text-muted-foreground">Sem histórico suficiente para o gráfico.</p>
      </div>
    );
  }

  const finalCum = data[data.length - 1]?.cumulative ?? 0;
  const isPositive = finalCum >= 0;
  const gradColor = isPositive ? '#00ff80' : '#ff1478';

  return (
    <div className="rounded-xl p-4"
      style={{ background: 'rgba(12,15,26,0.7)', border: '1px solid rgba(255,255,255,0.06)', backdropFilter: 'blur(12px)' }}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-10px font-mono text-muted-foreground uppercase tracking-widest">Performance Acumulada</div>
          <div className="text-xl font-bold font-mono mt-0.5" style={{ color: isPositive ? '#00ff80' : '#ff1478' }}>
            {finalCum >= 0 ? '+' : ''}{finalCum.toFixed(2)}%
          </div>
        </div>
        <div className="text-right">
          <div className="text-9px font-mono text-muted-foreground">{data.length} trades</div>
          <div className="text-9px font-mono mt-0.5">
            <span style={{ color: '#00ff80' }}>✓ {wins} win</span>
            <span className="text-muted-foreground mx-1">·</span>
            <span style={{ color: '#ff1478' }}>✗ {losses} loss</span>
          </div>
        </div>
      </div>

      <div role="img" aria-details={tableId}
        aria-label={`Gráfico de área da performance acumulada, ${data.length} trades (${wins}W ${losses}L), ${finalCum >= 0 ? '+' : ''}${finalCum.toFixed(2)}% acumulado`}>
        <ResponsiveContainer width="100%" height={140}>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={gradColor} stopOpacity={0.3} />
                <stop offset="95%" stopColor={gradColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis dataKey="date" tick={{ fill: 'rgba(255,255,255,0.45)', fontSize: 9, fontFamily: 'monospace' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: 'rgba(255,255,255,0.45)', fontSize: 9, fontFamily: 'monospace' }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }} />
            <Area
              type="monotone"
              dataKey="cumulative"
              stroke={gradColor}
              strokeWidth={1.5}
              fill="url(#pnlGrad)"
              dot={false}
              activeDot={{ r: 3, fill: gradColor, stroke: 'none' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <table id={tableId} className="sr-only">
        <caption>Performance acumulada por trade</caption>
        <thead>
          <tr><th scope="col">Data</th><th scope="col">Símbolo</th><th scope="col">Lado</th><th scope="col">TF</th><th scope="col">P&L</th><th scope="col">Acumulado</th></tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}>
              <td>{d.date}</td><td>{d.symbol}</td><td>{d.side}</td><td>{d.tf}</td>
              <td>{d.pnl >= 0 ? '+' : ''}{d.pnl?.toFixed(2)}%</td>
              <td>{d.cumulative >= 0 ? '+' : ''}{d.cumulative?.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}