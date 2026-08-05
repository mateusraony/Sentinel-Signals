import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import moment from 'moment';
import {
  LineChart, Line, PieChart, Pie, Cell, BarChart, Bar,
  ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  FlaskConical, Upload, TrendingUp, TrendingDown, Target, Award,
  AlertTriangle, CheckCircle2, Rocket, Loader2, Calendar, History, Zap, Sparkles,
} from 'lucide-react';
import { backend } from '@/api/entities';
import { SYNCED_STRATEGY_KEYS, getPineConfig } from '@/lib/pineParser';
import { logInfo } from '@/lib/logger';
import { isClosedOp, getClosedAt, summarizeOps, calcRealizedPnlPct, getExitPrice, classifyOutcome } from '@/lib/tradeMetrics';
import { fetchCandles } from '@/lib/marketDataProvider';
import { runQuickBacktest } from '@/lib/quickBacktest';
import { Slider } from '@/components/ui/slider';
import TriggerBacktestPanel from '@/components/backtest/TriggerBacktestPanel';

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

// Constrói um objeto no mesmo formato de buildReport() (backtestEngine.js) a
// partir de TradeOperation reais já fechadas — reusa summarizeOps() (a MESMA
// função que o motor de backtest usa), então ReportBody funciona idêntico
// para os dois casos sem duplicar nenhuma conta. Não simula nada: só agrega
// o que já aconteceu de verdade.
function buildReportFromOps(ops) {
  const closed = ops.filter(isClosedOp);
  const overall = summarizeOps(closed);
  const groups = {};
  for (const op of closed) {
    const key = op.cascade || 'unknown';
    (groups[key] ||= []).push(op);
  }
  const byCascade = {};
  for (const [cascade, group] of Object.entries(groups)) {
    byCascade[cascade] = summarizeOps(group);
  }
  return {
    totalOps: ops.length,
    stillOpenAtCutoff: ops.length - closed.length,
    overall,
    byCascade,
    costs: {
      avgCostR: overall.avgCostR,
      totalCostPct: overall.totalCostPct,
      grossExpectancyR: overall.grossExpectancyR,
      netExpectancyR: overall.expectancyR,
      conclusive: overall.conclusive,
      inconclusiveReason: overall.inconclusiveReason,
      countedTrades: overall.counted,
      minTrades: overall.minTrades,
    },
  };
}

