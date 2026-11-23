import TokenIcon from '@/components/TokenIcon';
import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { Download, TrendingUp, TrendingDown, Calendar, Loader2, Copy, Check, ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle, AlertCircle, HelpCircle, RefreshCw } from 'lucide-react';
import moment from 'moment';
import {
  ComposedChart, Bar, Line, ReferenceLine, Cell,
  ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { isClosedOp, getExitPrice, getClosedAt, calcRealizedPnlPct, classifyOutcome, summarizeOps } from '@/lib/tradeMetrics';
import { outcomeColor } from '@/lib/outcomeColor';
import { MetricSummaryCard } from '@/components/MetricSummaryCard';
import { SectionTitle, Panel, PANEL_STYLE, GREEN, RED, AMBER, BLUE, TOOLTIP_STYLE, AXIS_TICK } from '@/components/backtest/whatif/ui';
import { winRateColor, profitFactorColor, profitFactorLabel, drawdownColor } from '@/lib/metricColorRanges';
import { formatPrice } from '@/lib/priceProximity';
import { POLL_DIAGNOSTIC_MS } from '@/lib/pollingIntervals';
import { useCopyToClipboard, formatTradeOpLine } from '@/lib/clipboardText';
import { analyzeMonth, explainMonth, compareMonths, costModelText, fmtPct, fmtR, fmtDuration, opDurationMs } from '@/lib/monthlyInsights';

const STATUS_LABELS = {
  TP2_HIT: '🏆 TP2',
  STOP_HIT: '🛑 Stop',
  INVALIDATED: '⚠ Invalidado',
  CLOSED: '✖ Encerrado',
};

// Operação "CLOSED" tem um motivo gravado (closed_reason). Sem isso, Time Stop, Chop Exit, TP1 de 100% e fechamento à mão apareciam todos como
// "Encerrado" — e quem lê o mês não sabia por que a operação saiu. Só os motivos que o motor realmente grava; motivo desconhecido volta ao rótulo geral.
const CLOSED_REASON_LABELS = {
  TIME_STOP: '⏱ Time stop',
  CHOP_EXIT: 'Chop exit', // sem glifo de propósito: 〰 é proibido no painel (panelVocabularyGuard)
  TP1_FULL: '🎯 TP1 (saída total)',
};

// STOP_HIT sozinho não diz se foi lucro protegido (trailing pré-TP1 levou o
// stop positivo antes de reverter) ou prejuízo real. classifyOutcome (fonte
// única, tradeMetrics.js) já resolve isso pelo R/PnL realizado — mesmo
// padrão que TradeHistory.jsx já usa pra BE, estendido aqui pra também
// cobrir WIN. TP2_HIT/INVALIDATED continuam fixos — só STOP_HIT é ambíguo.
function statusLabel(op) {
  if (op.status === 'STOP_HIT') {
    const outcome = classifyOutcome(op);
    if (outcome === 'WIN') return '💰 Stop (lucro)';
    if (outcome === 'BE') return '🟡 Stop (BE)';
  }
  if (op.status === 'CLOSED' && CLOSED_REASON_LABELS[op.closed_reason]) return CLOSED_REASON_LABELS[op.closed_reason];
  return STATUS_LABELS[op.status] || op.status;
}

// A cor por status é uma chamada direta a outcomeColor (src/lib/outcomeColor.js).
function statusColor(op) {
  return outcomeColor(op.status, classifyOutcome(op));
}

const OUTCOME_FILTERS = [
  { key: 'all', label: 'Todas' },
  { key: 'WIN', label: 'Ganhos' },
  { key: 'LOSS', label: 'Perdas' },
  { key: 'BE', label: 'Empates' },
];
const TONE_STYLE = {
  positive: { icon: CheckCircle2, color: GREEN, bg: 'rgba(93,181,134,0.07)', border: 'rgba(93,181,134,0.25)' },
  negative: { icon: AlertCircle, color: RED, bg: 'rgba(224,106,91,0.07)', border: 'rgba(224,106,91,0.28)' },
  neutral: { icon: AlertTriangle, color: AMBER, bg: 'rgba(221,154,74,0.07)', border: 'rgba(221,154,74,0.28)' },
  unknown: { icon: HelpCircle, color: 'rgba(255,255,255,0.6)', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.1)' },
};
const TABLE_LIMIT = 15;

// Nome do mês em português ("novembro de 2026"). O moment deste projeto não tem locale carregado (saía "November De 2026"), então usa o Intl do navegador.
// `cap` põe a 1ª letra em maiúscula (lista do seletor e títulos do PDF/Copiar); no meio de uma frase fica em minúscula.
function monthName(key, { cap = false } = {}) {
  const [y, m] = key.split('-').map(Number);
  const txt = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return cap ? txt.charAt(0).toUpperCase() + txt.slice(1) : txt;
}
const monthOnly = (key) => new Date(Number(key.slice(0, 4)), Number(key.slice(5)) - 1, 1).toLocaleDateString('pt-BR', { month: 'long' });
const ASSET_LIMIT = 6;

// Barra empilhada (no lugar das duas pizzas): cada fatia tem largura proporcional à contagem; a legenda escreve o número e a porcentagem.
// O texto de cada item da legenda é UMA string só ("nome · n (x%)") para o nome não se repetir como texto solto na tela.
function StackedBar({ items, ariaLabel }) {
  const total = items.reduce((s, d) => s + d.value, 0);
  return (
    <div>
      <div className="flex h-3 rounded-sm overflow-hidden gap-px" role="img" aria-label={ariaLabel}>
        {items.map((d) => <div key={d.name} style={{ flexGrow: d.value, background: d.color, minWidth: 3 }} />)}
      </div>
      <ul className="mt-2 space-y-1">
        {items.map((d) => (
          <li key={d.name} className="flex items-center gap-2 text-xs text-foreground/80">
            <i aria-hidden="true" style={{ width: 8, height: 8, background: d.color, display: 'inline-block', borderRadius: 2 }} />
            <span>{`${d.name} · ${d.value} (${total > 0 ? Math.round((d.value / total) * 100) : 0}%)`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Barra divergente do resultado de cada grupo: cresce para a direita (ganho) ou esquerda (perda) a partir do meio, na mesma escala entre as linhas.
function DivergingBar({ value, max }) {
  const w = max > 0 ? Math.min(50, (Math.abs(value) / max) * 50) : 0;
  return (
    <div className="relative h-2 rounded-sm" style={{ background: 'rgba(255,255,255,0.05)' }} aria-hidden="true">
      <span style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: 'rgba(255,255,255,0.2)' }} />
      <span style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 2, background: value >= 0 ? GREEN : RED, width: `${w}%`, ...(value >= 0 ? { left: '50%' } : { right: '50%' }) }} />
    </div>
  );
}

export default function MonthlyReport() {
  const [selectedMonth, setSelectedMonth] = useState(moment().format('YYYY-MM'));
  const [exporting, setExporting] = useState(false);
  const [outcomeFilter, setOutcomeFilter] = useState('all');
  const [showAllRows, setShowAllRows] = useState(false);
  const [showAllAssets, setShowAllAssets] = useState(false);

  // Busca por INTERVALO do mês selecionado (known-risks item 141) —
  // antes buscava as 500 operações mais recentes (todo status, sem filtro
  // de data) e filtrava o mês no cliente; com o histórico total passando de
  // 500, qualquer mês mais antigo que a 500ª operação mais recente nunca
  // era buscado e aparecia como "nenhuma operação" mesmo tendo havido.
  // queryKey inclui selectedMonth de propósito — a query em si agora
  // depende do mês, então trocar de mês precisa refazer o fetch.
  const fetchMonth = (month) => {
    const start = moment(month, 'YYYY-MM').startOf('month');
    const end = start.clone().add(1, 'month');
    return backend.entities.TradeOperation.filter(
      { created_date: { gte: start.toISOString(), lt: end.toISOString() } },
      '-created_date',
    );
  };
  const { data: operations = [], isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['monthly-report-ops', selectedMonth],
    queryFn: () => fetchMonth(selectedMonth),
    refetchInterval: POLL_DIAGNOSTIC_MS,
  });
  // Mês anterior: só para a comparação "este mês × anterior". Se falhar, a comparação some — o resto da tela não depende dela.
  const prevMonth = useMemo(() => moment(selectedMonth, 'YYYY-MM').subtract(1, 'month').format('YYYY-MM'), [selectedMonth]);
  const { data: prevOperations, isLoading: prevLoading, isError: prevError } = useQuery({
    queryKey: ['monthly-report-ops', prevMonth],
    queryFn: () => fetchMonth(prevMonth),
    refetchInterval: POLL_DIAGNOSTIC_MS,
  });

  const monthOps = useMemo(() => {
    return operations
      .filter(isClosedOp)
      .sort((a, b) => new Date(a.created_date).getTime() - new Date(b.created_date).getTime());
  }, [operations]);
  const openCount = operations.length - monthOps.length;
  const isPartialMonth = selectedMonth === moment().format('YYYY-MM');

  const metrics = useMemo(() => {
    if (monthOps.length === 0) return null;
    const s = summarizeOps(monthOps);
    const pnls = s.curve.map(p => p.pnlPct).filter(p => p !== null);
    return {
      totalPnl: s.totalPnlPct,
      winRate: s.winRate,
      totalTrades: monthOps.length,
      wins: s.wins,
      losses: s.losses,
      be: s.be,
      bestTrade: pnls.length > 0 ? Math.max(...pnls) : 0,
      worstTrade: pnls.length > 0 ? Math.min(...pnls) : 0,
      profitFactor: s.profitFactor,
      avgWin: s.avgWinPct,
      avgLoss: s.avgLossPct,
    };
  }, [monthOps]);

  // Leitura do mês (src/lib/monthlyInsights.js — mesmos números do summarizeOps, só agrupados e explicados).
  const analysis = useMemo(() => (monthOps.length > 0 ? analyzeMonth(monthOps) : null), [monthOps]);
  const verdict = useMemo(() => (analysis ? explainMonth(analysis, { partial: isPartialMonth, openCount }) : null), [analysis, isPartialMonth, openCount]);
  const prevAnalysis = useMemo(() => {
    const closed = (prevOperations ?? []).filter(isClosedOp);
    return closed.length > 0 ? analyzeMonth(closed) : null;
  }, [prevOperations]);
  const comparison = useMemo(() => compareMonths(analysis, prevAnalysis), [analysis, prevAnalysis]);

  const dailyPnlData = useMemo(() => {
    if (monthOps.length === 0) return [];
    // Chave ordenável (YYYY-MM-DD) — monthOps está ordenado por created_date,
    // não por data de fechamento, então inserir no Map na ordem de iteração
    // não garante ordem cronológica de fechamento (uma op aberta antes pode
    // fechar depois de uma aberta mais tarde). Ordenar pela chave antes de
    // acumular é o que mantém a curva e o P&L diário na ordem certa.
    const byDay = new Map();
    for (const op of monthOps) {
      const closedAt = getClosedAt(op) || op.created_date;
      const dayKey = moment(closedAt).format('YYYY-MM-DD');
      const pnl = calcRealizedPnlPct(op) || 0;
      byDay.set(dayKey, (byDay.get(dayKey) || 0) + pnl);
    }
    let cumulative = 0;
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dayKey, pnlPct]) => {
        cumulative += pnlPct;
        return { day: moment(dayKey).format('DD/MM'), pnlPct: +pnlPct.toFixed(2), cumulativePct: +cumulative.toFixed(2) };
      });
  }, [monthOps]);

  // "Como terminaram": por rótulo que o usuário LÊ na tabela (Stop de lucro, Stop de empate e Stop de perda são coisas diferentes).
  const statusDistribution = useMemo(() => {
    if (monthOps.length === 0) return [];
    const groups = new Map();
    for (const op of monthOps) {
      const name = statusLabel(op);
      const g = groups.get(name) ?? { name, value: 0, color: statusColor(op) };
      g.value += 1;
      groups.set(name, g);
    }
    return [...groups.values()].sort((a, b) => b.value - a.value);
  }, [monthOps]);

  const outcomePie = useMemo(() => {
    if (!metrics) return [];
    return [
      { name: 'Vitórias', value: metrics.wins, color: GREEN },
      { name: 'Derrotas', value: metrics.losses, color: RED },
      { name: 'Empate (BE)', value: metrics.be, color: '#64748b' },
    ].filter(d => d.value > 0);
  }, [metrics]);

  const monthOptions = useMemo(() => {
    const months = [];
    for (let i = 0; i < 12; i++) {
      const m = moment().subtract(i, 'months');
      months.push({ value: m.format('YYYY-MM'), label: monthName(m.format('YYYY-MM'), { cap: true }) });
    }
    return months;
  }, []);
  const monthIdx = monthOptions.findIndex(m => m.value === selectedMonth);
  const monthLabel = monthName(selectedMonth);
  const prevMonthLabel = monthOnly(prevMonth);

  // Tabela: filtro por resultado + "mostrar todas". O resultado vem do MESMO classifyOutcome do resto do painel.
  const rowOutcome = useMemo(() => new Map(monthOps.map(op => [op.id, classifyOutcome(op)])), [monthOps]);
  const outcomeCounts = useMemo(() => {
    const c = { all: monthOps.length, WIN: 0, LOSS: 0, BE: 0 };
    for (const op of monthOps) { const o = rowOutcome.get(op.id); if (o in c) c[o] += 1; }
    return c;
  }, [monthOps, rowOutcome]);
  const filteredOps = useMemo(
    () => (outcomeFilter === 'all' ? monthOps : monthOps.filter(op => rowOutcome.get(op.id) === outcomeFilter)),
    [monthOps, outcomeFilter, rowOutcome],
  );
  const shownOps = showAllRows ? filteredOps : filteredOps.slice(0, TABLE_LIMIT);

  const handleExportPDF = async () => {
    if (!metrics || monthOps.length === 0) return;
    setExporting(true);
    try {
      // docs/roadmap.md Bloco 5 (bundle >500kB) — jsPDF só é necessário
      // aqui, na exportação; import dinâmico tira a lib inteira do chunk
      // principal, sem mudar nenhum comportamento (mesma chamada, só depois
      // do módulo carregar).
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      let y = 20;

      // Title
      doc.setFontSize(18);
      doc.setTextColor(40, 40, 40);
      doc.text('Relatório Mensal de Operações', pageWidth / 2, y, { align: 'center' });
      y += 8;
      doc.setFontSize(11);
      doc.setTextColor(100, 100, 100);
      const monthLabel = monthName(selectedMonth, { cap: true });
      doc.text(monthLabel, pageWidth / 2, y, { align: 'center' });
      y += 5;
      doc.setFontSize(8);
      doc.text(`Gerado em: ${moment().format('DD/MM/YYYY HH:mm')}`, pageWidth / 2, y, { align: 'center' });
      y += 10;

      // Summary
      doc.setDrawColor(200, 200, 200);
      doc.setFillColor(248, 249, 252);
      doc.roundedRect(14, y, pageWidth - 28, 45, 3, 3, 'FD');
      y += 8;
      doc.setFontSize(9);

      const summaryItems = [
        { label: 'P&L Acumulado:', value: fmtPct(metrics.totalPnl), color: metrics.totalPnl >= 0 ? [0, 128, 0] : [200, 0, 50] },
        { label: 'Taxa de Acerto:', value: `${metrics.winRate.toFixed(1)}%`, color: [0, 100, 200] },
        { label: 'Total de Trades:', value: `${metrics.totalTrades}`, color: [60, 60, 60] },
        { label: 'Vitórias / BE / Derrotas:', value: `${metrics.wins} / ${metrics.be} / ${metrics.losses}`, color: [60, 60, 60] },
        { label: 'Melhor Trade:', value: fmtPct(metrics.bestTrade), color: [0, 128, 0] },
        { label: 'Pior Trade:', value: fmtPct(metrics.worstTrade), color: [200, 0, 50] },
        { label: 'Profit Factor:', value: metrics.profitFactor === null ? '∞' : metrics.profitFactor.toFixed(2), color: [60, 60, 60] },
        { label: 'Ganho Médio:', value: fmtPct(metrics.avgWin), color: [0, 128, 0] },
        { label: 'Perda Média:', value: fmtPct(-metrics.avgLoss), color: [200, 0, 50] },
      ];

      let col1Y = y, col2Y = y;
      summaryItems.forEach((item, i) => {
        const col = i % 2;
        const xPos = col === 0 ? 20 : pageWidth / 2 + 5;
        const yPos = col === 0 ? col1Y : col2Y;
        doc.setTextColor(120, 120, 120);
        doc.setFont(undefined, 'normal');
        doc.text(item.label, xPos, yPos);
        doc.setTextColor(item.color[0], item.color[1], item.color[2]);
        doc.setFont(undefined, 'bold');
        doc.text(item.value, xPos + 45, yPos);
        if (col === 0) col1Y += 7; else col2Y += 7;
      });

      y = Math.max(col1Y, col2Y) + 8;

      // Trade table
      doc.setFontSize(12);
      doc.setTextColor(40, 40, 40);
      doc.setFont(undefined, 'bold');
      doc.text('Detalhamento de Operações', 14, y);
      y += 5;

      // Header
      doc.setFillColor(230, 235, 245);
      doc.rect(14, y - 4, pageWidth - 28, 7, 'F');
      doc.setFontSize(8);
      doc.setTextColor(60, 60, 60);
      const colWidths = [28, 32, 18, 28, 28, 22, 28];
      const headers = ['Data', 'Símbolo', 'Side', 'Entrada', 'Saída', 'P&L%', 'Status'];
      let xPos = 16;
      headers.forEach((h, i) => { doc.text(h, xPos, y); xPos += colWidths[i]; });
      y += 5;
      doc.setFont(undefined, 'normal');
      doc.setFontSize(7);

      monthOps.forEach((op, idx) => {
        if (y > 280) { doc.addPage(); y = 20; }
        const pnl = calcRealizedPnlPct(op);
        const exitPrice = getExitPrice(op);
        if (idx % 2 === 0) {
          doc.setFillColor(248, 249, 252);
          doc.rect(14, y - 3, pageWidth - 28, 6, 'F');
        }
        const rowData = [
          moment(op.created_date).format('DD/MM HH:mm'),
          op.symbol?.replace('USDT', '') || '—',
          op.side || '—',
          `$${formatPrice(op.entry_price)}`,
          exitPrice ? `$${formatPrice(exitPrice)}` : '—',
          pnl !== null ? fmtPct(pnl) : '—',
          statusLabel(op).replace(/[^\x20-\x7E]/g, ''),
        ];
        xPos = 16;
        rowData.forEach((val, i) => {
          if (i === 5 && pnl !== null) {
            doc.setTextColor(pnl >= 0 ? 0 : 200, pnl >= 0 ? 128 : 0, pnl >= 0 ? 0 : 50);
          } else {
            doc.setTextColor(60, 60, 60);
          }
          doc.text(val, xPos, y);
          xPos += colWidths[i];
        });
        y += 6;
      });

      // Footer
      const totalPages = doc.internal.pages.length - 1;
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(7);
        doc.setTextColor(150, 150, 150);
        doc.text(`Sentinel Signals — Página ${i} de ${totalPages}`, pageWidth / 2, 290, { align: 'center' });
      }

      doc.save(`relatorio-mensal-${selectedMonth}.pdf`);
    } catch (err) {
      console.error('PDF export error:', err);
    } finally {
      setExporting(false);
    }
  };

  // Reaproveita os MESMOS metrics/monthOps que já alimentam o PDF acima —
  // texto plano em vez de arquivo, pra colar direto numa conversa (pedido
  // do usuário). PDF continua existindo, isto é adicional.
  const { copied, copy } = useCopyToClipboard();
  const handleCopyText = () => {
    if (!metrics || monthOps.length === 0) return;
    const monthLabel = monthName(selectedMonth, { cap: true });
    const header = `Relatório Mensal — ${monthLabel}\n` +
      `P&L ${fmtPct(metrics.totalPnl)} · WR ${metrics.winRate.toFixed(1)}% ` +
      `(${metrics.wins}W/${metrics.be}BE/${metrics.losses}L) · ` +
      `PF ${metrics.profitFactor === null ? '∞' : metrics.profitFactor.toFixed(2)}\n`;
    const lines = monthOps.map(op => formatTradeOpLine(op, { getExitPrice, calcRealizedPnlPct, classifyOutcome, formatPrice, moment }));
    copy([header, ...lines].join('\n'));
  };

  // Contagens e números só afirmam depois de carregar: enquanto carrega (ou se a carga falhou sem dado) mostram "—", nunca "0".
  const unknownData = isLoading || (isError && operations.length === 0);
  const dash = (v) => (unknownData || !analysis ? '—' : v);
  const vStyle = unknownData ? TONE_STYLE.unknown : (verdict ? TONE_STYLE[verdict.tone] : TONE_STYLE.unknown);
  const VIcon = isLoading ? Loader2 : vStyle.icon;
  const hasMonthData = !unknownData && analysis;
  const maxAssetAbs = analysis ? Math.max(0, ...analysis.byAsset.map(g => Math.abs(g.pnl))) : 0;
  const shownAssets = analysis ? (showAllAssets ? analysis.byAsset : analysis.byAsset.slice(0, ASSET_LIMIT)) : [];
  const maxSideAbs = analysis ? Math.max(0, ...analysis.bySide.map(g => Math.abs(g.pnl))) : 0;
  const SIDE_NAME = { BUY: 'Compras (BUY)', SELL: 'Vendas (SELL)' };

  const pf = analysis?.profitFactor ?? null;
  const hasWins = (analysis?.wins ?? 0) > 0;

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-muted-foreground mb-1">Relatórios</p>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Resumo Mensal</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Operações <span className="text-foreground/80">abertas em {monthLabel}</span> que já fecharam{isPartialMonth && <span style={{ color: AMBER }}> · mês em andamento</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center rounded-md overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
            <button onClick={() => setSelectedMonth(monthOptions[monthIdx + 1].value)} disabled={monthIdx < 0 || monthIdx >= monthOptions.length - 1}
              aria-label="Mês anterior" className="px-2 py-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              style={{ background: 'rgba(255,255,255,0.03)' }}>
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <label className="flex items-center gap-2 px-2" style={{ borderLeft: '1px solid rgba(255,255,255,0.08)', borderRight: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)' }}>
              <Calendar className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Mês</span>
              <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
                className="py-1.5 text-11px font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring bg-transparent"
                style={{ color: 'rgba(255,255,255,0.75)' }}>
                {monthOptions.map(m => <option key={m.value} value={m.value} style={{ background: '#181715' }}>{m.label}</option>)}
              </select>
            </label>
            <button onClick={() => setSelectedMonth(monthOptions[monthIdx - 1].value)} disabled={monthIdx <= 0}
              aria-label="Próximo mês" className="px-2 py-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              style={{ background: 'rgba(255,255,255,0.03)' }}>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <button onClick={handleCopyText} disabled={!metrics || monthOps.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-11px font-mono transition-all disabled:opacity-40"
            style={copied
              ? { background: 'rgba(93,181,134,0.08)', border: '1px solid rgba(93,181,134,0.25)', color: GREEN }
              : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)' }}>
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copiado!' : 'Copiar'}
          </button>
          <button onClick={handleExportPDF} disabled={exporting || !metrics || monthOps.length === 0}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-md text-11px font-mono font-bold transition-all hover:opacity-90 disabled:opacity-40"
            style={{ background: 'rgba(141,180,226,0.12)', border: '1px solid rgba(141,180,226,0.3)', color: BLUE }}>
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Exportar PDF
          </button>
        </div>
      </div>

      {/* Leitura do mês: a resposta em palavras antes de qualquer número solto. */}
      <div role="status" aria-label="Leitura do mês" className="rounded-md px-4 py-3 flex items-start gap-3" style={{ background: vStyle.bg, border: `1px solid ${vStyle.border}` }}>
        <VIcon className={`w-5 h-5 shrink-0 mt-0.5 ${isLoading ? 'animate-spin' : ''}`} style={{ color: vStyle.color }} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <>
              <p className="text-sm font-semibold text-foreground/80">Lendo as operações do mês…</p>
              <p className="text-xs text-muted-foreground mt-0.5">Aguarde um instante.</p>
            </>
          ) : unknownData ? (
            <>
              <p className="text-sm font-semibold text-foreground/80">Não foi possível ler as operações deste mês</p>
              <p className="text-xs text-muted-foreground mt-0.5">Por isso o relatório não afirma nada sobre {monthLabel}.</p>
              <button onClick={() => refetch()} className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-11px font-mono rounded-md border border-white/10 hover:bg-white/5 text-muted-foreground">
                <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />Tentar de novo
              </button>
            </>
          ) : !analysis ? (
            <>
              <p className="text-sm font-semibold text-foreground/80">Nenhuma operação fechada em {monthLabel}</p>
              <p className="text-xs text-foreground/75 mt-0.5">
                {openCount > 0
                  ? `${openCount} ${openCount === 1 ? 'operação aberta neste mês ainda não fechou' : 'operações abertas neste mês ainda não fecharam'}; o relatório só conta o que já fechou.`
                  : isPartialMonth ? 'O mês está em andamento — as operações entram aqui quando fecharem.' : 'Selecione outro mês ou aguarde novas operações serem encerradas.'}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold" style={{ color: vStyle.color }}>{verdict.headline}</p>
              {verdict.lines.length > 0 && (
                <ul className="text-xs text-foreground/80 mt-1.5 space-y-1 list-disc pl-4">
                  {verdict.lines.map(l => <li key={l}>{l}</li>)}
                </ul>
              )}
              {verdict.note && <p className="text-11px text-muted-foreground mt-2">{verdict.note}</p>}
            </>
          )}
        </div>
      </div>

      {/* Números do mês: cartões planos, cada número uma vez só. Mês carregado e vazio: não há número para mostrar, então os cartões saem. */}
      {(unknownData || analysis) && <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <MetricSummaryCard flat label="P&L acumulado" value={dash(fmtPct(analysis?.totalPnl))}
          sublabel={hasMonthData ? `${analysis.wins} ganhos · ${analysis.be} empates · ${analysis.losses} perdas` : undefined}
          color={hasMonthData ? (analysis.totalPnl >= 0 ? GREEN : RED) : undefined}
          tooltip="Soma simples do resultado de cada operação fechada, em % do preço de entrada, já com taxa, slippage e funding descontados. Não considera tamanho de posição nem juros compostos." />
        <MetricSummaryCard flat label="Taxa de acerto" value={dash(`${(analysis?.winRate ?? 0).toFixed(1)}%`)}
          sublabel={hasMonthData ? `${analysis.wins} de ${analysis.counted} operações` : undefined}
          color={hasMonthData ? winRateColor(analysis.winRate) : undefined}
          tooltip="Ganhos ÷ operações contadas. Empates (saída perto da entrada) contam na base, mas não são ganho. Sozinha não diz nada: 40% de acerto com ganhos grandes pode ser melhor que 70% com ganhos pequenos." />
        <MetricSummaryCard flat label="Operações" value={unknownData ? '—' : String(analysis?.n ?? 0)}
          sublabel={unknownData ? undefined : isPartialMonth ? 'fechadas até agora' : 'fechadas no mês'} />
        <MetricSummaryCard flat label="Profit Factor" value={dash(pf === null ? (hasWins ? '∞' : '—') : pf.toFixed(2))}
          sublabel={hasMonthData ? profitFactorLabel(pf, hasWins) : undefined}
          color={hasMonthData ? profitFactorColor(pf, hasWins) : undefined}
          tooltip="Soma dos ganhos ÷ soma das perdas (valor absoluto). Acima de 1 = ganhos superam perdas no total; ≥ 1,5 é o piso considerado saudável aqui. '∞' quando não houve nenhuma perda no mês." />
        <MetricSummaryCard flat label="Pior trecho" value={dash(`${(analysis?.maxDrawdownPct ?? 0).toFixed(2)}%`)}
          sublabel={hasMonthData ? 'do pico ao fundo' : undefined}
          color={hasMonthData ? drawdownColor(analysis.maxDrawdownPct) : undefined}
          tooltip="Maior queda do acumulado do mês, do ponto mais alto ao mais baixo depois dele, na ordem em que as operações fecharam. Mostra o quanto o mês doeu no pior momento, mesmo que tenha terminado positivo." />
        <MetricSummaryCard flat label="Média por operação" value={dash(fmtR(analysis?.expectancyR))}
          sublabel={hasMonthData && analysis.ci95 ? `margem de erro ${fmtR(analysis.ci95[0])} a ${fmtR(analysis.ci95[1])}` : hasMonthData ? 'sem margem de erro' : undefined}
          color={hasMonthData && analysis.expectancyR !== null ? (analysis.expectancyR >= 0 ? GREEN : RED) : undefined}
          tooltip="Resultado médio por operação medido em R (1R = o risco do stop inicial). A margem de erro (95%) mostra o quanto essa média poderia variar só por sorte; se ela cruza o zero, o mês não prova vantagem nem prejuízo." />
      </div>}

      {hasMonthData && (
        <>
          {/* Extremos: uma linha só (eram 4 caixinhas). */}
          <div className="rounded-md px-4 py-2.5 flex flex-wrap items-center gap-x-8 gap-y-1.5" style={PANEL_STYLE}>
            {[
              { label: 'Melhor operação', value: fmtPct(analysis.bestPct), color: GREEN, sub: analysis.bestTrade?.op.symbol?.replace('USDT', '') },
              { label: 'Pior operação', value: fmtPct(analysis.worstPct), color: RED, sub: analysis.worstTrade?.op.symbol?.replace('USDT', '') },
              { label: 'Ganho médio', value: fmtPct(analysis.wins > 0 ? analysis.avgWinPct : null), color: GREEN },
              { label: 'Perda média', value: fmtPct(analysis.losses > 0 ? -analysis.avgLossPct : null), color: RED },
              { label: 'Tempo médio aberta', value: analysis.avgDurationMs !== null ? fmtDuration(analysis.avgDurationMs) : '—', color: 'rgba(255,255,255,0.8)' },
            ].map(({ label, value, color, sub }) => (
              <div key={label} className="flex items-baseline gap-2">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="text-sm font-mono font-medium tabular-nums" style={{ color }}>{value}</span>
                {sub && <span className="text-11px text-muted-foreground">{sub}</span>}
              </div>
            ))}
          </div>

          {/* Evolução + como terminaram */}
          <div className="grid gap-5 lg:grid-cols-5">
            <section className="min-w-0 lg:col-span-3 space-y-2" aria-label="Evolução do mês">
              <SectionTitle hint="barras = resultado de cada dia · linha = acumulado">Evolução de P&L (acumulado + diário)</SectionTitle>
              <Panel>
                <div style={{ height: 240 }} role="img"
                  aria-label={`Gráfico combinado de barras e linha da evolução de P&L diário e acumulado no mês: ${dailyPnlData.map(d => `${d.day} ${fmtPct(d.pnlPct)} no dia, ${fmtPct(d.cumulativePct)} acumulado`).join('; ')}`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={dailyPnlData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="day" tick={AXIS_TICK} />
                      <YAxis tick={AXIS_TICK} tickFormatter={(v) => `${v}%`} width={48} />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(value, name) => [`${value}%`, name === 'pnlPct' ? 'P&L do dia' : 'Acumulado']}
                      />
                      <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'monospace' }} />
                      <Bar dataKey="pnlPct" name="P&L do dia" radius={[3, 3, 0, 0]}>
                        {dailyPnlData.map((d, i) => <Cell key={i} fill={d.pnlPct >= 0 ? GREEN : RED} />)}
                      </Bar>
                      <Line type="monotone" dataKey="cumulativePct" name="Acumulado" stroke={BLUE} strokeWidth={2} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-11px text-muted-foreground mt-2">Cada operação entra no dia em que fechou, não no dia em que abriu.</p>
              </Panel>
            </section>

            <section className="min-w-0 lg:col-span-2 space-y-2" aria-label="Como terminaram">
              <SectionTitle hint="o que aconteceu com cada operação">Como terminaram</SectionTitle>
              <Panel className="space-y-4">
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Resultado</p>
                  <StackedBar items={outcomePie}
                    ariaLabel={`Barra empilhada da taxa de acerto do mês: ${outcomePie.map(d => `${d.name} ${d.value}`).join(', ')}`} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Saída</p>
                  <StackedBar items={statusDistribution}
                    ariaLabel={`Barra empilhada da distribuição de status das operações fechadas no mês: ${statusDistribution.map(d => `${d.name} ${d.value}`).join(', ')}`} />
                </div>
              </Panel>
            </section>
          </div>

          {/* De onde veio o resultado + mês × mês anterior */}
          <div className="grid gap-5 lg:grid-cols-5">
            <section className="min-w-0 lg:col-span-3 space-y-2" aria-label="De onde veio o resultado">
              <SectionTitle hint="soma por ativo e por lado — fecha com o resultado do mês">De onde veio o resultado</SectionTitle>
              <Panel className="space-y-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground text-left">
                        <th className="font-medium pb-1.5 pr-3">Ativo</th>
                        <th className="font-medium pb-1.5 pr-3 text-right"><span className="sm:hidden">Ops</span><span className="hidden sm:inline">Operações</span></th>
                        <th className="font-medium pb-1.5 pr-3 text-right">Acerto</th>
                        <th className="font-medium pb-1.5 pr-3 text-right">Resultado</th>
                        <th className="font-medium pb-1.5 w-[28%] hidden sm:table-cell"><span className="sr-only">Peso no mês</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownAssets.map(g => (
                        <tr key={g.key} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                          <td className="py-1.5 pr-3 font-mono text-foreground/90"><TokenIcon symbol={g.key} size={14} className="mr-1.5" />{g.key.replace('USDT', '')}</td>
                          <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-muted-foreground">{g.n}</td>
                          <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-muted-foreground">{g.winRate.toFixed(0)}%</td>
                          <td className="py-1.5 pr-3 text-right font-mono tabular-nums font-medium" style={{ color: g.pnl >= 0 ? GREEN : RED }}>{fmtPct(g.pnl)}</td>
                          <td className="py-1.5 hidden sm:table-cell"><DivergingBar value={g.pnl} max={maxAssetAbs} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {analysis.byAsset.length > ASSET_LIMIT && (
                  <button onClick={() => setShowAllAssets(v => !v)} className="w-full text-11px py-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors" style={{ background: 'rgba(255,255,255,0.03)' }}>
                    {showAllAssets ? `Mostrar só os ${ASSET_LIMIT} primeiros` : `Mostrar todos os ${analysis.byAsset.length} ativos`}
                  </button>
                )}
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} className="pt-3 space-y-1.5">
                  {analysis.bySide.map(g => (
                    <div key={g.key} className="flex items-center gap-x-3 text-xs">
                      <span className="flex-1 min-w-0 sm:flex-none sm:w-32 shrink-0 text-foreground/85">{SIDE_NAME[g.key] ?? g.key}</span>
                      <span className="font-mono tabular-nums text-muted-foreground shrink-0 sm:w-24"><span className="sm:hidden">{g.n} op.</span><span className="hidden sm:inline">{g.n} {g.n === 1 ? 'operação' : 'operações'}</span></span>
                      <span className="font-mono tabular-nums text-muted-foreground w-10 sm:w-12 shrink-0 text-right">{g.winRate.toFixed(0)}%</span>
                      <span className="font-mono tabular-nums font-medium w-16 sm:w-20 shrink-0 text-right" style={{ color: g.pnl >= 0 ? GREEN : RED }}>{fmtPct(g.pnl)}</span>
                      <span className="flex-1 hidden sm:block"><DivergingBar value={g.pnl} max={maxSideAbs} /></span>
                    </div>
                  ))}
                </div>
              </Panel>
            </section>

            <section className="min-w-0 lg:col-span-2 space-y-2" aria-label="Este mês e o anterior">
              <SectionTitle hint={`× ${prevMonthLabel}`}>Este mês e o anterior</SectionTitle>
              <Panel>
                {prevLoading ? (
                  <p className="text-xs text-muted-foreground">—</p>
                ) : prevError ? (
                  <p className="text-xs text-muted-foreground">Não foi possível ler o mês anterior; a comparação fica de fora.</p>
                ) : !comparison ? (
                  <p className="text-xs text-muted-foreground">O mês anterior ({prevMonthLabel}) não teve operação fechada, então não há com o que comparar.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground text-left">
                        <th className="font-medium pb-1.5 pr-2"><span className="sr-only">Indicador</span></th>
                        <th className="font-medium pb-1.5 pr-2 text-right">Este</th>
                        <th className="font-medium pb-1.5 pr-2 text-right">Anterior</th>
                        <th className="font-medium pb-1.5 text-right w-6"><span className="sr-only">Variação</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.map(r => (
                        <tr key={r.label} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                          <td className="py-1.5 pr-2 text-foreground/85">{r.label}</td>
                          <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{r.cur}</td>
                          <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-muted-foreground">{r.prev}</td>
                          <td className="py-1.5 text-right" aria-label={r.better === null ? 'sem mudança de qualidade' : r.better ? 'melhorou' : 'piorou'}>
                            {r.better === null ? <span className="text-muted-foreground">·</span>
                              : r.better ? <TrendingUp className="w-3.5 h-3.5 inline" style={{ color: GREEN }} aria-hidden="true" />
                                : <TrendingDown className="w-3.5 h-3.5 inline" style={{ color: RED }} aria-hidden="true" />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="text-11px text-muted-foreground mt-3">
                  {isPartialMonth ? 'O mês em andamento ainda não tem todas as operações; compare com cuidado.' : 'Um mês melhor que o outro, sozinho, não diz que algo mudou: com poucas operações a diferença pode ser só sorte.'}
                </p>
              </Panel>
            </section>
          </div>

          {/* Operações do mês */}
          <section className="space-y-2" aria-label="Operações do mês">
            <SectionTitle hint={`${filteredOps.length} de ${monthOps.length}`}>Operações do Mês</SectionTitle>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center rounded-md overflow-x-auto max-w-full" role="group" aria-label="Filtrar por resultado" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
                {OUTCOME_FILTERS.map((f, i) => {
                  const active = outcomeFilter === f.key;
                  return (
                    <button key={f.key} onClick={() => { setOutcomeFilter(f.key); setShowAllRows(false); }} aria-pressed={active}
                      className="text-11px font-mono px-2 sm:px-3 py-1.5 transition-all whitespace-nowrap"
                      style={{
                        borderLeft: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.08)',
                        ...(active ? { background: 'rgba(141,180,226,0.15)', color: BLUE } : { background: 'rgba(255,255,255,0.02)', color: 'rgba(255,255,255,0.55)' }),
                      }}>
                      {`${f.label} (${outcomeCounts[f.key]})`}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="rounded-md overflow-hidden" style={PANEL_STYLE}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                      <th className="text-left px-2 sm:px-4 py-2 text-muted-foreground font-medium">Abertura</th>
                      <th className="text-left px-2 sm:px-4 py-2 text-muted-foreground font-medium">Ativo</th>
                      <th className="text-left px-2 sm:px-4 py-2 text-muted-foreground font-medium">Lado</th>
                      <th className="text-right px-4 py-2 text-muted-foreground font-medium hidden md:table-cell">Entrada</th>
                      <th className="text-right px-4 py-2 text-muted-foreground font-medium hidden md:table-cell">Saída</th>
                      <th className="text-right px-4 py-2 text-muted-foreground font-medium hidden md:table-cell">Duração</th>
                      <th className="text-right px-2 sm:px-4 py-2 text-muted-foreground font-medium">Resultado</th>
                      <th className="text-left px-2 sm:px-4 py-2 text-muted-foreground font-medium">Como terminou</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownOps.map((op, i) => {
                      const pnl = calcRealizedPnlPct(op);
                      const exitPrice = getExitPrice(op);
                      const isBuy = op.side === 'BUY';
                      return (
                        <tr key={op.id} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)', borderTop: '1px solid rgba(255,255,255,0.03)' }}>
                          <td className="px-2 sm:px-4 py-2 text-muted-foreground whitespace-nowrap"><span className="sm:hidden">{moment(op.created_date).format('DD/MM')}</span><span className="hidden sm:inline">{moment(op.created_date).format('DD/MM HH:mm')}</span></td>
                          <td className="px-2 sm:px-4 py-2 text-foreground font-semibold whitespace-nowrap"><TokenIcon symbol={op.symbol} size={16} className="mr-2 hidden sm:inline-block" /><span className="sm:hidden">{op.symbol?.replace('USDT', '')}</span><span className="hidden sm:inline">{op.symbol?.replace('USDT', '/USDT')}</span></td>
                          <td className="px-2 sm:px-4 py-2" style={{ color: isBuy ? GREEN : RED }}>{op.side}</td>
                          <td className="px-4 py-2 text-right text-muted-foreground hidden md:table-cell">${formatPrice(op.entry_price)}</td>
                          <td className="px-4 py-2 text-right text-muted-foreground hidden md:table-cell">{exitPrice ? `$${formatPrice(exitPrice)}` : '—'}</td>
                          <td className="px-4 py-2 text-right text-muted-foreground hidden md:table-cell">{fmtDuration(opDurationMs(op)) ?? '—'}</td>
                          <td className="px-2 sm:px-4 py-2 text-right font-bold" style={{ color: pnl >= 0 ? GREEN : RED }}>{pnl !== null ? fmtPct(pnl) : '—'}</td>
                          <td className="px-2 sm:px-4 py-2 whitespace-nowrap" style={{ color: statusColor(op) }}>{statusLabel(op)}</td>
                        </tr>
                      );
                    })}
                    {filteredOps.length === 0 && (
                      <tr><td colSpan={8} className="px-4 py-6 text-center text-muted-foreground font-sans">Nenhuma operação deste tipo no mês.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {filteredOps.length > TABLE_LIMIT && (
                <button onClick={() => setShowAllRows(v => !v)} className="w-full text-11px py-2 text-muted-foreground hover:text-foreground transition-colors" style={{ background: 'rgba(18,17,16,0.7)', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                  {showAllRows ? `Mostrar só as ${TABLE_LIMIT} primeiras` : `Mostrar todas as ${filteredOps.length} operações`}
                </button>
              )}
            </div>
          </section>
        </>
      )}

      {/* Como ler este relatório — recolhido por padrão */}
      <details className="rounded-md" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <summary className="px-4 py-2.5 text-xs cursor-pointer select-none text-foreground/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-md">Como ler este relatório</summary>
        <div className="px-4 pb-3 grid gap-4 sm:grid-cols-2 text-xs text-foreground/75">
          <div>
            <p className="text-foreground/90 font-medium mb-1">O que entra</p>
            <ul className="space-y-1 list-disc pl-4">
              <li>O mês é o da <b className="font-medium text-foreground/90">abertura</b> da operação. Uma operação aberta no dia 30 e fechada no dia 2 conta no mês em que abriu.</li>
              <li>Só operações <b className="font-medium text-foreground/90">já fechadas</b>. As que seguem abertas aparecem como aviso, não nas contas.</li>
              <li>Tudo é <b className="font-medium text-foreground/90">virtual</b>: o Sentinel não envia ordem à corretora.</li>
            </ul>
          </div>
          <div>
            <p className="text-foreground/90 font-medium mb-1">Como os números são feitos</p>
            <ul className="space-y-1 list-disc pl-4">
              <li>O P&L é a soma do resultado de cada operação em % do preço de entrada (sem tamanho de posição, sem juros compostos).</li>
              <li>Já vem com custos estimados: {costModelText()}.</li>
              <li>O pior trecho segue a ordem em que as operações fecharam.</li>
              <li>A margem de erro (95%) da média em R trata as operações como independentes; moedas que andam juntas podem deixá-la mais estreita do que deveria.</li>
            </ul>
          </div>
          <p className="sm:col-span-2 text-11px text-muted-foreground">
            Um mês, principalmente com poucas operações, mostra o que aconteceu — não prova que a estratégia tem vantagem. A leitura no topo diz isso sempre que a amostra é pequena ou a média cabe na margem de erro.
          </p>
        </div>
      </details>
    </div>
  );
}
