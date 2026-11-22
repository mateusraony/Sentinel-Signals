import React, { useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine, Tooltip } from 'recharts';
import { Loader2 } from 'lucide-react';
import { sweepValues, sweepParam, judgeSensitivity, runKey } from '@/lib/whatIf';
import { QBT_SLIDERS } from './params';
import { GREEN, RED, AMBER, BLUE, TOOLTIP_STYLE, AXIS_TICK, fmtR, Panel } from './ui';

const VERDICT_COLOR = { peak: RED, plateau: GREEN, mixed: AMBER, unknown: 'rgba(255,255,255,0.55)' };

// "Este valor está num platô ou numa ponta?": roda o simulador variando UM parâmetro por vez (9 valores) e mostra a expectância em cada ponto.
// Valor bom só no ponto exato e ruim ao redor = ajuste sob medida (frágil). Roda só quando o usuário pede (são ~45 simulações, instantâneas).
export default function SensitivityPanel({ runSummary, params, defaults, dataset, disabled }) {
  const [state, setState] = useState({ status: 'idle', sig: null, results: null });
  const sig = dataset ? runKey(dataset, params) : null;
  const stale = state.status === 'done' && state.sig !== sig;

  const run = () => {
    setState({ status: 'running', sig: null, results: null });
    // setTimeout 0: deixa o "Analisando…" aparecer antes do cálculo síncrono.
    setTimeout(() => {
      const results = QBT_SLIDERS.map(def => {
        const points = sweepParam({ runSummary, params, key: def.key, values: sweepValues(def, params[def.key]) });
        return { def, points, verdict: judgeSensitivity(points, params[def.key]) };
      });
      setState({ status: 'done', sig, results });
    }, 0);
  };

  const charts = useMemo(() => state.results ?? [], [state.results]);

  return (
    <Panel className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={run} disabled={disabled || state.status === 'running'}
          className="flex items-center gap-2 px-4 py-2 rounded-md text-xs font-mono font-semibold transition-all disabled:opacity-40"
          style={{ background: 'rgba(141,180,226,0.1)', border: '1px solid rgba(141,180,226,0.3)', color: BLUE }}>
          {state.status === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {state.status === 'running' ? 'Analisando…' : state.status === 'done' ? 'Analisar de novo' : 'Analisar sensibilidade'}
        </button>
        <span className="text-xs text-muted-foreground">Varia um parâmetro por vez (9 valores cada, mais o valor atual) e mostra se o seu valor está numa região estável ou numa ponta isolada.</span>
      </div>
      {stale && <p className="text-xs" style={{ color: AMBER }}>Estes gráficos são de outros parâmetros/dados: analise de novo.</p>}
      {charts.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" style={{ opacity: stale ? 0.5 : 1 }}>
          {charts.map(({ def, points, verdict }) => {
            const data = points.map(p => ({ x: p.value, exp: p.summary.expectancyR, n: p.summary.counted }));
            return (
              <div key={def.key} className="rounded-md p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-xs font-semibold text-foreground/85">{def.label}</span>
                  <span className="text-11px text-muted-foreground">atual {params[def.key]} · padrão {defaults[def.key]}</span>
                </div>
                <div style={{ height: 110 }} role="img" aria-label={`Expectância em R conforme ${def.label}: ${data.map(d => `${d.x}: ${d.exp === null ? 'sem operações' : d.exp.toFixed(2)}`).join('; ')}`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tick={{ ...AXIS_TICK, fontSize: 10 }} />
                      <YAxis tick={{ ...AXIS_TICK, fontSize: 10 }} width={34} tickFormatter={(v) => v.toFixed(1)} />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3" />
                      <ReferenceLine x={params[def.key]} stroke={BLUE} strokeDasharray="4 2" />
                      <ReferenceLine x={defaults[def.key]} stroke="rgba(255,255,255,0.35)" strokeDasharray="2 3" />
                      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, name, p) => [`${fmtR(v)} em ${p.payload.n} op.`, 'expectância']} labelFormatter={(x) => `${def.label}: ${x}`} />
                      <Line type="linear" dataKey="exp" stroke={def.color} strokeWidth={1.5} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-11px mt-1" style={{ color: VERDICT_COLOR[verdict.verdict] }}>{verdict.text}</p>
              </div>
            );
          })}
        </div>
      )}
      {charts.length > 0 && <p className="text-11px text-muted-foreground">Linha azul tracejada = valor atual · cinza pontilhada = padrão · linha horizontal em 0 = nem ganha nem perde.</p>}
    </Panel>
  );
}