// Corpo compartilhado de visualização — usado tanto pelo relatório de
// simulação (JSON) quanto pelo desempenho real por período, que produzem o
// mesmo formato (overall/byCascade/costs vêm de summarizeOps nos dois casos).
function ReportBody({ report, hideCascadeTable = false }) {
  const { overall, costs } = report;

  const equityCurve = useMemo(() => {
    if (!overall?.curve) return [];
    return overall.curve
      .filter(p => p.cumulativePct !== null)
      .map((p, i) => ({
        trade: i + 1,
        cumulativePct: +p.cumulativePct.toFixed(2),
        symbol: p.op?.symbol,
        outcome: p.outcome,
      }));
  }, [overall]);

  const outcomePie = useMemo(() => {
    if (!overall) return [];
    const { wins, losses, be } = overall;
    return [
      { name: 'Vitórias', value: wins, color: OUTCOME_COLORS.WIN },
      { name: 'Derrotas', value: losses, color: OUTCOME_COLORS.LOSS },
      { name: 'Empate (BE)', value: be, color: OUTCOME_COLORS.BE },
    ].filter(d => d.value > 0);
  }, [overall]);

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

  const inconclusiveLabel = {
    sample_too_small: `amostra pequena demais (${costs.countedTrades} operações, mínimo ${costs.minTrades})`,
    ci_straddles_zero: 'o intervalo de confiança da expectância cruza zero',
    no_r_samples: 'não há operações com R calculável',
  }[costs.inconclusiveReason] || costs.inconclusiveReason;

  return (
    <div className="space-y-5">
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

      {!hideCascadeTable && cascadeRows.length > 0 && (
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

const STATUS_ICON_COLOR = { TP2_HIT: ['🏆 TP2', '#00ff80'], STOP_HIT: ['🛑 Stop', '#ff1478'] };

// Tabela de operações individuais da simulação instantânea — o relatório de
// simulação (JSON/CI) e o de desempenho real não mostram isso (já têm a
// curva de equity + quebra por cascata), mas aqui o usuário quer ver cada
// trade que a simulação abriu, já que é um teste rápido sobre um único
// ativo/timeframe.
function SimulatedTradesTable({ ops }) {
  if (!ops || ops.length === 0) return null;
  const rows = [...ops].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));

  return (
    <Section title="Operações Simuladas">
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] font-mono">
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
              <th className="text-left px-3 py-2 text-muted-foreground font-medium">Entrada</th>
              <th className="text-left px-3 py-2 text-muted-foreground font-medium">Side</th>
              <th className="text-right px-3 py-2 text-muted-foreground font-medium">Entry</th>
              <th className="text-right px-3 py-2 text-muted-foreground font-medium">Stop</th>
              <th className="text-right px-3 py-2 text-muted-foreground font-medium">TP1</th>
              <th className="text-right px-3 py-2 text-muted-foreground font-medium">TP2</th>
              <th className="text-right px-3 py-2 text-muted-foreground font-medium">Exit</th>
              <th className="text-right px-3 py-2 text-muted-foreground font-medium">P&L</th>
              <th className="text-left px-3 py-2 text-muted-foreground font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((op, i) => {
              const pnl = calcRealizedPnlPct(op);
              const exitPrice = getExitPrice(op);
              const outcome = classifyOutcome(op);
              const [label, color] = outcome === 'BE'
                ? ['🛡️ BE', '#64748b']
                : (STATUS_ICON_COLOR[op.status] || [op.status, '#64748b']);
              const isBuy = op.side === 'BUY';
              return (
                <tr key={op.id} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)', borderTop: '1px solid rgba(255,255,255,0.03)' }}>
                  <td className="px-3 py-2 text-muted-foreground">{moment(op.created_date).format('DD/MM HH:mm')}</td>
                  <td className="px-3 py-2 font-bold" style={{ color: isBuy ? '#00ff80' : '#ff1478' }}>{op.side}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">${op.entry_price?.toFixed(6)}</td>
                  <td className="px-3 py-2 text-right" style={{ color: '#ff1478' }}>${op.initial_stop?.toFixed(6)}</td>
                  <td className="px-3 py-2 text-right" style={{ color: '#ffd166' }}>${op.tp1?.toFixed(6)}</td>
                  <td className="px-3 py-2 text-right" style={{ color: '#00ff80' }}>${op.tp2?.toFixed(6)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{exitPrice != null ? `$${exitPrice.toFixed(6)}` : '—'}</td>
                  <td className="px-3 py-2 text-right font-bold" style={{ color: pnl >= 0 ? '#00ff80' : '#ff1478' }}>{pnl != null ? fmtPct(pnl) : '—'}</td>
                  <td className="px-3 py-2" style={{ color }}>{label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

const QBT_TIMEFRAMES = [
  { id: '1h', label: '1H', minutes: 60 },
  { id: '4h', label: '4H', minutes: 240 },
  { id: '1d', label: '1D', minutes: 1440 },
];
const QBT_CANDLE_OPTIONS = [200, 500, 1000];
const QBT_SLIDERS = [
  { key: 'atrMult', label: 'ATR Mult', min: 0.5, max: 5, step: 0.1, color: '#ff1478' },
  { key: 'tp1R', label: 'TP1 (R)', min: 0.5, max: 4, step: 0.1, color: '#ffd166' },
  { key: 'rfPeriod', label: 'RF Period', min: 5, max: 50, step: 1, color: '#00e5ff' },
  { key: 'rfMult', label: 'RF Mult', min: 0.5, max: 8, step: 0.1, color: '#00ff80' },
  { key: 'minScore', label: 'Min Score', min: 50, max: 100, step: 1, color: '#a78bfa' },
];

// Simulação instantânea single-asset/single-timeframe — ver
// src/lib/quickBacktest.js para o porquê de ser uma aproximação simplificada
// e não o mesmo motor de scanner.js/backtestEngine.js. Roda 100% no
// navegador, sem GitHub Actions, sem gravar nada — é o "e se eu mudasse
// este parâmetro?" imediato.
function QuickBacktestTab() {
  const [assetId, setAssetId] = useState('');
  const [timeframe, setTimeframe] = useState('4h');
  const [candleCount, setCandleCount] = useState(500);
  const [sliders, setSliders] = useState({ atrMult: 2, tp1R: 1.5, rfPeriod: 20, rfMult: 3.5, minScore: 75 });
  const [baseConfig, setBaseConfig] = useState({ atrLen: 14, tp1QtyPercent: 50 });
  const [result, setResult] = useState(null); // { report, ops, candleCount, from, to }
  const [status, setStatus] = useState('idle'); // idle | running | error
  const [errorMsg, setErrorMsg] = useState(null);

  const { data: assets = [] } = useQuery({
    queryKey: ['all-assets'],
    queryFn: () => backend.entities.MonitoredAsset.list('-created_date'),
    staleTime: 60000,
  });

  useEffect(() => {
    let cancelled = false;
    getPineConfig().then(config => {
      if (cancelled) return;
      setBaseConfig({ atrLen: config.atrLen, tp1QtyPercent: config.tp1QtyPercent });
      setSliders(s => ({ ...s, atrMult: config.trailAtrMult ?? s.atrMult, tp1R: config.tp1R ?? s.tp1R, minScore: config.minScore ?? s.minScore }));
    });
    return () => { cancelled = true; };
  }, []);

  const asset = assets.find(a => a.id === assetId);
  const tfMeta = QBT_TIMEFRAMES.find(t => t.id === timeframe);
  const approxDays = Math.round((tfMeta.minutes * candleCount) / (60 * 24));

  const handleRun = async () => {
    if (!asset) return;
    setStatus('running');
    setErrorMsg(null);
    try {
      const candles = await fetchCandles(asset.symbol, timeframe, candleCount);
      const closed = candles.filter(c => c.isClosed);
      const { ops, stillOpen } = runQuickBacktest(closed, { ...sliders, ...baseConfig }, {
        symbol: asset.symbol, timeframe,
      });
      const allOps = stillOpen ? [...ops, { ...stillOpen, status: 'SIGNAL_CONFIRMED' }] : ops;
      const report = buildReportFromOps(allOps);
      setResult({
        report, ops,
        candleCount: closed.length,
        from: closed[0]?.closeTime, to: closed[closed.length - 1]?.closeTime,
      });
      setStatus('idle');
    } catch (e) {
      setStatus('error');
      setErrorMsg(e.message);
    }
  };

  return (
    <div className="space-y-4">
      <Section title="Configuração do Backtest">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-[9px] font-mono text-muted-foreground block mb-1">Ativo</label>
            <select value={assetId} onChange={e => setAssetId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-[11px] font-mono outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(0,229,255,0.2)', color: 'rgba(255,255,255,0.8)' }}>
              <option value="">Selecione...</option>
              {assets.map(a => <option key={a.id} value={a.id}>{a.display_name || a.symbol}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[9px] font-mono text-muted-foreground block mb-1">Timeframe</label>
            <div className="flex items-center gap-1.5">
              {QBT_TIMEFRAMES.map(tf => (
                <button key={tf.id} onClick={() => setTimeframe(tf.id)}
                  className="flex-1 px-3 py-2 rounded-lg text-[11px] font-mono font-bold transition-all"
                  style={timeframe === tf.id
                    ? { background: 'rgba(0,229,255,0.15)', border: '1px solid rgba(0,229,255,0.4)', color: '#00e5ff' }
                    : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.4)' }}>
                  {tf.label}
                </button>
              ))}
            </div>
            <p className="text-[8px] font-mono text-muted-foreground/60 mt-1">~{approxDays} dias</p>
          </div>
          <div>
            <label className="text-[9px] font-mono text-muted-foreground block mb-1">Período (candles)</label>
            <select value={candleCount} onChange={e => setCandleCount(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg text-[11px] font-mono outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(0,229,255,0.2)', color: 'rgba(255,255,255,0.8)' }}>
              {QBT_CANDLE_OPTIONS.map(n => <option key={n} value={n}>{n} candles</option>)}
            </select>
          </div>
        </div>

        <div className="pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="flex items-center gap-1.5 mb-3">
            <Sparkles className="w-3.5 h-3.5" style={{ color: '#ffd166' }} />
            <span className="text-[10px] font-mono font-bold" style={{ color: '#ffd166' }}>AJUSTE FINO (WHAT-IF)</span>
            <span className="text-[9px] font-mono text-muted-foreground">— altere para testar cenários sem afetar o scanner</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {QBT_SLIDERS.map(s => (
              <div key={s.key} className="rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[9px] font-mono text-muted-foreground">{s.label}</span>
                  <span className="text-xs font-mono font-bold" style={{ color: s.color }}>{sliders[s.key]}</span>
                </div>
                <Slider value={[sliders[s.key]]} min={s.min} max={s.max} step={s.step}
                  onValueChange={([v]) => setSliders(prev => ({ ...prev, [s.key]: v }))} />
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button onClick={handleRun} disabled={!asset || status === 'running'}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-[11px] font-mono font-bold transition-all disabled:opacity-40"
            style={{ background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }}>
            {status === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {status === 'running' ? 'Simulando...' : 'Executar Backtest'}
          </button>
          {asset && (
            <span className="text-[9px] font-mono text-muted-foreground">
              {asset.symbol} · {timeframe.toUpperCase()} · {candleCount} candles
            </span>
          )}
        </div>

        {status === 'error' && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[10px] font-mono" style={{ background: 'rgba(255,20,120,0.1)', border: '1px solid rgba(255,20,120,0.3)', color: '#ff1478' }}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{errorMsg}
          </div>
        )}
      </Section>

      {result && (
        <>
          <p className="text-[9px] font-mono text-muted-foreground">
            📅 {moment(result.from).format('DD/MM/YYYY')} → {moment(result.to).format('DD/MM/YYYY')}
            &nbsp;&nbsp;{result.candleCount} candles processados
            &nbsp;&nbsp;RF {sliders.rfPeriod}/{sliders.rfMult} · ATR {sliders.atrMult}x · TP1 {sliders.tp1R}R
          </p>
          <ReportBody report={result.report} hideCascadeTable />
          <SimulatedTradesTable ops={result.ops} />
        </>
      )}
    </div>
  );
}

const PERIOD_PRESETS = [
  { id: 'today', label: 'Hoje' },
  { id: 'week', label: 'Semana' },
  { id: 'month', label: 'Mês' },
  { id: 'last_month', label: 'Mês Passado' },
  { id: 'quarter', label: 'Trimestre' },
  { id: 'year', label: 'Ano' },
  { id: 'all', label: 'Tudo' },
];

// Teto alto o bastante pra cobrir anos de operação real neste projeto (item
// 46/60 de docs/known-risks.md: ~344 operações/ano num backtest de 20
// símbolos, 3 operações reais na produção até hoje) sem buscar o histórico
// inteiro sem limite (a leitura cresceria com o histórico, o que
// .claude/rules/firestore-concurrency.md pede pra evitar). Se algum dia isso
// não for suficiente, o aviso abaixo (allOps.length === REAL_OPS_LIMIT)
// avisa em vez de mostrar métricas erradas silenciosamente.
const REAL_OPS_LIMIT = 3000;

// Desempenho REAL por período — nada de simulação, só as TradeOperation que
// já existem no Firestore, filtradas por data (mesmo padrão de presets já
// usado em Trades.jsx). Zero risco novo: não toca scanner.js nem dispara
// nenhuma execução.
function RealPeriodTab() {
  const [preset, setPreset] = useState('month');

  const dateRange = useMemo(() => {
    if (preset === 'all') return null;
    const now = moment();
    let from; let to;
    switch (preset) {
      case 'today': from = now.clone().startOf('day'); to = now.clone().endOf('day'); break;
      case 'week': from = now.clone().startOf('week'); to = now.clone().endOf('week'); break;
      case 'month': from = now.clone().startOf('month'); to = now.clone().endOf('month'); break;
      case 'last_month': from = now.clone().subtract(1, 'month').startOf('month'); to = now.clone().subtract(1, 'month').endOf('month'); break;
      case 'quarter': from = now.clone().startOf('quarter'); to = now.clone().endOf('quarter'); break;
      case 'year': from = now.clone().startOf('year'); to = now.clone().endOf('year'); break;
      default: return null;
    }
    return { from: from.toDate(), to: to.toDate() };
  }, [preset]);

  const { data: allOps = [], isLoading } = useQuery({
    queryKey: ['backtest-real-ops'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', REAL_OPS_LIMIT),
    staleTime: 60000,
  });

  const filteredOps = useMemo(() => {
    if (!dateRange) return allOps;
    return allOps.filter(op => {
      const d = new Date(getClosedAt(op) || op.created_date);
      return d >= dateRange.from && d <= dateRange.to;
    });
  }, [allOps, dateRange]);

  const report = useMemo(() => (filteredOps.length > 0 ? buildReportFromOps(filteredOps) : null), [filteredOps]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        {PERIOD_PRESETS.map(p => (
          <button key={p.id} onClick={() => setPreset(p.id)}
            className="text-[10px] font-mono px-2.5 py-1 rounded-md transition-all"
            style={preset === p.id
              ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(0,229,255,0.9)' }
              : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
            {p.label}
          </button>
        ))}
      </div>

      {!isLoading && allOps.length === REAL_OPS_LIMIT && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[10px] font-mono" style={{ background: 'rgba(255,159,67,0.1)', border: '1px solid rgba(255,159,67,0.3)', color: '#ff9f43' }}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Mostrando só as {REAL_OPS_LIMIT} operações mais recentes — pode haver operações mais antigas fora deste limite,
          então períodos longos ("Tudo", "Ano") podem estar incompletos.
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : !report ? (
        <div className="rounded-xl p-10 text-center" style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <History className="w-8 h-8 mx-auto mb-3 text-muted-foreground opacity-30" />
          <p className="text-muted-foreground text-sm">Nenhuma operação fechada nesse período.</p>
        </div>
      ) : (
        <ReportBody report={report} />
      )}
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
    <div className="space-y-4">
      <TriggerBacktestPanel onReportReady={onLoad} />

      <div className="rounded-xl p-6 space-y-4 max-w-2xl mx-auto" style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="text-center space-y-1">
          <FlaskConical className="w-8 h-8 mx-auto text-muted-foreground opacity-30" />
          <h2 className="text-base font-bold text-foreground">Ou carregue um relatório já gerado</h2>
          <p className="text-[10px] font-mono text-muted-foreground">
            Baixe o artifact <code>backtest-report.json</code> de um run anterior do GitHub Actions (aba Actions → Backtest
            → o run desejado), ou rode <code>npm run backtest</code> localmente. Depois, carregue o arquivo ou cole o
            conteúdo abaixo.
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
    </div>
  );
}

function JsonReportTab() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [applyStatus, setApplyStatus] = useState(null); // null | 'applying' | 'applied' | 'error'

  const handleLoad = (raw) => {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
    return <UploadPanel onLoad={handleLoad} error={error} />;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <p className="text-[10px] font-mono text-muted-foreground">
          {report.trialLabel ? `Trial: ${report.trialLabel} · ` : ''}
          {new Date(report.range.from).toLocaleDateString('pt-BR')} – {new Date(report.range.to).toLocaleDateString('pt-BR')}
          {report.reproducibility?.commitSha && ` · commit ${report.reproducibility.commitSha.slice(0, 7)}`}
        </p>
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
      <ReportBody report={report} />
    </div>
  );
}

const TABS = [
  { id: 'real', label: 'Desempenho Real', icon: History },
  { id: 'quick', label: 'Ajuste Fino (What-If)', icon: Sparkles },
  { id: 'json', label: 'Simulação (GitHub)', icon: Zap },
];

export default function Backtest() {
  const [tab, setTab] = useState('real');

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Estratégia</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Backtest</h1>
        </div>
        <div className="flex items-center gap-1">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className="flex items-center gap-1.5 text-[10px] font-mono px-3 py-2 rounded-lg transition-all"
              style={tab === t.id
                ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }
                : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)' }}>
              <t.icon className="w-3 h-3" />{t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'real' && <RealPeriodTab />}
      {tab === 'quick' && <QuickBacktestTab />}
      {tab === 'json' && <JsonReportTab />}
    </div>
  );
}
