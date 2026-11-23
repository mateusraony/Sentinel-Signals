import TokenIcon from '@/components/TokenIcon';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import moment from 'moment';
import {
  AreaChart, Area, ReferenceLine, PieChart, Pie, Cell, BarChart, Bar,
  ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  FlaskConical, Upload,
  AlertTriangle, CheckCircle2, Rocket, Loader2, Calendar, History, Zap, Sparkles,
} from 'lucide-react';
import { backend } from '@/api/entities';
import { Tooltip as InfoTooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { SYNCED_STRATEGY_KEYS, DEFAULTS as PINE_DEFAULTS, getPineConfig, getPineConfigStatus } from '@/lib/pineParser';
import { explainReport, reasonLabel, diffAppliedConfig } from '@/lib/backtestInsights';
import { analyzeOps } from '@/lib/backtestAnalysis';
import { resolveIndicatorParams } from '@/lib/scanner';
import {
  summarizeRun, requestKey, runKey, sameParams, changedKeys, loadHistory, saveHistory, addRun, toggleStar, removeRun, rankRuns, bestRun, overfitNote,
  compareSummaries, assessCandles, detectTier, buildDefaults, fidelityRows, reevaluationTargets, buildTradeChart, rHistogram, exitBreakdown, sideBreakdown,
} from '@/lib/whatIf';
import { QBT_TIMEFRAMES, QBT_CANDLE_OPTIONS, QBT_SLIDERS, QBT_SWITCHES, clampDefaults } from '@/components/backtest/whatif/params';
import { SectionTitle } from '@/components/backtest/whatif/ui';
import ComparisonStrip from '@/components/backtest/whatif/ComparisonStrip';
import LiveResultBar from '@/components/backtest/whatif/LiveResultBar';
import TrustPanel, { DataBadge } from '@/components/backtest/whatif/TrustPanel';
import TradesPriceChart from '@/components/backtest/whatif/TradesPriceChart';
import OutcomeAnalysis from '@/components/backtest/whatif/OutcomeAnalysis';
import SignalFunnel from '@/components/backtest/whatif/SignalFunnel';
import SensitivityPanel from '@/components/backtest/whatif/SensitivityPanel';
import RunHistory from '@/components/backtest/whatif/RunHistory';
import { Switch } from '@/components/ui/switch';
import { logInfo } from '@/lib/logger';
import { isClosedOp, getClosedAt, summarizeOps, calcRealizedPnlPct, getExitPrice, classifyOutcome } from '@/lib/tradeMetrics';
import { outcomeColor } from '@/lib/outcomeColor';
import { MetricSummaryCard } from '@/components/MetricSummaryCard';
import { drawdownColor, winRateColor, profitFactorColor, profitFactorLabel } from '@/lib/metricColorRanges';
import { simulateEquityCurve, DEFAULT_INITIAL_CAPITAL, DEFAULT_RISK_PCT } from '@/lib/equityCurve';
import { fetchCandles } from '@/lib/marketDataProvider';
import { runQuickBacktest } from '@/lib/quickBacktest';
import { Slider } from '@/components/ui/slider';
import TriggerBacktestPanel from '@/components/backtest/TriggerBacktestPanel';
import { QueryErrorState } from '@/components/QueryErrorState';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';

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

function fmtUsd(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

const CAGR_UNAVAILABLE_LABEL = {
  window_too_short: 'janela curta demais (< 30 dias)',
  no_time_range: 'sem intervalo de tempo utilizável',
  account_blown: 'conta zerada',
  non_positive_final_capital: 'capital final não positivo',
};

const OUTCOME_COLORS = { WIN: '#5db586', LOSS: '#e06a5b', BE: '#64748b' };

// Seção com o marcador azul no título (mesmo padrão das outras páginas redesenhadas); `hint` é a explicação curta ao lado.
function Section({ title, hint = null, children }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 px-1 flex-wrap">
        <span aria-hidden="true" style={{ width: 3, height: 16, borderRadius: 2, background: '#8db4e2', display: 'inline-block' }} />
        <h2 className="text-sm font-semibold text-foreground/80">{title}</h2>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="rounded-md p-4 space-y-3" style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
        {children}
      </div>
    </section>
  );
}

const CASCADE_NAME = { '4h_15m': '4h → 15m (Range Filter)', '1h_5m': '1h → 5m (SMC)', unknown: 'sem cascata registrada' };

// "O que este resultado diz": a leitura em português do relatório (regras em src/lib/backtestInsights.js — só texto, não decide nada).
const VERDICT_STYLE = {
  inconclusive: { color: '#dd9a4a', bg: 'rgba(221,154,74,0.07)', border: 'rgba(221,154,74,0.28)', Icon: AlertTriangle },
  positive: { color: '#5db586', bg: 'rgba(93,181,134,0.07)', border: 'rgba(93,181,134,0.25)', Icon: CheckCircle2 },
  negative: { color: '#e06a5b', bg: 'rgba(224,106,91,0.07)', border: 'rgba(224,106,91,0.28)', Icon: AlertTriangle },
  empty: { color: 'rgba(255,255,255,0.6)', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.1)', Icon: History },
};

function ReportVerdict({ report, source }) {
  const insight = explainReport(report, source);
  const st = VERDICT_STYLE[insight.tone];
  return (
    <div role="status" aria-label="O que este resultado diz" className="rounded-md px-4 py-3 flex items-start gap-3" style={{ background: st.bg, border: `1px solid ${st.border}` }}>
      <st.Icon className="w-5 h-5 shrink-0 mt-0.5" style={{ color: st.color }} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold" style={{ color: st.color }}>{insight.headline}</p>
        {insight.lines.length > 0 && (
          <ul className="text-xs text-foreground/75 mt-1 space-y-0.5 list-disc pl-4">
            {insight.lines.map(l => <li key={l}>{l}</li>)}
          </ul>
        )}
        {insight.note && <p className="text-11px text-muted-foreground mt-1.5">{insight.note}</p>}
      </div>
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
function ReportBody({ report, hideCascadeTable = false, source = undefined }) {
  const { overall, costs } = report;

  const [initialCapital, setInitialCapital] = useState(DEFAULT_INITIAL_CAPITAL);
  const [riskPct, setRiskPct] = useState(DEFAULT_RISK_PCT);

  // Achado M-9 do Raio-X (Codex review no PR #428): role="img" colapsa todo
  // o SVG do gráfico numa "caixa preta" pra leitor de tela — um aria-label só
  // com contagem/total fica idêntico entre 2 séries de trajetória diferente
  // (mesmo nº de operações, mesmo total, caminho diferente). Como o nº de
  // operações aqui não tem teto (ao contrário dos widgets do Dashboard, com
  // poucas categorias fixas), enumerar tudo no aria-label seria uma string
  // gigante lida ponto a ponto — em vez disso, o aria-label continua um
  // resumo curto e uma tabela `sr-only` (oculta visualmente, presente na
  // árvore de acessibilidade) linkada via aria-details carrega o dado
  // ponto a ponto. Achado do Codex review no PR #429 (item 228, mesmo
  // padrão introduzido aqui): `aria-describedby` colapsaria a tabela
  // inteira num texto único, lido de uma vez só pelo leitor de tela —
  // `aria-details` (ARIA 1.2) preserva a estrutura, deixando a tabela
  // navegável por conta própria.
  const equityCurveTableId = useId();
  const realEquityTableId = useId();

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

  // Round 4 da nova varredura pós-Raio-X (2026-09-27): cor por sinal do
  // total acumulado — mesma fórmula de src/components/trades/PnLChart.jsx.
  const naiveGradColor = equityCurve.length > 0 && equityCurve[equityCurve.length - 1].cumulativePct >= 0 ? '#5db586' : '#e06a5b';

  // Operações reais (mesma fonte que opsFromReport usa em backtestAnalysis.js
  // — não muda a forma de overall.curve) alimentando a curva de capital REAL
  // (composta, position sizing por risco) — ver src/lib/equityCurve.js.
  const equitySim = useMemo(() => {
    const ops = (overall?.curve || []).map(e => e.op).filter(Boolean);
    if (ops.length === 0) return null;
    return simulateEquityCurve(ops, { initialCapital, riskPct, costModel: costs?.model });
  }, [overall, costs, initialCapital, riskPct]);

  const realEquityChart = useMemo(() => {
    if (!equitySim?.curve) return [];
    return equitySim.curve.map((p, i) => ({
      trade: i + 1,
      capitalAfter: +p.capitalAfter.toFixed(2),
      symbol: p.op?.symbol,
    }));
  }, [equitySim]);

  // Round 4 da nova varredura pós-Raio-X (2026-09-27): cor por sinal do
  // retorno total (já calculado em equitySim, usado no card "Capital final").
  const realGradColor = equitySim?.totalReturnPct >= 0 ? '#5db586' : '#e06a5b';

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

  return (
    <div className="space-y-5">
      <ReportVerdict report={report} source={source} />

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <MetricSummaryCard flat label="Expectância líquida"
          value={fmtR(overall.expectancyR)} sublabel={`bruta: ${fmtR(overall.grossExpectancyR)}`}
          color={overall.expectancyR >= 0 ? '#5db586' : '#e06a5b'}
          tooltip="R = resultado da operação dividido pelo risco inicial (distância entre entrada e stop). Expectância líquida é a média de R por operação, já descontando taxa/slippage/funding (ver 'Custo médio' ao lado); 'bruta' é sem esses custos." />
        <MetricSummaryCard flat label="Taxa de acerto" value={`${overall.winRate.toFixed(1)}%`}
          sublabel={`${overall.wins}W · ${overall.be}BE · ${overall.losses}L`}
          color={winRateColor(overall.winRate)} />
        <MetricSummaryCard flat label="Profit Factor" value={overall.profitFactor === null ? (overall.wins > 0 ? '∞' : '—') : overall.profitFactor.toFixed(2)}
          sublabel={profitFactorLabel(overall.profitFactor, overall.wins > 0)}
          color={profitFactorColor(overall.profitFactor, overall.wins > 0)}
          tooltip="Soma dos ganhos ÷ soma das perdas (valor absoluto). Acima de 1 = ganhos superam perdas no total; ≥ 1,5 é o piso considerado saudável aqui. '∞' quando não houve nenhuma perda na amostra." />
        <MetricSummaryCard flat label="Máx. Drawdown" value={fmtPct(-overall.maxDrawdownPct)}
          color={drawdownColor(overall.maxDrawdownPct)} />
        <MetricSummaryCard flat label="Operações" value={`${overall.counted}`}
          sublabel={`${report.totalOps} total · ${report.stillOpenAtCutoff} em aberto`} color="#8db4e2" />
        <MetricSummaryCard flat label="Custo médio" value={fmtR(costs.avgCostR)}
          sublabel={costs.totalCostPct != null ? `${costs.totalCostPct.toFixed(2)}% do capital` : undefined} color="#dd9a4a" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Section title="Curva ingênua" hint="soma simples de % por operação, NÃO composta — a curva de capital real está mais abaixo">
            <div style={{ height: 260 }} role="img" aria-details={equityCurve.length > 0 ? equityCurveTableId : undefined}
              aria-label={`Gráfico de área da curva ingênua de PnL acumulado (soma simples), ${equityCurve.length} operações${equityCurve.length > 0 ? `, ${fmtPct(equityCurve[equityCurve.length - 1].cumulativePct)} no total` : ''}`}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equityCurve} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  {/* Round 4 da nova varredura pós-Raio-X (2026-09-27): cor
                      por sinal do total acumulado + gradiente + ReferenceLine
                      em y=0 — mesmo padrão já em produção em
                      src/components/trades/PnLChart.jsx, que este gráfico
                      (mesmo conceito, cascata em vez de trades reais) não
                      seguia. */}
                  <defs>
                    <linearGradient id="naiveEquityGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={naiveGradColor} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={naiveGradColor} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="trade" tick={{ fontSize: 11, fill: 'rgba(255,255,255,0.62)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'rgba(255,255,255,0.62)' }} />
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                  <Tooltip
                    contentStyle={{ background: 'rgba(24,23,21,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace' }}
                    formatter={(value, name, props) => [`${value}%`, props.payload.symbol ? <span className="inline-flex items-center gap-1"><TokenIcon symbol={props.payload.symbol} size={12} />{props.payload.symbol}</span> : 'cumulativePct']}
                  />
                  <Area type="monotone" dataKey="cumulativePct" stroke={naiveGradColor} strokeWidth={1.5}
                    fill="url(#naiveEquityGrad)" dot={false} activeDot={{ r: 3, fill: naiveGradColor }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            {equityCurve.length > 0 && (
              <table id={equityCurveTableId} className="sr-only">
                <caption>Curva ingênua de PnL acumulado, operação por operação</caption>
                <thead>
                  <tr><th scope="col">Operação</th><th scope="col">Símbolo</th><th scope="col">Resultado</th><th scope="col">PnL acumulado</th></tr>
                </thead>
                <tbody>
                  {equityCurve.map(p => (
                    <tr key={p.trade}>
                      <td>{p.trade}</td><td>{p.symbol || '—'}</td><td>{p.outcome || '—'}</td><td>{fmtPct(p.cumulativePct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>
        <Section title="Distribuição de resultados" hint="como as operações terminaram">
          <div style={{ height: 260 }} role="img"
            aria-label={`Gráfico de pizza da distribuição de resultados: ${outcomePie.map(d => `${d.name} ${d.value}`).join(', ')}`}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={outcomePie} dataKey="value" nameKey="name" innerRadius={45} outerRadius={80} paddingAngle={2}>
                  {outcomePie.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                {/* Achado da varredura pós-Raio-X (2026-09-27): tooltip de
                    pizza mostrava só a contagem bruta, sem % do total —
                    justamente o dado que mais importa numa pizza. */}
                <Tooltip
                  contentStyle={{ background: 'rgba(24,23,21,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace' }}
                  formatter={(value, name) => {
                    const total = outcomePie.reduce((s, d) => s + d.value, 0);
                    const numValue = Number(value);
                    return [`${value} (${total > 0 ? Math.round(numValue / total * 100) : 0}%)`, name];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'monospace' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      {equitySim && (
        <Section title="Curva de capital real" hint="composta: cada operação arrisca uma % do capital atual">
          <p className="text-11px font-mono text-muted-foreground/70 -mt-1 mb-1">
            Dimensiona cada operação como {riskPct}% do capital CORRENTE (não do inicial) sobre o risco da
            entrada — diferente da curva ingênua acima, aqui o capital efetivamente compõe ao longo da série.
            Simplificação: assume um único pool de capital disputado sequencialmente por ordem de fechamento,
            não posições simultâneas em vários ativos.
          </p>
          <div className="flex flex-wrap items-end gap-4 mb-2">
            <div>
              <label className="text-11px font-mono text-muted-foreground block mb-1">Capital inicial</label>
              <input type="number" min={1} step={100} value={initialCapital}
                onChange={e => setInitialCapital(Math.max(1, Number(e.target.value) || DEFAULT_INITIAL_CAPITAL))}
                className="w-28 px-3 py-1.5 rounded-md text-11px font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(141,180,226,0.2)', color: 'rgba(255,255,255,0.8)' }} />
            </div>
            <div className="w-40">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-11px font-mono text-muted-foreground">Risco por operação</span>
                <span className="text-xs font-mono font-bold" style={{ color: '#e3b45a' }}>{riskPct}%</span>
              </div>
              <Slider value={[riskPct]} min={0.1} max={5} step={0.1} onValueChange={([v]) => setRiskPct(v)} />
            </div>
            {equitySim.accountBlown && (
              <span className="px-2.5 py-1 rounded-md text-11px font-mono font-bold"
                style={{ background: 'rgba(224,106,91,0.15)', border: '1px solid rgba(224,106,91,0.4)', color: '#e06a5b' }}>
                CONTA ZERADA
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <MetricSummaryCard flat label="Capital final"
              value={fmtUsd(equitySim.finalCapital)} sublabel={fmtPct(equitySim.totalReturnPct)}
              color={equitySim.totalReturnPct >= 0 ? '#5db586' : '#e06a5b'} />
            <MetricSummaryCard flat label="Drawdown real" value={fmtPct(-equitySim.maxDrawdownPct)}
              sublabel={fmtUsd(-equitySim.maxDrawdownAbs)} color={drawdownColor(equitySim.maxDrawdownPct)} />
            <MetricSummaryCard flat label="CAGR"
              value={equitySim.cagrPct === null ? 'N/A' : fmtPct(equitySim.cagrPct)}
              sublabel={equitySim.cagrPct === null ? (CAGR_UNAVAILABLE_LABEL[equitySim.cagrUnavailableReason] || equitySim.cagrUnavailableReason) : `~${equitySim.years?.toFixed(2)} anos`}
              color="#8db4e2"
              tooltip="Taxa de crescimento anual composta, extrapolada a partir do período coberto pela simulação — não é garantia de retorno futuro." />
            <MetricSummaryCard flat label="Operações dimensionadas" value={`${equitySim.sized}/${equitySim.total}`}
              sublabel={equitySim.unsized > 0 ? `${equitySim.unsized} sem risco definido` : 'todas dimensionadas'}
              color="#8db4e2" />
          </div>

          <div style={{ height: 220 }} role="img" aria-details={realEquityChart.length > 0 ? realEquityTableId : undefined}
            aria-label={`Gráfico de área da curva de capital real, capital final ${fmtUsd(equitySim.finalCapital)} (${fmtPct(equitySim.totalReturnPct)})`}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={realEquityChart} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                {/* Round 4 da nova varredura pós-Raio-X (2026-09-27): mesmo
                    padrão do gráfico acima — cor por sinal do retorno total
                    + gradiente + ReferenceLine. Aqui a referência é o
                    CAPITAL INICIAL, não zero — o eixo é capital em $, não
                    PnL/%, então y=0 nunca é um valor plausível no gráfico. */}
                <defs>
                  <linearGradient id="realEquityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={realGradColor} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={realGradColor} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="trade" tick={{ fontSize: 11, fill: 'rgba(255,255,255,0.62)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'rgba(255,255,255,0.62)' }} tickFormatter={v => fmtUsd(v, 0)} />
                <ReferenceLine y={initialCapital} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                <Tooltip
                  contentStyle={{ background: 'rgba(24,23,21,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace' }}
                  formatter={(value, name, props) => [fmtUsd(value), props.payload.symbol ? <span className="inline-flex items-center gap-1"><TokenIcon symbol={props.payload.symbol} size={12} />{props.payload.symbol}</span> : 'capital']}
                />
                <Area type="monotone" dataKey="capitalAfter" stroke={realGradColor} strokeWidth={1.5}
                  fill="url(#realEquityGrad)" dot={false} activeDot={{ r: 3, fill: realGradColor }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {realEquityChart.length > 0 && (
            <table id={realEquityTableId} className="sr-only">
              <caption>Curva de capital real, capital após cada operação</caption>
              <thead>
                <tr><th scope="col">Operação</th><th scope="col">Símbolo</th><th scope="col">Capital após</th></tr>
              </thead>
              <tbody>
                {realEquityChart.map(p => (
                  <tr key={p.trade}><td>{p.trade}</td><td>{p.symbol || '—'}</td><td>{fmtUsd(p.capitalAfter)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {!hideCascadeTable && cascadeRows.length > 0 && (
        <Section title="Por cascata" hint="4h → 15m (Range Filter) × 1h → 5m (SMC)">
          <div className="overflow-x-auto">
            <table className="w-full text-11px font-mono">
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">Cascata</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Operações</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Taxa de acerto</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                    <InfoTooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">Expectância</span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                        Média de R (resultado ÷ risco inicial) por operação
                      </TooltipContent>
                    </InfoTooltip>
                  </th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                    <InfoTooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">Profit Factor</span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                        Soma dos ganhos ÷ soma das perdas — acima de 1 significa que os ganhos superam as perdas no total
                      </TooltipContent>
                    </InfoTooltip>
                  </th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Máx. Drawdown</th>
                </tr>
              </thead>
              <tbody>
                {cascadeRows.map((row, i) => (
                  <tr key={row.cascade} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)', borderTop: '1px solid rgba(255,255,255,0.03)' }}>
                    <td className="px-3 py-2 text-foreground font-semibold">{CASCADE_NAME[row.cascade] ?? row.cascade}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{row.counted}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{row.winRate?.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right font-bold" style={{ color: row.expectancyR >= 0 ? '#5db586' : '#e06a5b' }}>{fmtR(row.expectancyR)}</td>
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
        <Section title="Por que as entradas foram barradas" hint="funil de rejeição: todas as tentativas do replay, por motivo">
          <div style={{ height: 280 }} role="img"
            aria-label={`Gráfico de barras do funil de rejeição de entrada por motivo: ${entryFunnelData.map(r => `${r.reason}: ${r['4h_15m']} em 4h→15m, ${r['1h_5m']} em 1h→5m`).join('; ')}`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={entryFunnelData} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis type="number" tick={{ fontSize: 11, fill: 'rgba(255,255,255,0.62)' }} />
                <YAxis type="category" dataKey="reason" width={215} tick={{ fontSize: 11, fill: 'rgba(255,255,255,0.5)' }} />
                <Tooltip contentStyle={{ background: 'rgba(24,23,21,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace' }} />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'monospace' }} />
                <Bar dataKey="4h_15m" fill="#8db4e2" />
                <Bar dataKey="1h_5m" fill="#dd9a4a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <details className="rounded-md" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <summary className="px-3 py-2 text-xs cursor-pointer select-none text-foreground/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-md">O que significa cada motivo</summary>
            <ul className="px-3 pb-3 space-y-1 text-xs text-foreground/75">
              {entryFunnelData.map(r => (
                <li key={r.reason}><span className="font-mono text-foreground/90">{r.reason}</span> — {reasonLabel(r.reason) ?? 'sem descrição (código gravado pelo motor)'}</li>
              ))}
            </ul>
          </details>
        </Section>
      )}
    </div>
  );
}

const STATUS_ICON_COLOR = { TP2_HIT: ['🏆 TP2', '#5db586'], STOP_HIT: ['🛑 Stop', '#e06a5b'] };

// Tabela de operações individuais da simulação instantânea — o relatório de
// simulação (JSON/CI) e o de desempenho real não mostram isso (já têm a
// curva de equity + quebra por cascata), mas aqui o usuário quer ver cada
// trade que a simulação abriu, já que é um teste rápido sobre um único
// ativo/timeframe.
function SimulatedTradesTable({ ops }) {
  if (!ops || ops.length === 0) return null;
  const rows = [...ops].sort((a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime());

  return (
    <Section title="Operações Simuladas">
      <div className="overflow-x-auto">
        <table className="w-full text-11px font-mono">
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
              // Round 4 da nova varredura pós-Raio-X (2026-09-27): a cor do
              // caso "não-BE" agora vem de outcomeColor (src/lib/outcomeColor.js)
              // em vez do mapa fixo local — mesma correção já aplicada em
              // TradeHistory.jsx/MonthlyReport.jsx (STOP_HIT com outcome WIN
              // fica verde, não mais preso ao fallback vermelho de
              // STATUS_ICON_COLOR). O caso BE continua tratado à parte, cinza
              // uniforme independente do status — design já existente aqui,
              // fora do escopo desta rodada.
              const [label, color] = outcome === 'BE'
                ? ['🟡 BE', '#64748b']
                : [op.closed_reason === 'TIME_STOP' ? '⏱ Time stop' : (op.pre_tp1_trailed && op.status === 'STOP_HIT' && !op.tp1_hit ? 'Stop (trailing)' : (STATUS_ICON_COLOR[op.status]?.[0] || op.status)), outcomeColor(op.status, outcome)];
              const isBuy = op.side === 'BUY';
              return (
                <tr key={op.id} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)', borderTop: '1px solid rgba(255,255,255,0.03)' }}>
                  <td className="px-3 py-2 text-muted-foreground">{moment(op.created_date).format('DD/MM HH:mm')}</td>
                  <td className="px-3 py-2 font-bold" style={{ color: isBuy ? '#5db586' : '#e06a5b' }}>{op.side}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">${op.entry_price?.toFixed(6)}</td>
                  <td className="px-3 py-2 text-right" style={{ color: '#e06a5b' }}>${op.initial_stop?.toFixed(6)}</td>
                  <td className="px-3 py-2 text-right" style={{ color: '#e3b45a' }}>${op.tp1?.toFixed(6)}</td>
                  <td className="px-3 py-2 text-right" style={{ color: '#5db586' }}>${op.tp2?.toFixed(6)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{exitPrice != null ? `$${exitPrice.toFixed(6)}` : '—'}</td>
                  <td className="px-3 py-2 text-right font-bold" style={{ color: pnl >= 0 ? '#5db586' : '#e06a5b' }}>{pnl != null ? fmtPct(pnl) : '—'}</td>
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

const WHATIF_AUTO_KEY = 'sentinel_whatif_auto_v1';
const readAuto = () => { try { return localStorage.getItem(WHATIF_AUTO_KEY) !== '0'; } catch { return true; } };
const safeStorage = () => { try { return localStorage; } catch { return null; } };
const FALLBACK_DEFAULTS = { atrMult: 2, tp1R: 1.5, rfPeriod: 20, rfMult: 3.5, minScore: 75, regime: 1, timeStop: 1, trail: 1, trailStart: 1, trailDist: 2 };
const NO_RUN = { expectancyR: null, counted: 0 };

// Uma simulação completa: motor + relatório (mesmo summarizeOps das outras abas) + resumo numérico. Nunca lança: erro vira { ok: false, error }.
function simulate(closed, params, extra, meta) {
  try {
    // `regime`, `timeStop` e `trail` são interruptores 0/1 nos parâmetros; o motor recebe os objetos de configuração (ou null).
    const { regime, timeStop, trail, trailStart, trailDist, ...nums } = params;
    const { regimeCfg, timeStopCfg, ...rest } = extra;
    const { ops, stillOpen, stats } = runQuickBacktest(closed, {
      ...nums, ...rest, regimeFilter: regime ? regimeCfg : null, timeStop: timeStop ? timeStopCfg : null,
      preTp1Trail: trail ? { startAtrMult: trailStart, trailAtrMult: trailDist } : null,
    }, meta);
    const allOps = stillOpen ? [...ops, { ...stillOpen, status: 'SIGNAL_CONFIRMED' }] : ops;
    const report = buildReportFromOps(allOps);
    return { ok: true, ops, stillOpen, stats, report, summary: summarizeRun(report.overall) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Simulação instantânea single-asset/single-timeframe — ver src/lib/quickBacktest.js para o porquê de ser uma aproximação simplificada
// e não o mesmo motor de scanner.js/backtestEngine.js. Roda 100% no navegador, sem GitHub Actions, sem gravar nada no banco.
// Desde 22/11/2026: recalcula SOZINHA quando você mexe (a conta leva ~2 ms), compara com o padrão, guarda cada teste num histórico
// (neste navegador) e mostra a conferência dos dados — para você não se perder entre o que testou e o que deu melhor.
function QuickBacktestTab() {
  const [assetId, setAssetId] = useState('');
  const [timeframe, setTimeframe] = useState('4h');
  const [candleCount, setCandleCount] = useState(500);
  const [params, setParams] = useState(FALLBACK_DEFAULTS); // o que está nos controles
  const [applied, setApplied] = useState(FALLBACK_DEFAULTS); // o que gerou o resultado em tela
  const [auto, setAuto] = useState(readAuto);
  const [pineConfig, setPineConfig] = useState(null);
  const [data, setData] = useState(null); // { key, raw, closed, fetchedAt }
  const [dataStatus, setDataStatus] = useState('idle'); // idle | loading | error
  const [errorMsg, setErrorMsg] = useState(null);
  const [history, setHistory] = useState(() => loadHistory(safeStorage()));
  const [sortBy, setSortBy] = useState('expectancy');
  const [saveFailed, setSaveFailed] = useState(false);
  // true enquanto o usuário ARRASTA um controle: o histórico só registra um teste depois que ele SOLTA (pedido do usuário, 23/11).
  const [interacting, setInteracting] = useState(false);
  const touchedRef = useRef(false); // true depois que o usuário mexe: aí o padrão novo não sobrescreve os controles
  const fetchSeq = useRef(0);

  const { data: assets = [], isLoading: assetsLoading, isError: assetsError, refetch: refetchAssets } = useQuery({
    queryKey: ['all-assets'],
    queryFn: () => backend.entities.MonitoredAsset.list('-created_date'),
    staleTime: 60000,
  });

  useEffect(() => {
    let cancelled = false;
    getPineConfig().then(config => { if (!cancelled) setPineConfig(config); });
    return () => { cancelled = true; };
  }, []);

  const asset = assets.find(a => a.id === assetId);
  const assetSymbol = asset?.symbol;
  const tfMeta = QBT_TIMEFRAMES.find(t => t.id === timeframe);
  const approxDays = Math.round((tfMeta.minutes * candleCount) / (60 * 24));
  // `windowEnd` = fechamento da última vela carregada: identifica a JANELA REAL de dados (achado do Codex, PR #617). Mudou a janela, mudou o grupo do histórico.
  const windowEnd = data ? data.closed[data.closed.length - 1]?.closeTime ?? null : null;
  const dataset = useMemo(() => (assetSymbol ? { assetId, symbol: assetSymbol, timeframe, candleCount, windowEnd } : null), [assetId, assetSymbol, timeframe, candleCount, windowEnd]);

  // Candles: buscados sozinhos ao escolher/trocar ativo, timeframe ou período (guarda contra resposta atrasada de uma busca antiga).
  const fetchData = useCallback(async () => {
    if (!assetSymbol) return;
    const seq = ++fetchSeq.current;
    setDataStatus('loading');
    setErrorMsg(null);
    try {
      const raw = await fetchCandles(assetSymbol, timeframe, candleCount);
      if (seq !== fetchSeq.current) return;
      setData({ key: `${assetId}|${timeframe}|${candleCount}`, raw, closed: raw.filter(c => c.isClosed), fetchedAt: Date.now() });
      setDataStatus('idle');
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setDataStatus('error');
      setErrorMsg(e.message);
    }
  }, [assetId, assetSymbol, timeframe, candleCount]);

  useEffect(() => {
    setData(null);
    if (assetSymbol) fetchData();
    else { fetchSeq.current += 1; setDataStatus('idle'); }
  }, [fetchData, assetSymbol]);

  // Padrões: o stop vem do TIER do ativo (como no scanner), o RF vem do próprio ativo, o resto do Pine salvo.
  const tier = useMemo(() => (data ? detectTier(data.closed, pineConfig ?? {}) : null), [data, pineConfig]);
  const defaults = useMemo(() => clampDefaults(buildDefaults({ pineConfig: pineConfig ?? {}, asset, tier })), [pineConfig, asset, tier]);

  useEffect(() => {
    if (!touchedRef.current) { setParams(defaults); setApplied(defaults); }
  }, [defaults]);

  // Soltou o botão do mouse/dedo em qualquer lugar: o arrasto acabou (rede de segurança caso o próprio slider não avise).
  useEffect(() => {
    const end = () => setInteracting(false);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
  }, []);

  // Recalcula sozinho (com um respiro de 250 ms para o slider não disparar a cada pixel).
  useEffect(() => {
    if (!auto || sameParams(params, applied)) return undefined;
    const t = setTimeout(() => setApplied(params), 250);
    return () => clearTimeout(t);
  }, [params, applied, auto]);

  const stale = !sameParams(params, applied);
  const meta = useMemo(() => ({ symbol: assetSymbol, timeframe }), [assetSymbol, timeframe]);
  const extra = useMemo(() => {
    const ind = resolveIndicatorParams(asset ?? {}, pineConfig ?? {});
    const pc = pineConfig ?? {};
    return {
      tp1QtyPercent: pc.tp1QtyPercent ?? 50, atrLen: ind.atrStopPeriod, emaFast: ind.emaFast, emaSlow: ind.emaSlow,
      tierThresholds: { tier2: pc.tier2Threshold ?? 0.8, tier3: pc.tier3Threshold ?? 1.5 },
      regimeCfg: { useADX: pc.useADX !== false, useChop: pc.useChop !== false, adxLen: pc.adxLen ?? 14, adxSmooth: pc.adxSmooth ?? 14, chopLen: pc.chopLen ?? 14 },
      timeStopCfg: { T1: pc.timeStopT1 ?? 48, T2: pc.timeStopT2 ?? 64, T3: pc.timeStopT3 ?? 96 },
    };
  }, [asset, pineConfig]);

  const run = useMemo(() => (data ? simulate(data.closed, applied, extra, meta) : null), [data, applied, extra, meta]);
  const baseline = useMemo(() => (data ? simulate(data.closed, defaults, extra, meta) : null), [data, defaults, extra, meta]);
  const runSummary = useCallback((p) => {
    const r = data ? simulate(data.closed, p, extra, meta) : null;
    return r?.ok ? r.summary : NO_RUN;
  }, [data, extra, meta]);

  const quality = useMemo(() => (data ? assessCandles({ raw: data.raw, closed: data.closed, requested: candleCount, timeframe, startIndex: run?.ok ? run.stats.startIndex : 0, now: data.fetchedAt }) : null),
    [data, candleCount, timeframe, run]);
  const cmp = useMemo(() => (run?.ok && baseline?.ok ? compareSummaries(run.summary, baseline.summary) : null), [run, baseline]);
  const fidelity = useMemo(() => fidelityRows(pineConfig ?? {}, { emaFast: extra.emaFast, emaSlow: extra.emaSlow }, { regime: applied.regime, timeStop: applied.timeStop, trail: applied.trail }), [pineConfig, extra, applied]);
  const chart = useMemo(() => (run?.ok ? buildTradeChart(data.closed, run.ops, run.stats.startIndex) : null), [run, data]);
  const analysis = useMemo(() => (run?.ok ? analyzeOps(run.ops) : null), [run]);
  const isDefault = sameParams(applied, defaults);

  // Histórico: o teste é registrado sozinho, mas SÓ depois que o usuário solta o controle (nada de gravar valores do meio do arrasto) e com o resultado já
  // calculado para esses valores. A identidade é pedido + valores: repetir os mesmos valores atualiza o registro, não cria outro.
  const currentKey = dataset ? runKey(dataset, applied) : null;
  const recordable = !interacting && sameParams(params, applied);
  useEffect(() => {
    if (!recordable || !dataset || !run?.ok || !data || data.key !== requestKey(dataset)) return undefined;
    const t = setTimeout(() => {
      const rec = { key: runKey(dataset, applied), at: new Date().toISOString(), dataset: { ...dataset, lastCandleTime: data.closed[data.closed.length - 1]?.closeTime ?? null }, params: applied, summary: run.summary, starred: false };
      setHistory(h => addRun(h, rec));
    }, 700);
    return () => clearTimeout(t);
  }, [run, dataset, applied, data, recordable]);
  useEffect(() => { setSaveFailed(!saveHistory(safeStorage(), history)); }, [history]);

  const ranked = useMemo(() => (dataset ? rankRuns(history, dataset, sortBy) : { same: [], others: history }), [history, dataset, sortBy]);
  const best = useMemo(() => bestRun(ranked.same), [ranked]);
  const overfit = dataset ? overfitNote(ranked.same.length) : null;
  // "Este teste" sempre à vista no painel do histórico (com 10+ testes a linha dele pode estar fora da parte visível da lista).
  const currentRank = currentKey ? ranked.same.findIndex(r => r.key === currentKey) : -1;
  const currentRun = currentRank >= 0 ? ranked.same[currentRank] : null;

  // Reavaliar: roda de novo, nos dados de AGORA, os parâmetros de testes feitos em janelas anteriores (cada execução leva ~2 ms).
  const [reevalMsg, setReevalMsg] = useState(null);
  const reevalTargets = useMemo(() => (dataset && run?.ok ? reevaluationTargets(history, dataset) : []), [history, dataset, run]);
  useEffect(() => { setReevalMsg(null); }, [windowEnd, assetId, timeframe, candleCount]);
  const handleReeval = () => {
    const now = new Date().toISOString();
    const recs = reevalTargets.map(t => {
      const r = simulate(data.closed, t.params, extra, meta);
      return r.ok ? { key: runKey(dataset, t.params), at: now, dataset: { ...dataset }, params: t.params, summary: r.summary, starred: t.starred } : null;
    }).filter(Boolean);
    setHistory(h => recs.reduce((acc, rec) => addRun(acc, rec), h));
    setReevalMsg(`${recs.length} ${recs.length === 1 ? 'teste reavaliado' : 'testes reavaliados'} nos dados atuais.`);
  };

  const changedCount = changedKeys(params, defaults).length;
  const setParam = (key, v) => { touchedRef.current = true; setParams(prev => ({ ...prev, [key]: v })); };
  const resetToDefaults = () => { touchedRef.current = false; setParams(defaults); setApplied(defaults); };
  const handleRun = () => { setApplied(params); fetchData(); };
  const handleUse = (r) => {
    touchedRef.current = true;
    setAssetId(r.dataset.assetId); setTimeframe(r.dataset.timeframe); setCandleCount(r.dataset.candleCount);
    setParams(r.params); setApplied(r.params);
  };
  const toggleAuto = (v) => { setAuto(v); try { localStorage.setItem(WHATIF_AUTO_KEY, v ? '1' : '0'); } catch { /* sem armazenamento: só não lembra */ } };
  const onAssetChange = (id) => { touchedRef.current = false; setAssetId(id); };

  // Um controle deslizante com o valor, o "padrão X" e o ● de diferente. `off` apaga o controle (ex.: ajustes do trailing com o trailing desligado).
  const renderSlider = (s, off = false) => {
    const differs = !off && params[s.key] !== defaults[s.key];
    return (
      <div key={s.key} className="rounded-md px-3 py-2" title={s.help} style={{ background: 'rgba(255,255,255,0.02)', border: `1px solid ${differs ? 'rgba(221,154,74,0.3)' : 'rgba(255,255,255,0.05)'}` }}>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-muted-foreground">{s.label}{differs && <span aria-label="diferente do padrão" style={{ color: '#dd9a4a' }}> ●</span>}</span>
          <span className="text-xs font-mono font-semibold tabular-nums" style={{ color: s.color }}>{params[s.key]}</span>
        </div>
        <Slider value={[params[s.key]]} min={s.min} max={s.max} step={s.step} aria-label={s.label} disabled={off}
          onPointerDown={() => setInteracting(true)}
          onValueChange={([v]) => setParam(s.key, v)}
          onValueCommit={() => setInteracting(false)} />
        <p className="text-11px text-muted-foreground mt-1.5">padrão {defaults[s.key]}</p>
      </div>
    );
  };

  const fieldStyle = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(141,180,226,0.2)', color: 'rgba(255,255,255,0.8)' };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] items-start">
      <div className="space-y-5 min-w-0">
        {data && run?.ok && <LiveResultBar cmp={cmp} isDefault={isDefault} stale={stale} auto={auto} changedCount={changedCount} />}
        <Section title="Configuração do Backtest" hint="1 ativo e 1 timeframe, roda no navegador e não grava nada no banco">
          {assetsError && assets.length === 0 && (
            <div className="rounded-md p-4" style={{ background: 'rgba(221,154,74,0.06)', border: '1px solid rgba(221,154,74,0.2)' }}>
              <QueryErrorState message="Não foi possível carregar os ativos agora — o seletor abaixo está vazio e 'Executar Backtest' fica desativado até a próxima atualização." onRetry={refetchAssets} />
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Ativo</label>
              <select value={assetId} onChange={e => onAssetChange(e.target.value)}
                className="w-full px-3 py-2 rounded-md text-xs font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={fieldStyle}>
                <option value="">{assetsLoading ? 'Carregando ativos...' : 'Selecione...'}</option>
                {assets.map(a => <option key={a.id} value={a.id}>{a.display_name || a.symbol}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Timeframe</label>
              <div className="flex items-center rounded-md overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
                {QBT_TIMEFRAMES.map((tf, i) => (
                  <button key={tf.id} onClick={() => setTimeframe(tf.id)} aria-pressed={timeframe === tf.id}
                    className="flex-1 px-3 py-2 text-xs font-mono font-semibold transition-all"
                    style={{
                      borderLeft: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.08)',
                      ...(timeframe === tf.id
                        ? { background: 'rgba(141,180,226,0.15)', color: '#8db4e2' }
                        : { background: 'rgba(255,255,255,0.03)', color: 'rgba(255,255,255,0.62)' }),
                    }}>
                    {tf.label}
                  </button>
                ))}
              </div>
              <p className="text-11px text-muted-foreground mt-1">~{approxDays} dias</p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Período (candles)</label>
              <select value={candleCount} onChange={e => setCandleCount(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-md text-xs font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={fieldStyle}>
                {QBT_CANDLE_OPTIONS.map(n => <option key={n} value={n}>{n} candles</option>)}
              </select>
            </div>
          </div>

          <div className="pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Sparkles className="w-3.5 h-3.5" style={{ color: '#e3b45a' }} aria-hidden="true" />
              <span className="text-xs font-semibold" style={{ color: '#e3b45a' }}>Ajuste fino (what-if)</span>
              <span className="text-xs text-muted-foreground">altere para testar cenários sem afetar o scanner</span>
              <span className="text-xs ml-auto" style={{ color: changedCount ? '#dd9a4a' : undefined }}>
                {changedCount ? `${changedCount} diferente${changedCount === 1 ? '' : 's'} do padrão` : 'tudo no padrão'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Simulação simplificada de 1 ativo/1 timeframe por vez — não reproduz a cascata completa
              (múltiplos prazos + SMC) que o scanner real usa. Bom pra explorar rápido, não é o resultado exato do motor de verdade.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {QBT_SLIDERS.filter(s => !s.onlyWhen).map(s => renderSlider(s))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
              {QBT_SWITCHES.map(sw => {
                const differs = params[sw.key] !== defaults[sw.key];
                return (
                  <div key={sw.key} className="rounded-md px-3 py-2 flex items-center gap-3" title={sw.help} style={{ background: 'rgba(255,255,255,0.02)', border: `1px solid ${differs ? 'rgba(221,154,74,0.3)' : 'rgba(255,255,255,0.05)'}` }}>
                    <Switch checked={Boolean(params[sw.key])} onCheckedChange={(v) => setParam(sw.key, v ? 1 : 0)} aria-label={sw.label} />
                    <div className="min-w-0">
                      <div className="text-xs text-muted-foreground">{sw.label}{differs && <span aria-label="diferente do padrão" style={{ color: '#dd9a4a' }}> ●</span>}</div>
                      <p className="text-11px text-muted-foreground">padrão {defaults[sw.key] ? 'ligado' : 'desligado'} (como na produção)</p>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Os dois ajustes do trailing só valem com o interruptor dele ligado; desligado ficam à vista, apagados. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3" aria-label="Ajustes do trailing" style={{ opacity: params.trail ? 1 : 0.45 }}>
              {QBT_SLIDERS.filter(s => s.onlyWhen).map(s => renderSlider(s, !params[s.onlyWhen]))}
            </div>
            {tier && (
              <p className="text-11px text-muted-foreground mt-2">
                Tier do ativo: <span className="text-foreground/80">{tier.tier}</span> (volatilidade ATR% {tier.atrPctSmooth.toFixed(2)}) → o scanner usa stop de {tier.atrStopMult}× ATR, por isso esse é o padrão do Stop.
                {asset?.rf_period != null && ' O RF padrão é o configurado neste ativo.'}
              </p>
            )}
          </div>

          <div className="flex items-center gap-x-4 gap-y-2 pt-1 flex-wrap">
            <button onClick={handleRun} disabled={!asset || dataStatus === 'loading'}
              className="flex items-center gap-2 px-5 py-2.5 rounded-md text-xs font-mono font-semibold transition-all disabled:opacity-40"
              style={{ background: 'rgba(93,181,134,0.1)', border: '1px solid rgba(93,181,134,0.3)', color: '#5db586' }}>
              {dataStatus === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {dataStatus === 'loading' ? 'Buscando candles...' : 'Executar Backtest'}
            </button>
            <button onClick={resetToDefaults} disabled={!changedCount && !stale}
              className="px-3 py-2 rounded-md text-xs font-mono transition-all disabled:opacity-40"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.75)' }}>
              Voltar ao padrão
            </button>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <Switch checked={auto} onCheckedChange={toggleAuto} aria-label="Atualizar o resultado sozinho" />
              Atualizar o resultado sozinho ao mexer
            </label>
            {asset ? (
              <span className="text-xs font-mono text-muted-foreground">{asset.symbol} · {timeframe.toUpperCase()} · {candleCount} candles</span>
            ) : (
              <span className="text-xs text-muted-foreground">Escolha um ativo para executar.</span>
            )}
          </div>

          {stale && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md text-xs" role="status" style={{ background: 'rgba(221,154,74,0.08)', border: '1px solid rgba(221,154,74,0.3)', color: '#dd9a4a' }}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {auto ? 'Recalculando…' : 'Você mexeu nos parâmetros: o resultado abaixo ainda é do teste anterior. Clique em Executar Backtest para atualizar.'}
            </div>
          )}
          {dataStatus === 'error' && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-mono" role="alert" style={{ background: 'rgba(224,106,91,0.1)', border: '1px solid rgba(224,106,91,0.3)', color: '#e06a5b' }}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />Não foi possível buscar os candles: {errorMsg}
              <button onClick={fetchData} className="ml-auto underline underline-offset-2">Tentar de novo</button>
            </div>
          )}
        </Section>

        {!asset && <p className="text-xs text-muted-foreground px-1">O resultado, com a leitura em português, aparece aqui assim que você escolher um ativo — e se atualiza sozinho a cada ajuste.</p>}

        {asset && dataStatus === 'loading' && !data && (
          <div className="flex justify-center py-12" role="status" aria-label="Buscando candles"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        )}

        {data && run && !run.ok && (
          <div className="rounded-md px-4 py-3 text-xs flex items-start gap-2" role="alert" style={{ background: 'rgba(224,106,91,0.08)', border: '1px solid rgba(224,106,91,0.3)', color: '#e06a5b' }}>
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Não foi possível simular: {run.error}. Escolha mais candles ou outro timeframe.</span>
          </div>
        )}

        {data && run?.ok && (
          <>
            <div className="rounded-md px-4 py-2.5 flex items-center gap-x-5 gap-y-1 flex-wrap text-xs" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <span className="font-mono text-foreground/85">{assetSymbol} · {timeframe.toUpperCase()}</span>
              <span className="text-muted-foreground">operando de {moment(run.stats.firstTradableTime).format('DD/MM/YYYY')} a {moment(data.closed[data.closed.length - 1].closeTime).format('DD/MM/YYYY')} · {data.closed.length} candles ({run.stats.startIndex} de aquecimento)</span>
              <DataBadge quality={quality} />
              <span className="text-muted-foreground ml-auto">dados de {moment(data.fetchedAt).format('HH:mm:ss')}</span>
            </div>

            <ComparisonStrip cmp={cmp} isDefault={isDefault} stale={stale} />
            <TrustPanel quality={quality} fidelity={fidelity} />

            <ReportBody report={run.report} hideCascadeTable source="quick" />

            <Section title="Onde o simulador entrou e saiu" hint="o preço com cada operação desenhada">
              <TradesPriceChart points={chart.points} trades={chart.trades} symbol={assetSymbol} />
            </Section>
            <section className="space-y-2">
              <SectionTitle hint="a distribuição do resultado">Como as operações terminaram</SectionTitle>
              <OutcomeAnalysis histogram={rHistogram(run.ops)} exits={exitBreakdown(run.ops)} sides={sideBreakdown(run.ops)} concentration={analysis?.concentration} total={run.ops.length} positiveTotal={(run.summary.expectancyR ?? 0) > 0} />
            </section>
            <section className="space-y-2">
              <SectionTitle hint="o que aconteceu com cada sinal do Range Filter">Por que só {run.ops.length} {run.ops.length === 1 ? 'operação' : 'operações'}?</SectionTitle>
              <SignalFunnel stats={run.stats} />
            </section>
            <section className="space-y-2">
              <SectionTitle hint="este valor é estável ou sorte?">Sensibilidade dos parâmetros</SectionTitle>
              <SensitivityPanel runSummary={runSummary} params={applied} defaults={defaults} dataset={dataset} disabled={stale} />
            </section>
            <SimulatedTradesTable ops={run.ops} />
          </>
        )}
      </div>

      <aside className="lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100vh-5.5rem)] lg:overflow-y-auto min-w-0" aria-label="Histórico de testes">
        <RunHistory ranked={ranked} best={best} currentKey={currentKey} currentRun={currentRun} currentRank={currentRank} sortBy={sortBy} onSort={setSortBy} overfit={overfit} saveFailed={saveFailed}
          reevalCount={reevalTargets.length} onReeval={handleReeval} reevalMsg={reevalMsg} onUse={handleUse} onStar={(k) => setHistory(h => toggleStar(h, k))} onRemove={(k) => setHistory(h => removeRun(h, k))} onClear={() => setHistory([])} />
      </aside>
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

  const { data: allOps = [], isLoading, isError, refetch } = useQuery({
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

  // Sem dado (carregando, ou a carga falhou sem nada): o resumo do período não afirma número nenhum.
  const unknown = isLoading || (isError && allOps.length === 0);
  const presetLabel = PERIOD_PRESETS.find(p => p.id === preset)?.label ?? '';
  const closedInPeriod = filteredOps.filter(isClosedOp).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
        <div className="flex items-center rounded-md overflow-x-auto max-w-full" role="group" aria-label="Período" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          {PERIOD_PRESETS.map((p, i) => (
            <button key={p.id} onClick={() => setPreset(p.id)} aria-pressed={preset === p.id}
              className="text-xs font-mono px-3 py-1.5 transition-all whitespace-nowrap"
              style={{
                borderLeft: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.08)',
                ...(preset === p.id
                  ? { background: 'rgba(141,180,226,0.12)', color: '#8db4e2' }
                  : { background: 'rgba(255,255,255,0.02)', color: 'rgba(255,255,255,0.62)' }),
              }}>
              {p.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {presetLabel}{dateRange ? ` · ${moment(dateRange.from).format('DD/MM')} → ${moment(dateRange.to).format('DD/MM')}` : ''}
          {' · '}<span className="font-mono tabular-nums text-foreground/80">{unknown ? '—' : filteredOps.length}</span> {!unknown && filteredOps.length === 1 ? 'operação' : 'operações'} no período
          {!unknown && filteredOps.length > 0 && <> (<span className="font-mono tabular-nums">{closedInPeriod}</span> {closedInPeriod === 1 ? 'fechada' : 'fechadas'})</>}
        </span>
      </div>

      {!isLoading && allOps.length === REAL_OPS_LIMIT && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-mono" style={{ background: 'rgba(221,154,74,0.1)', border: '1px solid rgba(221,154,74,0.3)', color: '#dd9a4a' }}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Mostrando só as {REAL_OPS_LIMIT} operações mais recentes — pode haver operações mais antigas fora deste limite,
          então períodos longos ("Tudo", "Ano") podem estar incompletos.
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16" role="status" aria-label="Carregando operações"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : isError && allOps.length === 0 ? (
        <div className="rounded-md p-8" style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <QueryErrorState message="Não foi possível carregar as operações reais agora." onRetry={refetch} />
        </div>
      ) : !report ? (
        <div className="rounded-md px-5 py-6 flex flex-wrap items-center gap-x-4 gap-y-3" style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <History className="w-5 h-5 shrink-0 text-muted-foreground opacity-40" aria-hidden="true" />
          <p className="text-muted-foreground text-sm">Nenhuma operação fechada nesse período.</p>
          {preset !== 'all' && (
            <button onClick={() => setPreset('all')} className="ml-auto text-xs font-mono px-2.5 py-1.5 rounded-md transition-all"
              style={{ background: 'rgba(141,180,226,0.08)', border: '1px solid rgba(141,180,226,0.2)', color: '#8db4e2' }}>
              Ver todo o período
            </button>
          )}
        </div>
      ) : (
        <ReportBody report={report} source="real" />
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
    <div className="grid gap-5 lg:grid-cols-2 items-start">
      <TriggerBacktestPanel onReportReady={onLoad} />

      <div className="rounded-md p-5 space-y-4" style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-foreground">Ou carregue um relatório já gerado</h2>
          </div>
          <p className="text-11px font-mono text-muted-foreground">
            Baixe o artifact <code>backtest-report.json</code> de um run anterior do GitHub Actions (aba Actions → Backtest
            → o run desejado), ou rode <code>npm run backtest</code> localmente. Depois, carregue o arquivo ou cole o
            conteúdo abaixo.
          </p>
        </div>

        <button onClick={() => fileRef.current?.click()}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-md text-11px font-mono font-bold transition-all"
          style={{ background: 'rgba(141,180,226,0.08)', border: '1px dashed rgba(141,180,226,0.3)', color: '#8db4e2' }}>
          <Upload className="w-4 h-4" />Selecionar backtest-report.json
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleFile} />

        <div className="text-center text-xs text-muted-foreground">— ou cole o JSON —</div>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="{ &quot;range&quot;: ..., &quot;overall&quot;: ... }"
          rows={5}
          className="w-full rounded-md p-3 text-11px font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}
        />
        <button onClick={() => onLoad(pasted)} disabled={!pasted.trim()}
          className="w-full px-4 py-2 rounded-md text-11px font-mono font-bold transition-all disabled:opacity-40"
          style={{ background: 'rgba(93,181,134,0.08)', border: '1px solid rgba(93,181,134,0.3)', color: '#5db586' }}>
          Analisar relatório colado
        </button>

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md text-11px font-mono" style={{ background: 'rgba(224,106,91,0.1)', border: '1px solid rgba(224,106,91,0.3)', color: '#e06a5b' }}>
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
  const [confirmingApply, setConfirmingApply] = useState(false);
  // Configuração atual do scanner, lida só quando o diálogo "Aplicar" abre — para mostrar O QUE MUDA. null = ainda lendo; 'erro' = não foi possível ler.
  const [liveConfig, setLiveConfig] = useState(null);
  const pineConfig = report?.reproducibility?.pineConfig;
  const trialLabel = report?.trialLabel || 'sem rótulo';

  useEffect(() => {
    if (!confirmingApply) { setLiveConfig(null); return undefined; }
    let cancelled = false;
    getPineConfig().then(cfg => {
      if (cancelled) return;
      // getPineConfig cai nos padrões (ou numa CÓPIA GUARDADA, com degraded:false) se o banco falhar: nesses casos NÃO dá para dizer o que mudaria —
      // a cópia pode estar velha (outro navegador/administrador pode ter mudado a config). Só uma leitura fresca do banco vale (achado do Codex, PR #616).
      setLiveConfig(getPineConfigStatus().source === 'postgres' ? cfg : 'erro');
    }).catch(() => { if (!cancelled) setLiveConfig('erro'); });
    return () => { cancelled = true; };
  }, [confirmingApply]);

  const applyChanges = useMemo(
    () => (liveConfig && liveConfig !== 'erro' ? diffAppliedConfig(pineConfig, liveConfig, SYNCED_STRATEGY_KEYS, PINE_DEFAULTS) : null),
    [pineConfig, liveConfig],
  );

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

  const handleApplyToScanner = () => {
    if (!pineConfig) return;
    setConfirmingApply(true);
  };

  const doApply = async () => {
    setApplyStatus('applying');
    try {
      const payload = {};
      for (const key of SYNCED_STRATEGY_KEYS) {
        // Codex review (PR #197, docs/known-risks.md item 93): StrategyConfig.set
        // merges (setDoc merge:true) — a key simply ABSENT from this payload
        // leaves whatever is already in Firestore untouched. A report generated
        // before a key existed has no entry for it, so skipping it here would
        // let applying that OLD report silently preserve a NEWER flag's live
        // value instead of resetting it to what was actually in effect when
        // that report ran. Fall back to DEFAULTS so "apply" is a full reset.
        payload[key] = pineConfig[key] !== undefined ? pineConfig[key] : PINE_DEFAULTS[key];
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
      <div className="flex items-center justify-between flex-wrap gap-3 rounded-md px-4 py-2.5" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <p className="text-xs font-mono text-muted-foreground">
          {report.trialLabel ? `Trial: ${report.trialLabel} · ` : ''}
          {new Date(report.range.from).toLocaleDateString('pt-BR')} – {new Date(report.range.to).toLocaleDateString('pt-BR')}
          {report.reproducibility?.commitSha && ` · commit ${report.reproducibility.commitSha.slice(0, 7)}`}
        </p>
        <div className="flex items-center gap-2">
          <button onClick={() => setReport(null)}
            className="px-3 py-1.5 rounded-md text-11px font-mono transition-all"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)' }}>
            Carregar outro relatório
          </button>
          {(() => {
            const applyButton = (
              <button onClick={handleApplyToScanner} disabled={!report.reproducibility?.pineConfig || applyStatus === 'applying'}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-md text-11px font-mono font-bold transition-all disabled:opacity-40"
                style={{
                  background: applyStatus === 'applied' ? 'rgba(93,181,134,0.15)' : 'rgba(93,181,134,0.08)',
                  border: '1px solid rgba(93,181,134,0.3)', color: '#5db586',
                }}>
                {applyStatus === 'applying' ? <Loader2 className="w-3 h-3 animate-spin" /> : applyStatus === 'applied' ? <CheckCircle2 className="w-3 h-3" /> : <Rocket className="w-3 h-3" />}
                {applyStatus === 'applying' ? 'Aplicando...' : applyStatus === 'applied' ? 'Aplicado!' : applyStatus === 'error' ? 'Erro' : 'Aplicar ao Scanner'}
              </button>
            );
            if (report.reproducibility?.pineConfig) return applyButton;
            // Botão desabilitado: eventos de mouse não chegam ao <button disabled>
            // nativo, então o Tooltip do Radix nunca dispararia nele direto —
            // precisa de um wrapper focável/hoverável em volta (achado A-6).
            return (
              <InfoTooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-block">{applyButton}</span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                  Relatório sem reproducibility.pineConfig — rode com run-backtest.mjs mais recente
                </TooltipContent>
              </InfoTooltip>
            );
          })()}
        </div>
      </div>
      <ReportBody report={report} source="json" />

      {/* Achado da varredura pós-Raio-X, Round 2 (2026-09-27): confirm()
          nativo quebrava o tema escuro — migrado pro AlertDialog já
          existente e nunca usado. Texto mantido igual (já explicava a
          consequência) — só troca de container. */}
      <AlertDialog open={confirmingApply} onOpenChange={setConfirmingApply}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Aplicar a configuração do trial "${trialLabel}" ao scanner AO VIVO?`}</AlertDialogTitle>
            <AlertDialogDescription>
              Isso grava em strategyConfig/current e afeta o próximo scan real (browser + cron).
            </AlertDialogDescription>
            <div className="text-xs text-foreground/80 space-y-1" aria-live="polite">
              {liveConfig === 'erro' ? (
                <p style={{ color: '#dd9a4a' }}>Não foi possível ler a configuração atual para comparar — confira antes de aplicar.</p>
              ) : liveConfig === null ? (
                <p className="text-muted-foreground">Comparando com a configuração atual…</p>
              ) : applyChanges && applyChanges.length === 0 ? (
                <p>Nenhum parâmetro muda: a configuração atual já é igual à deste trial.</p>
              ) : applyChanges ? (
                <>
                  <p className="font-medium">{applyChanges.length} parâmetro{applyChanges.length === 1 ? '' : 's'} {applyChanges.length === 1 ? 'muda' : 'mudam'}:</p>
                  <ul className="font-mono space-y-0.5">
                    {applyChanges.slice(0, 12).map(c => <li key={c.key}>{c.key}: <span className="text-muted-foreground">{String(c.from)}</span> → <span style={{ color: '#dd9a4a' }}>{String(c.to)}</span></li>)}
                  </ul>
                  {applyChanges.length > 12 && <p className="text-muted-foreground">e mais {applyChanges.length - 12}.</p>}
                </>
              ) : null}
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={doApply}>Aplicar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const TABS = [
  { id: 'real', label: 'Desempenho Real', icon: History, note: 'Operações do próprio painel (virtuais), filtradas por período. Nada é simulado aqui.' },
  { id: 'quick', label: 'Ajuste Fino (What-If)', icon: Sparkles, note: 'Simulação simplificada no navegador, de 1 ativo e 1 timeframe. Não grava nada e não afeta o scanner.' },
  { id: 'json', label: 'Simulação (GitHub)', icon: Zap, note: 'Replay completo do motor (as duas cascatas) rodado no GitHub Actions, ou um relatório já gerado.' },
];

export default function Backtest() {
  const [tab, setTab] = useState('real');
  const current = TABS.find(t => t.id === tab);

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div>
        <p className="text-xs text-muted-foreground mb-1">Estratégia</p>
        <h1 className="text-2xl font-semibold text-foreground tracking-tight">Backtest</h1>
      </div>

      <div className="space-y-2">
        <div className="flex items-center rounded-md overflow-hidden w-full sm:w-fit" role="tablist" aria-label="Tipos de backtest" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          {TABS.map((t, i) => (
            <button key={t.id} onClick={() => setTab(t.id)} role="tab" aria-selected={tab === t.id}
              className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 text-11px sm:text-xs font-mono px-2 sm:px-4 py-2 transition-all whitespace-normal sm:whitespace-nowrap focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              style={{
                borderLeft: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.08)',
                ...(tab === t.id
                  ? { background: 'rgba(141,180,226,0.12)', color: '#8db4e2' }
                  : { background: 'rgba(255,255,255,0.02)', color: 'rgba(255,255,255,0.62)' }),
              }}>
              <t.icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />{t.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground px-1">{current.note}</p>
      </div>

      {tab === 'real' && <RealPeriodTab />}
      {tab === 'quick' && <QuickBacktestTab />}
      {tab === 'json' && <JsonReportTab />}
    </div>
  );
}
