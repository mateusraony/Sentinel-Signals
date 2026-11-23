import React from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { GREEN, RED, AMBER, BLUE } from './ui';

// "Posso confiar?": (1) a conferência dos candles que alimentaram o resultado e (2) o que este simulador faz e NÃO faz em relação ao scanner real.
const STATUS = {
  ok: { Icon: CheckCircle2, color: GREEN },
  info: { Icon: Info, color: BLUE },
  attention: { Icon: AlertTriangle, color: AMBER },
  problem: { Icon: AlertCircle, color: RED },
};
const LEVEL_TEXT = { ok: 'Dados conferidos: tudo certo', attention: 'Dados conferidos: há pontos de atenção', problem: 'Dados conferidos: há problemas' };

export function DataBadge({ quality }) {
  if (!quality) return null;
  const st = STATUS[quality.level];
  return (
    <span className="inline-flex items-center gap-1 text-xs" style={{ color: st.color }}>
      <st.Icon className="w-3.5 h-3.5" aria-hidden="true" />{LEVEL_TEXT[quality.level]}
    </span>
  );
}

export default function TrustPanel({ quality, fidelity }) {
  return (
    <details className="rounded-md" style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <summary className="px-4 py-2.5 text-xs cursor-pointer select-none text-foreground/80 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        Posso confiar? Conferência dos dados e o que este simulador faz (e não faz)
      </summary>
      <div className="px-4 pb-4 grid gap-5 lg:grid-cols-2">
        <section aria-label="Conferência dos dados">
          <h3 className="text-xs font-semibold text-foreground/85 mb-2">Conferência dos candles</h3>
          {quality ? (
            <ul className="space-y-1.5">
              {quality.checks.map(c => {
                const st = STATUS[c.status];
                return (
                  <li key={c.id} className="flex items-start gap-2 text-xs">
                    <st.Icon className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: st.color }} aria-hidden="true" />
                    <span><span className="text-foreground/90">{c.label}:</span> <span className="text-muted-foreground">{c.detail}</span></span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-xs text-muted-foreground">Escolha um ativo para conferir os dados.</p>}
        </section>
        <section aria-label="Fidelidade do simulador">
          <h3 className="text-xs font-semibold text-foreground/85 mb-2">O que este simulador faz</h3>
          <ul className="space-y-1 text-xs text-foreground/80 list-disc pl-4">
            {fidelity.included.map(t => <li key={t}>{t}</li>)}
          </ul>
          <h3 className="text-xs font-semibold text-foreground/85 mt-3 mb-2">O que ele NÃO faz (e o scanner real faz)</h3>
          <ul className="space-y-1.5 text-xs">
            {fidelity.notIncluded.map(n => (
              <li key={n.label} className="flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: AMBER }} aria-hidden="true" />
                <span><span className="text-foreground/90">{n.label}</span> <span style={{ color: AMBER }}>— {n.production}.</span> <span className="text-muted-foreground">{n.why}</span></span>
              </li>
            ))}
          </ul>
          <p className="text-11px text-muted-foreground mt-3">Por isso o resultado absoluto daqui não prevê o da produção. O uso certo é comparar parâmetros entre si, nos mesmos candles.</p>
        </section>
      </div>
    </details>
  );
}
