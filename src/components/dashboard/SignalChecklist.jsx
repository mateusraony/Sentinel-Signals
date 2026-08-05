import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, ChevronDown, ChevronUp, Check, X as XIcon, Loader2 } from 'lucide-react';
import { fetchCandles, fetchCurrentPrice } from '@/lib/marketDataProvider';
import { calculateRangeFilter } from '@/lib/indicators/rangeFilter';

const ACTIVE_STATUSES = ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'];

// Checklist informativo — replica em modo SÓ LEITURA as travas que o
// scanner (src/lib/scanner.js) já aplica antes de confirmar uma entrada
// (regime_rejected/trend_reversed/confirmation_15m_not_aligned/
// active_op_exists). NÃO decide nem bloqueia nada de verdade — é
// unicamente para o usuário conferir visualmente antes de agir manualmente
// sobre um sinal. Nenhuma lógica de scanner.js foi tocada ou duplicada como
// gate real.
export default function SignalChecklist({ asset, signal, tradeOps }) {
  const [expanded, setExpanded] = useState(false);

  const { data: live, isLoading, error } = useQuery({
    queryKey: ['signal-checklist', asset.symbol, signal.id],
    queryFn: async () => {
      const [candles15m, currentPrice] = await Promise.all([
        fetchCandles(asset.symbol, '15m', 100),
        fetchCurrentPrice(asset.symbol),
      ]);
      const closed = candles15m.filter(c => c.isClosed);
      const rf15m = calculateRangeFilter(closed, asset.rf_period || 20, asset.rf_multiplier || 3.5);
      return { rf15mDirection: rf15m.direction, currentPrice };
    },
    enabled: expanded,
    staleTime: 15000,
    retry: 1,
  });

  const dir = signal.signal_type === 'BUY' ? 1 : -1;

  const checks = expanded && live ? [
    {
      label: 'Tendência 4H alinhada',
      pass: signal.context?.tf_4h_direction === dir,
      detail: signal.context?.tf_4h_direction === 1 ? 'Alta' : signal.context?.tf_4h_direction === -1 ? 'Baixa' : 'Neutra/sem dado',
    },
    {
      label: '1D não contrária',
      pass: signal.context?.tf_1d_direction !== -dir,
      detail: signal.context?.tf_1d_direction === 1 ? 'Alta' : signal.context?.tf_1d_direction === -1 ? 'Baixa' : 'Neutra/sem dado',
    },
    {
      label: 'RF 15m na direção do sinal',
      pass: live.rf15mDirection === dir,
      detail: live.rf15mDirection === 1 ? 'Alta' : live.rf15mDirection === -1 ? 'Baixa' : 'Neutro',
    },
    {
      label: 'Preço no lado correto do filtro',
      pass: signal.context?.rf_value != null && (dir === 1 ? live.currentPrice > signal.context.rf_value : live.currentPrice < signal.context.rf_value),
      detail: signal.context?.rf_value != null ? `preço ${live.currentPrice} vs RF ${signal.context.rf_value.toFixed(4)}` : 'sem RF registrado no sinal',
    },
    {
      label: 'Sem operação ativa no ativo',
      pass: !tradeOps.some(op => op.asset_id === asset.id && ACTIVE_STATUSES.includes(op.status)),
      detail: tradeOps.some(op => op.asset_id === asset.id && ACTIVE_STATUSES.includes(op.status)) ? 'já existe operação em andamento' : 'livre',
    },
  ] : [];

  const allPass = checks.length > 0 && checks.every(c => c.pass);

  return (
    <div className="mt-1.5">
      <button onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-1 text-[8px] font-mono px-2 py-1 rounded transition-all"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
        {expanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
        Checklist de verificação
      </button>

      {expanded && (
        <div className="mt-1.5 rounded-lg p-2.5 space-y-1.5" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
          {isLoading && (
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-muted-foreground py-2">
              <Loader2 className="w-3 h-3 animate-spin" />Verificando gates em tempo real...
            </div>
          )}
          {!isLoading && error && (
            <div className="text-[9px] font-mono text-muted-foreground py-1">Não foi possível verificar agora (falha ao buscar dados de mercado).</div>
          )}
          {!isLoading && checks.length > 0 && (
            <>
              {checks.map((c, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-[9px] font-mono">
                  <span className="flex items-center gap-1.5" style={{ color: c.pass ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.45)' }}>
                    {c.pass ? <Check className="w-3 h-3 shrink-0" style={{ color: '#00ff80' }} /> : <XIcon className="w-3 h-3 shrink-0" style={{ color: '#ff1478' }} />}
                    {c.label}
                  </span>
                  <span className="text-muted-foreground truncate ml-2">{c.detail}</span>
                </div>
              ))}
              <div className="pt-1.5 mt-1.5 flex items-center gap-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                {allPass ? <ShieldCheck className="w-3.5 h-3.5" style={{ color: '#00ff80' }} /> : <ShieldAlert className="w-3.5 h-3.5" style={{ color: '#ff1478' }} />}
                <span className="text-[10px] font-mono font-bold" style={{ color: allPass ? '#00ff80' : '#ff1478' }}>
                  {allPass ? 'ENTRADA LIBERADA' : 'BLOQUEADA'}
                </span>
              </div>
              <p className="text-[7px] font-mono text-muted-foreground/60 pt-0.5">
                Informativo — replica as travas do scanner só para conferência manual, não substitui nem altera a decisão real do motor.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
