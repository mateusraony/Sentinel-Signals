import React from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import ComparePanel from '@/components/dashboard/ComparePanel';

// Comparar ativos (21/11/2026): abre como gaveta lateral por cima da página — o mesmo padrão do painel do ativo
// (AssetDrawer) — em vez de aparecer no meio do Dashboard, abaixo dos alertas e do Resumo, onde o usuário tinha de
// rolar até o fim para ver. Os dados e a lógica de comparação são os de sempre (ComparePanel); só mudou o lugar e o visual.
const ACTIVE_STATUSES = ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'];

/** @param {{ label: string, value: string, onChange: (v: string) => void, assets: Array<any>, placeholder: string, badge: string }} props */
function AssetPicker({ label, value, onChange, assets, placeholder, badge }) {
  return (
    <label className="block">
      <span className="flex items-center gap-2 text-xs text-muted-foreground mb-1.5">
        <span aria-hidden="true" className="text-11px font-mono font-medium w-5 h-5 rounded flex items-center justify-center"
          style={{ background: 'rgba(141,180,226,0.12)', color: '#8db4e2', border: '1px solid rgba(141,180,226,0.25)' }}>{badge}</span>
        {label}
      </span>
      <select aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2.5 rounded-md text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }}>
        <option value="">{placeholder}</option>
        {assets.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
      </select>
    </label>
  );
}

/**
 * @param {{
 *   open: boolean, onClose: () => void, assets: Array<any>, aId: string|null, bId: string|null,
 *   onChangeA: (id: string) => void, onChangeB: (id: string) => void,
 *   states?: Array<any>, signals?: Array<any>, ops?: Array<any>, dataUnavailable?: boolean,
 * }} props
 */
export default function CompareDrawer({ open, onClose, assets, aId, bId, onChangeA, onChangeB, states = [], signals = [], ops = [], dataUnavailable = false }) {
  const assetA = assets.find((a) => a.id === aId);
  const assetB = assets.find((a) => a.id === bId);

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[1000px] p-0 flex flex-col gap-0"
        style={{ background: 'hsl(var(--background))', borderLeft: '1px solid hsl(var(--border))' }}
      >
        <SheetHeader className="px-6 py-4 shrink-0 space-y-1 text-left" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
          <SheetTitle className="text-base font-semibold text-foreground">Comparar ativos</SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground">
            Lado a lado: tendência, indicadores e oportunidade pelas regras de hoje.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {assets.length < 2 ? (
            <p className="text-sm text-muted-foreground py-10 text-center">Monitore pelo menos 2 ativos para poder comparar.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <AssetPicker badge="A" label="Ativo A" value={aId} onChange={onChangeA} assets={assets} placeholder="Escolha o ativo A" />
                <AssetPicker badge="B" label="Ativo B" value={bId} onChange={onChangeB} assets={assets} placeholder="Escolha o ativo B" />
              </div>

              {assetA && assetB ? (
                <ComparePanel
                  assetA={assetA}
                  assetB={assetB}
                  statesA={states.filter((s) => s.asset_id === assetA.id)}
                  statesB={states.filter((s) => s.asset_id === assetB.id)}
                  signalA={signals.find((s) => s.asset_id === assetA.id && s.source === 'range_filter')}
                  signalB={signals.find((s) => s.asset_id === assetB.id && s.source === 'range_filter')}
                  opA={ops.find((o) => o.asset_id === assetA.id && ACTIVE_STATUSES.includes(o.status))}
                  opB={ops.find((o) => o.asset_id === assetB.id && ACTIVE_STATUSES.includes(o.status))}
                  dataUnavailable={dataUnavailable}
                />
              ) : (
                <p className="text-sm text-muted-foreground py-10 text-center">Escolha os dois ativos para ver a comparação.</p>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
