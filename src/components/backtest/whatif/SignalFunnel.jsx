import React from 'react';
import { GREEN, AMBER, Panel } from './ui';

// O que aconteceu com cada sinal do Range Filter: virou operação, foi barrado pelo score mínimo ou foi ignorado porque já havia uma operação aberta.
export default function SignalFunnel({ stats }) {
  if (!stats || stats.signals === 0) {
    return <Panel><p className="text-xs text-muted-foreground">O Range Filter não emitiu nenhum sinal nesta janela com estes parâmetros — por isso não há operações.</p></Panel>;
  }
  const { signals, taken, rejectedByScore, rejectedByRegime = 0, rejectedByRR = 0, skippedWhileOpen } = stats;
  const seg = [
    { label: 'viraram operação', n: taken, color: GREEN },
    { label: 'barrados pelo score mínimo', n: rejectedByScore, color: AMBER },
    { label: 'barrados pelo filtro de regime (mercado lateral/fraco)', n: rejectedByRegime, color: '#a78bfa' },
    { label: 'barrados pelo piso de risco/retorno (TP1 curto demais para o stop)', n: rejectedByRR, color: '#5db586' },
    { label: 'ignorados (já havia operação aberta)', n: skippedWhileOpen, color: 'rgba(255,255,255,0.3)' },
  ];
  const scoreDominates = rejectedByScore / signals > 0.5;
  const regimeDominates = rejectedByRegime / signals > 0.5;
  const rrDominates = rejectedByRR > 0 && taken === 0; // com o TP1 abaixo do piso TODAS as entradas que passariam são barradas
  return (
    <Panel className="space-y-2">
      <div className="flex w-full h-3 rounded overflow-hidden" role="img" aria-label={`${signals} sinais: ${seg.map(s => `${s.n} ${s.label}`).join(', ')}`} style={{ background: 'rgba(255,255,255,0.05)' }}>
        {seg.filter(s => s.n > 0).map(s => <div key={s.label} style={{ width: `${(s.n / signals) * 100}%`, background: s.color }} />)}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <li className="text-foreground/85"><span className="font-mono tabular-nums">{signals}</span> sinais do Range Filter</li>
        {seg.map(s => (
          <li key={s.label} className="text-muted-foreground"><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} /><span className="font-mono tabular-nums text-foreground/85">{s.n}</span> {s.label}</li>
        ))}
      </ul>
      {regimeDominates && <p className="text-xs" style={{ color: '#a78bfa' }}>O filtro de regime barra a maioria dos sinais (como na produção): desligá-lo mostra o efeito dele, mas o resultado deixa de ser o do scanner.</p>}
      {rrDominates && <p className="text-xs" style={{ color: AMBER }}>O piso de risco/retorno está barrando as entradas: o TP1 (R) está abaixo do piso. O scanner também não abriria nenhuma operação assim — suba o TP1 ou baixe o piso.</p>}
      {scoreDominates && <p className="text-xs" style={{ color: AMBER }}>O score mínimo está barrando a maioria dos sinais: mexer no Min Score muda muito o número de operações (e a amostra).</p>}
    </Panel>
  );
}
