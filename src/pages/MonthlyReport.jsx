import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { FileText, Download, TrendingUp, TrendingDown, Target, Award, Calendar, Loader2 } from 'lucide-react';
import moment from 'moment';
import { jsPDF } from 'jspdf';
import { isClosedOp, getExitPrice, calcRealizedPnlPct, summarizeOps } from '@/lib/tradeMetrics';

function fmt(price) {
  if (!price && price !== 0) return '—';
  if (price >= 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

const STATUS_LABELS = {
  TP2_HIT: '🏆 TP2',
  STOP_HIT: '🛑 Stop',
  INVALIDATED: '⚠ Invalidado',
  CLOSED: '✖ Encerrado',
};

const STATUS_COLORS = {
  TP2_HIT: '#00ff80',
  STOP_HIT: '#ff1478',
  INVALIDATED: '#ff9f43',
  CLOSED: '#64748b',
};

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

function MiniMetric({ label, value, color }) {
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="text-[9px] font-mono text-muted-foreground mb-0.5">{label}</div>
      <div className="text-sm font-mono font-bold" style={{ color }}>{value}</div>
    </div>
  );
}

export default function MonthlyReport() {
  const [selectedMonth, setSelectedMonth] = useState(moment().format('YYYY-MM'));
  const [exporting, setExporting] = useState(false);

  const { data: operations = [], isLoading } = useQuery({
    queryKey: ['monthly-report-ops'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', 500),
    refetchInterval: 30000,
  });

  const monthOps = useMemo(() => {
    return operations
      .filter(isClosedOp)
      .filter(op => moment(op.created_date).format('YYYY-MM') === selectedMonth)
      .sort((a, b) => new Date(a.created_date) - new Date(b.created_date));
  }, [operations, selectedMonth]);

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

  const monthOptions = useMemo(() => {
    const months = [];
    for (let i = 0; i < 12; i++) {
      const m = moment().subtract(i, 'months');
      months.push({ value: m.format('YYYY-MM'), label: m.format('MMMM [de] YYYY') });
    }
    return months;
  }, []);

  const handleExportPDF = () => {
    if (!metrics || monthOps.length === 0) return;
    setExporting(true);
    try {
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
      const monthLabel = moment(selectedMonth + '-01').format('MMMM [de] YYYY');
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
        doc.setTextColor(...item.color);
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
          `$${fmt(op.entry_price)}`,
          exitPrice ? `$${fmt(exitPrice)}` : '—',
          pnl !== null ? fmtPct(pnl) : '—',
          (STATUS_LABELS[op.status] || op.status).replace(/[^\x20-\x7E]/g, ''),
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
        doc.text(`CryptoRadar — Página ${i} de ${totalPages}`, pageWidth / 2, 290, { align: 'center' });
      }

      doc.save(`relatorio-mensal-${selectedMonth}.pdf`);
    } catch (err) {
      console.error('PDF export error:', err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Relatórios</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Resumo Mensal</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
            <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
              className="px-3 py-1.5 rounded-lg text-[11px] font-mono outline-none capitalize"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>
              {monthOptions.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <button onClick={handleExportPDF} disabled={exporting || !metrics || monthOps.length === 0}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[11px] font-mono font-bold transition-all hover:opacity-90 disabled:opacity-40"
            style={{ background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }}>
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Exportar PDF
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !metrics || monthOps.length === 0 ? (
        <div className="rounded-xl p-12 text-center" style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <FileText className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
          <p className="text-muted-foreground text-sm">Nenhuma operação fechada neste mês.</p>
          <p className="text-xs text-muted-foreground mt-1">Selecione outro mês ou aguarde novas operações serem encerradas.</p>
        </div>
      ) : (
        <>
          {/* Summary metrics */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <SummaryCard icon={TrendingUp} label="P&L Acumulado" value={fmtPct(metrics.totalPnl)} sublabel={`${metrics.wins}W · ${metrics.be}BE · ${metrics.losses}L`} color={metrics.totalPnl >= 0 ? '#00ff80' : '#ff1478'} glowColor={metrics.totalPnl >= 0 ? 'rgba(0,255,128,0.4)' : 'rgba(255,20,120,0.4)'} />
            <SummaryCard icon={Target} label="Taxa de Acerto" value={`${metrics.winRate.toFixed(1)}%`} sublabel={`${metrics.wins}W · ${metrics.be}BE · ${metrics.losses}L`} color={metrics.winRate >= 50 ? '#00ff80' : '#ff9f43'} glowColor={metrics.winRate >= 50 ? 'rgba(0,255,128,0.4)' : 'rgba(255,159,67,0.4)'} />
            <SummaryCard icon={FileText} label="Total de Trades" value={`${metrics.totalTrades}`} sublabel="operações fechadas" color="#00e5ff" glowColor="rgba(0,229,255,0.4)" />
            <SummaryCard icon={TrendingUp} label="Vitórias" value={`${metrics.wins}`} sublabel="trades lucrativos" color="#00ff80" glowColor="rgba(0,255,128,0.4)" />
            <SummaryCard icon={TrendingDown} label="Derrotas" value={`${metrics.losses}`} sublabel="trades em perda" color="#ff1478" glowColor="rgba(255,20,120,0.4)" />
            <SummaryCard icon={Award} label="Profit Factor" value={metrics.profitFactor === null ? '∞' : metrics.profitFactor.toFixed(2)} sublabel={metrics.profitFactor === null || metrics.profitFactor >= 1.5 ? '✓ Saudável' : '⚠ Baixo'} color={metrics.profitFactor === null || metrics.profitFactor >= 1.5 ? '#00ff80' : '#ff9f43'} glowColor={metrics.profitFactor === null || metrics.profitFactor >= 1.5 ? 'rgba(0,255,128,0.4)' : 'rgba(255,159,67,0.4)'} />
          </div>

          {/* Additional metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MiniMetric label="Melhor Trade" value={fmtPct(metrics.bestTrade)} color="#00ff80" />
            <MiniMetric label="Pior Trade" value={fmtPct(metrics.worstTrade)} color="#ff1478" />
            <MiniMetric label="Ganho Médio" value={fmtPct(metrics.avgWin)} color="#00ff80" />
            <MiniMetric label="Perda Média" value={fmtPct(-metrics.avgLoss)} color="#ff1478" />
          </div>

          {/* Trade table */}
          <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <FileText className="w-4 h-4" style={{ color: '#00e5ff' }} />
              <h2 className="text-sm font-bold text-foreground">Operações do Mês</h2>
              <span className="text-[10px] font-mono text-muted-foreground">({monthOps.length} trades)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] font-mono">
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                    <th className="text-left px-4 py-2 text-muted-foreground font-medium">Data</th>
                    <th className="text-left px-4 py-2 text-muted-foreground font-medium">Símbolo</th>
                    <th className="text-left px-4 py-2 text-muted-foreground font-medium">Side</th>
                    <th className="text-right px-4 py-2 text-muted-foreground font-medium">Entrada</th>
                    <th className="text-right px-4 py-2 text-muted-foreground font-medium">Saída</th>
                    <th className="text-right px-4 py-2 text-muted-foreground font-medium">P&L</th>
                    <th className="text-left px-4 py-2 text-muted-foreground font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {monthOps.map((op, i) => {
                    const pnl = calcRealizedPnlPct(op);
                    const exitPrice = getExitPrice(op);
                    const isBuy = op.side === 'BUY';
                    return (
                      <tr key={op.id} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)', borderTop: '1px solid rgba(255,255,255,0.03)' }}>
                        <td className="px-4 py-2 text-muted-foreground">{moment(op.created_date).format('DD/MM HH:mm')}</td>
                        <td className="px-4 py-2 text-foreground font-semibold">{op.symbol?.replace('USDT', '/USDT')}</td>
                        <td className="px-4 py-2" style={{ color: isBuy ? '#00ff80' : '#ff1478' }}>{op.side}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">${fmt(op.entry_price)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{exitPrice ? `$${fmt(exitPrice)}` : '—'}</td>
                        <td className="px-4 py-2 text-right font-bold" style={{ color: pnl >= 0 ? '#00ff80' : '#ff1478' }}>{pnl !== null ? fmtPct(pnl) : '—'}</td>
                        <td className="px-4 py-2" style={{ color: STATUS_COLORS[op.status] || '#64748b' }}>{STATUS_LABELS[op.status] || op.status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}