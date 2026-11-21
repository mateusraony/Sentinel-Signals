import React from 'react';
import { formatPrice } from '@/lib/priceProximity';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

// Régua da operação: Stop → Entrada → TP1 → TP2 numa só linha, com o preço atual marcado.
// Só visual: usa os campos que a operação já tem (entry_price, initial_stop, tp1, tp2, current_stop);
// não muda nada no motor. A posição é (valor − stop) / (tp2 − stop), então vale igual para compra e venda
// (o risco fica sempre à esquerda e o alvo à direita).
const BUY = '#5db586';
const SELL = '#e06a5b';
const MUTED = 'rgba(255,255,255,0.55)';

export default function OpLadder({ op, price, tooltips = {} }) {
  const entry = Number(op.entry_price);
  const stop = Number(op.initial_stop);
  const tp1 = Number(op.tp1);
  const tp2 = Number(op.tp2);
  const trail = Number(op.current_stop);
  const now = Number(price);
  if (![entry, stop, tp2].every(Number.isFinite) || stop === tp2) return null;

  const pos = (v) => ((v - stop) / (tp2 - stop)) * 100;
  const clamp = (n) => Math.max(0, Math.min(100, n));
  const pe = clamp(pos(entry));
  const hasNow = Number.isFinite(now);
  const pn = hasNow ? clamp(pos(now)) : null;
  const inProfit = hasNow && pos(now) >= pos(entry);
  const trailMoved = Number.isFinite(trail) && trail !== stop;

  const marks = [
    { key: 'Stop', at: 0, value: stop, color: SELL },
    { key: 'Entrada', at: pe, value: entry },
    { key: 'TP1', at: clamp(pos(tp1)), value: tp1, hit: op.tp1_hit },
    { key: 'TP2', at: 100, value: tp2, hit: op.tp2_hit },
  ].filter((m) => Number.isFinite(m.value));

  return (
    <div className="mt-3 mb-4 px-7" aria-label="Régua da operação: stop, entrada, TP1 e TP2">
      <div className="relative" style={{ height: 58 }}>
        {/* trilho + zona de risco (stop → entrada) + avanço (entrada → preço atual) */}
        <div className="absolute left-0 right-0" style={{ top: 28, height: 2, background: 'rgba(255,255,255,0.12)' }} />
        <div className="absolute" style={{ top: 27, height: 4, left: 0, width: `${pe}%`, background: 'rgba(224,106,91,0.45)' }} />
        {hasNow && (
          <div className="absolute" style={{ top: 27, height: 4, left: `${Math.min(pe, pn)}%`, width: `${Math.abs(pn - pe)}%`, background: inProfit ? BUY : SELL }} />
        )}
        {marks.map((m) => (
          <div key={m.key} className="absolute text-center whitespace-nowrap" style={{ left: `${m.at}%`, top: 0, transform: 'translateX(-50%)' }}>
            {tooltips[m.key] ? (
              // Mesmo comportamento de antes (achado M-17): rótulo focável por teclado com dica explicando o termo.
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="text-11px leading-none cursor-help" tabIndex={0} style={{ color: MUTED }}>{m.key}{m.hit ? ' ✓' : ''}</div>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                  {tooltips[m.key]}
                </TooltipContent>
              </Tooltip>
            ) : (
              <div className="text-11px leading-none" style={{ color: MUTED }}>{m.key}{m.hit ? ' ✓' : ''}</div>
            )}
            <div style={{ width: 1, height: 14, background: m.hit ? BUY : 'rgba(255,255,255,0.35)', margin: '5px auto 0' }} />
            <div className="font-mono text-11px leading-none tabular-nums" style={{ marginTop: 9, color: m.color || 'hsl(var(--foreground))' }}>{formatPrice(m.value)}</div>
          </div>
        ))}
        {/* preço atual */}
        {hasNow && (
          <div className="absolute" style={{ left: `${pn}%`, top: 17, transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: `10px solid ${inProfit ? BUY : SELL}` }} />
        )}
        {/* stop atual (quando já andou) */}
        {trailMoved && (
          <div className="absolute" style={{ left: `${clamp(pos(trail))}%`, top: 24, width: 8, height: 8, transform: 'translateX(-50%) rotate(45deg)', background: 'hsl(var(--foreground))' }} />
        )}
      </div>
      {trailMoved && (
        <div className="flex justify-end text-11px font-mono" style={{ color: MUTED }}>
          <span><span style={{ display: 'inline-block', width: 7, height: 7, background: 'hsl(var(--foreground))', transform: 'rotate(45deg)', marginRight: 6 }} />Stop atual {formatPrice(trail)}</span>
        </div>
      )}
    </div>
  );
}
