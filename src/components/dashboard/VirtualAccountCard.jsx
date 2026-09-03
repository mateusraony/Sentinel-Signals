import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wallet, TrendingUp, TrendingDown, Shield } from 'lucide-react';
import { backend } from '@/api/entities';
import { simulateEquityCurve, DEFAULT_INITIAL_CAPITAL, DEFAULT_RISK_PCT } from '@/lib/equityCurve';

function MetricCard({ icon: Icon, label, value, sub, color, glowColor = undefined }) {
  return (
    <div className="flex items-center gap-3 rounded-xl px-4 py-3 flex-1 min-w-0"
      style={{
        background: 'rgba(10,13,22,0.85)',
        border: `1px solid ${glowColor ?? 'rgba(255,255,255,0.06)'}`,
        boxShadow: glowColor ? `0 0 20px ${glowColor}` : 'none',
        backdropFilter: 'blur(16px)',
      }}>
      <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
        style={{ background: `${color}18`, border: `1px solid ${color}30` }}>
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <div className="min-w-0">
        <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground leading-none mb-1">{label}</div>
        <div className="text-lg font-bold font-mono leading-none truncate" style={{ color }}>{value}</div>
        {sub && <div className="text-[9px] font-mono mt-0.5 truncate" style={{ color: 'rgba(255,255,255,0.3)' }}>{sub}</div>}
      </div>
    </div>
  );
}

// Conta virtual (capital+drawdown reais, compostos) sobre TODAS as operações
// fechadas — query própria (não a de 100 ops que PerformanceMetricsBar/
// PerformanceOverview já usam), com o mesmo teto de 500 que MonthlyReport.jsx
// tinha antes do item 141 (agora MonthlyReport busca por intervalo de data
// em vez desse teto — aqui ele segue valendo, sem filtro de mês possível,
// já que a conta virtual precisa do histórico inteiro). Sujeito à mesma
// classe de truncamento silencioso caso o total de operações fechadas passe
// de 500 — não corrigido nesta rodada (fora do que foi pedido: known-risks
// item 141). Defaults ($1.000 / 1% de risco por operação) são os mesmos do
// relatório de Backtest — ver src/lib/equityCurve.js.
export default function VirtualAccountCard() {
  const { data: operations = [] } = useQuery({
    queryKey: ['trade-operations-closed-all'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', 500),
    refetchInterval: 30000,
  });

  const sim = useMemo(() => {
    if (operations.length === 0) return null;
    return simulateEquityCurve(operations, { initialCapital: DEFAULT_INITIAL_CAPITAL, riskPct: DEFAULT_RISK_PCT });
  }, [operations]);

  if (!sim || sim.total === 0) return null;

  const { finalCapital, totalReturnPct, maxDrawdownPct, accountBlown, unsized, total } = sim;
  const returnColor = totalReturnPct >= 0 ? '#00ff80' : '#ff1478';
  const ddColor = maxDrawdownPct > 15 ? '#ff1478' : maxDrawdownPct > 8 ? '#ff9f43' : '#00ff80';

  return (
    <div className="rounded-2xl p-4"
      style={{ background: 'rgba(6,8,15,0.7)', border: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(20px)' }}>
      <div className="flex items-center gap-2 mb-3">
        <Wallet className="w-3.5 h-3.5" style={{ color: '#ffd166' }} />
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Conta Virtual (real, composta)</span>
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(255,209,102,0.08)', border: '1px solid rgba(255,209,102,0.2)', color: '#ffd166' }}>
          ${DEFAULT_INITIAL_CAPITAL} inicial · {DEFAULT_RISK_PCT}% risco/op
        </span>
        {accountBlown && (
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(255,20,120,0.15)', border: '1px solid rgba(255,20,120,0.4)', color: '#ff1478' }}>
            CONTA ZERADA
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5">
        <MetricCard
          icon={totalReturnPct >= 0 ? TrendingUp : TrendingDown}
          label="Capital Atual"
          value={`$${finalCapital.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          sub={`${total} operações fechadas`}
          color={returnColor}
          glowColor={totalReturnPct >= 0 ? 'rgba(0,255,128,0.06)' : 'rgba(255,20,120,0.06)'}
        />
        <MetricCard
          icon={totalReturnPct >= 0 ? TrendingUp : TrendingDown}
          label="Retorno Total"
          value={`${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(2)}%`}
          sub={unsized > 0 ? `${unsized} sem risco definido` : 'todas dimensionadas'}
          color={returnColor}
        />
        <MetricCard
          icon={Shield}
          label="Drawdown Real"
          value={`-${maxDrawdownPct.toFixed(2)}%`}
          sub={maxDrawdownPct < 5 ? 'Risco controlado ✓' : maxDrawdownPct < 15 ? 'Atenção moderada' : 'Drawdown alto ⚠️'}
          color={ddColor}
          glowColor={maxDrawdownPct > 15 ? 'rgba(255,20,120,0.06)' : undefined}
        />
      </div>
    </div>
  );
}
