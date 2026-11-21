import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

// Resumo do Dashboard: blocos de tamanhos diferentes, cada um com o que o número significa
// (quais ativos, qual lado, saúde dos dados). Só leitura do que a tela já calcula; nada novo no motor.
const BUY = '#5db586';
const SELL = '#e06a5b';
const WARN = '#dd9a4a';
const short = (s) => String(s || '').replace(/USDT$/, '');

/** @param {{ value: number }} props */
function Count({ value }) {
  const [n, setN] = useState(0);
  /** @type {React.MutableRefObject<number|undefined>} */
  const raf = useRef();
  useEffect(() => {
    const target = Number(value) || 0; const t0 = performance.now();
    const step = (now) => { const p = Math.min((now - t0) / 700, 1); setN(Math.round(target * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);
  return <>{n}</>;
}

/** @param {{ value: number, color?: string, error?: boolean, testId?: string }} props */
function Big({ value, color, error, testId }) {
  if (error) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <p data-testid={testId} className="text-3xl font-mono flex items-center gap-1.5 cursor-help" tabIndex={0} style={{ color: 'rgba(255,255,255,0.35)' }}>
            <AlertTriangle className="w-4 h-4" style={{ color: WARN }} />—
          </p>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
          Não foi possível confirmar este número agora — falha ao atualizar.
        </TooltipContent>
      </Tooltip>
    );
  }
  return <p data-testid={testId} className="text-3xl font-mono font-medium tabular-nums leading-none" style={{ color: color || 'hsl(var(--foreground))' }}><Count value={value} /></p>;
}

/** @param {{ className?: string, accent?: string, label: string, children?: any }} props */
function Tile({ className = '', accent, label, children }) {
  return (
    <div className={`glass-card rounded-md p-4 relative overflow-hidden ${className}`}
      style={accent ? { borderTop: `2px solid ${accent}`, background: `linear-gradient(0deg, hsl(var(--card)), hsl(var(--card)))` } : undefined}>
      <p className="text-xs text-muted-foreground mb-2">{label}</p>
      {children}
    </div>
  );
}

// As contagens vêm de fora (as mesmas de sempre, por id de ativo); `ops`/`highPriority`/`waiting` são só os nomes para exibir.
/** @param {{ ops?: Array<any>, opsCount?: number, highPriority?: string[], highPriorityCount?: number, waiting?: string[], waitingCount?: number, buy?: number, sell?: number, assetsOk?: boolean[], errors?: { ops?: boolean, signals?: boolean, assets?: boolean } }} props */
export default function SummaryTiles({ ops = [], opsCount = ops.length, highPriority = [], highPriorityCount = highPriority.length, waiting = [], waitingCount = waiting.length, buy = 0, sell = 0, assetsOk = [], errors = {} }) {
  const total = buy + sell;
  const nOk = assetsOk.filter(Boolean).length;
  return (
    <div className="grid grid-cols-2 md:grid-cols-12 gap-3">
      <Tile className="md:col-span-4" accent={BUY} label="Operações ativas">
        <div className="flex items-start gap-4">
          <Big testId="resumo-ops" value={opsCount} color={BUY} error={errors.ops} />
          <ul className="flex-1 min-w-0 space-y-1.5 pt-0.5">
            {ops.slice(0, 3).map((o) => (
              <li key={o.id} className="flex items-center gap-2 text-xs">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: o.side === 'SELL' ? SELL : BUY }} />
                <span className="font-semibold text-foreground">{short(o.symbol)}</span>
                <span className="text-muted-foreground truncate">{o.side === 'SELL' ? 'Venda' : 'Compra'} · {o.status === 'RUNNER_ACTIVE' ? 'runner ativo' : 'ativa'}</span>
              </li>
            ))}
            {opsCount === 0 && !errors.ops && <li className="text-xs text-muted-foreground">Nenhuma operação aberta.</li>}
          </ul>
        </div>
      </Tile>

      <Tile className="md:col-span-2" accent={WARN} label="Alta prioridade">
        <Big testId="resumo-alta" value={highPriorityCount} color={highPriorityCount > 0 ? WARN : undefined} error={errors.signals} />
        <p className="text-xs text-muted-foreground mt-2 truncate">{highPriorityCount > 0 ? (highPriority.slice(0, 3).map(short).join(', ') || `${highPriorityCount} ativo(s)`) : 'Nenhuma agora'}</p>
      </Tile>

      <Tile className="md:col-span-2" label="Aguardando">
        <Big testId="resumo-aguardando" value={waitingCount} error={errors.signals} />
        <p className="text-xs text-muted-foreground mt-2 truncate">{waitingCount > 0 ? (waiting.slice(0, 3).map(short).join(', ') || `${waitingCount} ativo(s)`) : 'Nenhum'}</p>
      </Tile>

      <Tile className="md:col-span-2" label="Sinais recentes">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-xl font-medium tabular-nums" style={{ color: BUY }}>{buy}<span className="text-xs text-muted-foreground font-sans ml-1">BUY</span></span>
          <span className="font-mono text-xl font-medium tabular-nums" style={{ color: SELL }}>{sell}<span className="text-xs text-muted-foreground font-sans ml-1">SELL</span></span>
        </div>
        <div className="flex h-1.5 rounded-sm overflow-hidden mt-3" style={{ background: 'rgba(255,255,255,0.08)' }} aria-label={`${buy} de compra e ${sell} de venda`}>
          {total > 0 && <><div style={{ width: `${(buy / total) * 100}%`, background: BUY }} /><div style={{ width: `${(sell / total) * 100}%`, background: SELL }} /></>}
        </div>
      </Tile>

      <Tile className="md:col-span-2" label="Monitorados">
        <Big testId="resumo-monitorados" value={assetsOk.length} error={errors.assets} />
        <div className="flex items-center gap-1 mt-2.5" aria-label={`${nOk} de ${assetsOk.length} com dados em dia`}>
          {assetsOk.map((ok, i) => <span key={i} className="w-2 h-2 rounded-full" style={{ background: ok ? BUY : WARN }} />)}
          <span className="text-xs text-muted-foreground ml-1.5">{nOk === assetsOk.length ? 'em dia' : `${nOk} em dia`}</span>
        </div>
      </Tile>
    </div>
  );
}
