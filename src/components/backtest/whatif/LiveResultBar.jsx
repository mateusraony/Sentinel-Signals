import React from 'react';
import { Loader2 } from 'lucide-react';
import { AMBER } from './ui';
import { CELLS, Delta } from './ComparisonStrip';

// Faixa GRUDADA no topo (abaixo da barra do painel) com o resultado ao vivo: enquanto o usuário rola pelos controles do Ajuste Fino ele continua vendo o
// resultado atual contra o padrão, sem precisar descer até a comparação completa. Mesmos números e mesmas setas da ComparisonStrip (uma fonte só: CELLS/Delta).
// No celular a faixa mostra só 3 números (o resto está na comparação completa logo abaixo) para não ocupar metade da tela.
const MOBILE_HIDDEN = new Set(['profitFactor', 'maxDrawdownPct']);
const SHORT = { expectancyR: 'Expectância', winRate: 'Acerto', profitFactor: 'PF', maxDrawdownPct: 'Drawdown', counted: 'Operações' };

export default function LiveResultBar({ cmp, isDefault, stale, auto, changedCount }) {
  if (!cmp) return null;
  const exp = cmp.expectancyR;
  return (
    <section aria-label="Resultado ao vivo" className="sticky top-14 z-20 rounded-md px-3 py-2"
      style={{ background: 'rgba(24,23,21,0.97)', border: '1px solid rgba(141,180,226,0.25)', boxShadow: '0 6px 14px rgba(0,0,0,0.35)' }}>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="text-xs font-semibold text-foreground/85">Resultado ao vivo</span>
        <span className="text-11px text-muted-foreground">
          {isDefault ? 'no padrão' : `${changedCount} ${changedCount === 1 ? 'parâmetro diferente' : 'parâmetros diferentes'} do padrão`}
        </span>
        {stale && (
          <span className="text-11px flex items-center gap-1 ml-auto" role="status" style={{ color: AMBER }}>
            {auto && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}{auto ? 'recalculando…' : 'desatualizado: clique em Executar'}
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2" style={{ opacity: stale ? 0.6 : 1 }}>
        {CELLS.map(c => {
          const m = cmp[c.key];
          return (
            <div key={c.key} className={`min-w-0 ${MOBILE_HIDDEN.has(c.key) ? 'hidden sm:block' : ''}`}>
              <div className="text-11px text-muted-foreground truncate">{SHORT[c.key]}</div>
              <div className="text-sm font-mono font-medium tabular-nums leading-tight text-foreground">{c.fmt(m.cur)}</div>
              {isDefault ? <div className="text-11px text-muted-foreground">padrão</div> : <div className="truncate"><Delta cell={c} m={m} /></div>}
            </div>
          );
        })}
      </div>
      {!isDefault && exp.delta !== null && Math.abs(exp.delta) >= 1e-9 && (
        <p className="hidden sm:block text-11px mt-1" style={{ color: exp.withinNoise ? 'rgba(255,255,255,0.55)' : AMBER }}>
          {cmp.noiseR === null ? 'Poucas operações para medir a margem de erro.' : exp.withinNoise ? 'A diferença de expectância cabe na margem de erro (provável ruído).' : 'A diferença de expectância passa da margem de erro — confirme em outro período.'}
        </p>
      )}
    </section>
  );
}
