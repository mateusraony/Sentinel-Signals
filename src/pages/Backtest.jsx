import React, { useMemo, useRef, useState } from 'react';
import {
  LineChart, Line, PieChart, Pie, Cell, BarChart, Bar,
  ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  FlaskConical, Upload, TrendingUp, TrendingDown, Target, Award,
  AlertTriangle, CheckCircle2, Rocket, Loader2,
} from 'lucide-react';
import { backend } from '@/api/entities';
import { SYNCED_STRATEGY_KEYS } from '@/lib/pineParser';
import { logInfo } from '@/lib/logger';

function fmtPct(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

function fmtR(v, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}R`;
}

const OUTCOME_COLORS = { WIN: '#00ff80', LOSS: '#ff1478', BE: '#64748b' };

function SummaryCard({ icon: Icon, label, value, sublabel, color, glowColor }) {
  return (
    <div className="rounded-xl p-4 relative overflow-hidden"
      style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full opacity-10"
        style={{ background: `radial-gradient(circle, ${glowColor}, transparent 70%)`, transform: 'translate(30%, -30%)' }} />
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4" style={{ color }} />
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="text-xl font-bold font-mono" style={{ color }}>{value}</div>
      {sublabel && <div className="text-[9px] font-mono text-muted-foreground mt-1">{sublabel}</div>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="rounded-xl p-4 space-y-3" style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <h2 className="text-sm font-bold text-foreground">{title}</h2>
      {children}
    </div>
  );
}

function UploadPanel({ onLoad, error }) {
  const fileRef = useRef(null);
  const [pasted, setPasted] = useState('');

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onLoad(reader.result);
    reader.readAsText(file);
  };

  return (
    <div className="rounded-xl p-6 space-y-4 max-w-2xl mx-auto" style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="text-center space-y-1">
        <FlaskConical className="w-8 h-8 mx-auto text-muted-foreground opacity-30" />
        <h2 className="text-base font-bold text-foreground">Carregar relatório de backtest</h2>
        <p className="text-[10px] font-mono text-muted-foreground">
          Rode o workflow <code>backtest.yml</code> no GitHub Actions (aba Actions → Backtest → Run workflow) e baixe o
          artifact <code>backtest-report.json</code> — ou rode <code>npm run backtest</code> localmente. Depois, carregue o
          arquivo ou cole o conteúdo abaixo.
        </p>
      </div>

      <button onClick={() => fileRef.current?.click()}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-[11px] font-mono font-bold transition-all"
        style={{ background: 'rgba(0,229,255,0.08)', border: '1px dashed rgba(0,229,255,0.3)', color: '#00e5ff' }}>
        <Upload className="w-4 h-4" />Selecionar backtest-report.json
      </button>
      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleFile} />

      <div className="text-center text-[9px] font-mono text-muted-foreground">— ou cole o JSON —</div>
      <textarea
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        placeholder="{ &quot;range&quot;: ..., &quot;overall&quot;: ... }"
        rows={5}
        className="w-full rounded-lg p-3 text-[10px] font-mono outline-none resize-none"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}
      />
      <button onClick={() => onLoad(pasted)} disabled={!pasted.trim()}
        className="w-full px-4 py-2 rounded-lg text-[10px] font-mono font-bold transition-all disabled:opacity-40"
        style={{ background: 'rgba(0,255,128,0.08)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }}>
        Analisar relatório colado
      </button>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[10px] font-mono" style={{ background: 'rgba(255,20,120,0.1)', border: '1px solid rgba(255,20,120,0.3)', color: '#ff1478' }}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}
        </div>
      )}
    </div>
  );
}

export default function Backtest() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [applyStatus, setApplyStatus] = useState(null); // null | 'applying' | 'applied' | 'error'

  const handleLoad = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed?.overall || !parsed?.range) {
        setError('JSON não parece ser um relatório de backtest válido (faltam os campos "overall"/"range").');
        return;
      }
      setError(null);
      setReport(parsed);
    } catch (e) {
      setError(`Não foi possível interpretar o JSON: ${e.message}`);
    }
  };

  const equityCurve = useMemo(() => {
    if (!report?.overall?.curve) return [];
    return report.overall.curve
      .filter(p => p.cumulativePct !== null)
      .map((p, i) => ({
        trade: i + 1,
        cumulativePct: +p.cumulativePct.toFixed(2),
        symbol: p.op?.symbol,
        outcome: p.outcome,
      }));
  }, [report]);

  const outcomePie = useMemo(() => {
    if (!report?.overall) return [];
    const { wins, losses, be } = report.overall;
    return [
      { name: 'Vitórias', value: wins, color: OUTCOME_COLORS.WIN },
      { name: 'Derrotas', value: losses, color: OUTCOME_COLORS.LOSS },
      { name: 'Empate (BE)', value: be, color: OUTCOME_COLORS.BE },
    ].filter(d => d.value > 0);
  }, [report]);

  const cascadeRows = useMemo(() => {
    if (!report?.byCascade) return [];
    return Object.entries(report.byCascade).map(([cascade, s]) => ({ cascade, ...s }));
  }, [report]);

  const entryFunnelData = useMemo(() => {
    if (!report?.entryFunnel) return [];
    const reasons = new Set();
    for (const cascade of Object.values(report.entryFunnel)) {
      Object.keys(cascade.byReason || {}).forEach(r => reasons.add(r));
    }
    return [...reasons].map(reason => ({
      reason,
      '4h_15m': report.entryFunnel['4h_15m']?.byReason?.[reason] || 0,
      '1h_5m': report.entryFunnel['1h_5m']?.byReason?.[reason] || 0,
    }));
  }, [report]);

  const handleApplyToScanner = async () => {
    const pineConfig = report?.reproducibility?.pineConfig;
    if (!pineConfig) return;
    const trialLabel = report.trialLabel || 'sem rótulo';
    if (!window.confirm(
      `Aplicar a configuração do trial "${trialLabel}" ao scanner AO VIVO?\n\n` +
      `Isso grava em strategyConfig/current e afeta o próximo scan real (browser + cron).`
    )) return;

    setApplyStatus('applying');
    try {
      const payload = {};
      for (const key of SYNCED_STRATEGY_KEYS) {
        if (pineConfig[key] !== undefined) payload[key] = pineConfig[key];
      }
      await backend.entities.StrategyConfig.set('current', {
        ...payload,
        updated_at: new Date().toISOString(),
      });
      logInfo('backtest', `Config do trial "${trialLabel}" aplicada ao scanner ao vivo`, {
        trialLabel, configHash: report.reproducibility.configHash,
      });
      setApplyStatus('applied');
    } catch (e) {
      setApplyStatus('error');
    } finally {
      setTimeout(() => setApplyStatus(null), 3000);
    }
  };

  if (!report) {
    return (
      <div className="space-y-5 max-w-7xl mx-auto">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Estratégia</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Backtest</h1>
        </div>
        <UploadPanel onLoad={handleLoad} error={error} />
      </div>
    );
  }

  const { overall, costs } = report;
  const inconclusiveLabel = {
    sample_too_small: `amostra pequena demais (${costs.countedTrades} operações, mínimo ${costs.minTrades})`,
    ci_straddles_zero: 'o intervalo de confiança da expectância cruza zero',
    no_r_samples: 'não há operações com R calculável',
  }[costs.inconclusiveReason] || costs.inconclusiveReason;

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Estratégia</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Backtest</h1>
          <p className="text-[10px] font-mono text-muted-foreground mt-1">
            {report.trialLabel ? `Trial: ${report.trialLabel} · ` : ''}
            {new Date(report.range.from).toLocaleDateString('pt-BR')} – {new Date(report.range.to).toLocaleDateString('pt-BR')}
            {report.reproducibility?.commitSha && ` · commit ${report.reproducibility.commitSha.slice(0, 7)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setReport(null)}
            className="px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)' }}>
            Carregar outro relatório
          </button>
          <button onClick={handleApplyToScanner} disabled={!report.reproducibility?.pineConfig || applyStatus === 'applying'}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[10px] font-mono font-bold transition-all disabled:opacity-40"
            style={{
              background: applyStatus === 'applied' ? 'rgba(0,255,128,0.15)' : 'rgba(0,255,128,0.08)',
              border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80',
            }}
            title={!report.reproducibility?.pineConfig ? 'Relatório sem reproducibility.pineConfig — rode com run-backtest.mjs mais recente' : ''}>
            {applyStatus === 'applying' ? <Loader2 className="w-3 h-3 animate-spin" /> : applyStatus === 'applied' ? <CheckCircle2 className="w-3 h-3" /> : <Rocket className="w-3 h-3" />}
            {applyStatus === 'applying' ? 'Aplicando...' : applyStatus === 'applied' ? 'Aplicado!' : applyStatus === 'error' ? 'Erro' : 'Aplicar ao Scanner'}
          </button>
        </div>
      </div>

      {!costs.conclusive && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[11px] font-mono" style={{ background: 'rgba(255,159,67,0.1)', border: '1px solid rgba(255,159,67,0.3)', color: '#ff9f43' }}>
          <AlertTriangle className="w-4 h-4 shrink-0" />
          RESULTADO INCONCLUSIVO — {inconclusiveLabel}. Win rate e profit factor abaixo são ruído nesta amostra.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <SummaryCard icon={overall.expectancyR >= 0 ? TrendingUp : TrendingDown} label="Expectância líquida"
          value={fmtR(overall.expectancyR)} sublabel={`bruta: ${fmtR(overall.grossExpectancyR)}`}
          color={overall.expectancyR >= 0 ? '#00ff80' : '#ff1478'} glowColor={overall.expectancyR >= 0 ? 'rgba(0,255,128,0.4)' : 'rgba(255,20,120,0.4)'} />
        <SummaryCard icon={Target} label="Taxa de acerto" value={`${overall.winRate.toFixed(1)}%`}
          sublabel={`${overall.wins}W · ${overall.be}BE · ${overall.losses}L`}
          color={overall.winRate >= 50 ? '#00ff80' : '#ff9f43'} glowColor="rgba(0,229,255,0.4)" />
        <SummaryCard icon={Award} label="Profit Factor" value={overall.profitFactor === null ? '∞' : overall.profitFactor.toFixed(2)}
          sublabel={overall.profitFactor === null || overall.profitFactor >= 1.5 ? '✓ Saudável' : '⚠ Baixo'}
          color={overall.profitFactor === null || overall.profitFactor >= 1.5 ? '#00ff80' : '#ff9f43'} glowColor="rgba(0,255,128,0.4)" />
        <SummaryCard icon={TrendingDown} label="Máx. Drawdown" value={fmtPct(-overall.maxDrawdownPct)}
          color="#ff1478" glowColor="rgba(255,20,120,0.4)" />
        <SummaryCard icon={FlaskConical} label="Operações" value={`${overall.counted}`}
          sublabel={`${report.totalOps} total · ${report.stillOpenAtCutoff} em aberto`} color="#00e5ff" glowColor="rgba(0,229,255,0.4)" />
        <SummaryCard icon={AlertTriangle} label="Custo médio" value={fmtR(costs.avgCostR)}
          sublabel={`${costs.totalCostPct?.toFixed(2)}% do capital`} color="#ff9f43" glowColor="rgba(255,159,67,0.4)" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Section title="Curva de equity (% acumulado por operação fechada)">
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={equityCurve} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="trade" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} />
                  <YAxis tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} />
                  <Tooltip
                    contentStyle={{ background: 'rgba(10,13,22,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace' }}
                    formatter={(value, name, props) => [`${value}%`, props.payload.symbol || 'cumulativePct']}
                  />
                  <Line type="monotone" dataKey="cumulativePct" stroke="#00e5ff" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Section>
        </div>
        <Section title="Distribuição de resultados">
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={outcomePie} dataKey="value" nameKey="name" innerRadius={45} outerRadius={80} paddingAngle={2}>
                  {outcomePie.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip contentStyle={{ background: 'rgba(10,13,22,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace' }} />
                <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'monospace' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      {cascadeRows.length > 0 && (
        <Section title="Por cascata (4h→15m RF vs 1h→5m SMC)">
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">Cascata</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Operações</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Taxa de acerto</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Expectância</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Profit Factor</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Máx. Drawdown</th>
                </tr>
              </thead>
              <tbody>
                {cascadeRows.map((row, i) => (
                  <tr key={row.cascade} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)', borderTop: '1px solid rgba(255,255,255,0.03)' }}>
                    <td className="px-3 py-2 text-foreground font-semibold">{row.cascade}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{row.counted}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{row.winRate?.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right font-bold" style={{ color: row.expectancyR >= 0 ? '#00ff80' : '#ff1478' }}>{fmtR(row.expectancyR)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{row.profitFactor === null ? '∞' : row.profitFactor?.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{fmtPct(-row.maxDrawdownPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {entryFunnelData.length > 0 && (
        <Section title="Funil de rejeição de entrada (por gate, todas as tentativas do replay)">
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={entryFunnelData} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis type="number" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} />
                <YAxis type="category" dataKey="reason" width={160} tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.5)' }} />
                <Tooltip contentStyle={{ background: 'rgba(10,13,22,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace' }} />
                <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'monospace' }} />
                <Bar dataKey="4h_15m" fill="#00e5ff" />
                <Bar dataKey="1h_5m" fill="#ff9f43" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}
    </div>
  );
}
