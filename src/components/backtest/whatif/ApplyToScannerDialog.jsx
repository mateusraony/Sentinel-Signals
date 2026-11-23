import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { buildScannerPlan, appliable, applyWarnings } from '@/lib/whatIfApply';
import { AMBER, BLUE } from './ui';

// "Aplicar ao scanner AO VIVO" a partir do Ajuste Fino: o USUÁRIO ESCOLHE, parâmetro por parâmetro, o que vai para o scanner (a tela nunca decide por ele). Lê a configuração ao vivo
// AGORA (leitura fresca do banco: cópia guardada/padrões não valem) e mostra, para cada parâmetro, o valor atual do scanner → o valor desta tela. Só os que DIFEREM têm caixinha
// (vêm marcados os globais; o Range Filter, que é por ativo, vem desmarcado). Só grava depois do clique em "Aplicar", e só o que está marcado (a gravação é feita pela tela).
// Valor para o usuário ler: ligado/desligado em vez de true/false, e travessão quando não há valor.
const fmt = (v) => (v === true ? 'ligado' : v === false ? 'desligado' : v === undefined || v === null ? '—' : String(v));

export default function ApplyToScannerDialog({ open, onOpenChange, params, defaults, asset, summary, testedCount, getLive, onApply }) {
  const [live, setLive] = useState(null); // null = lendo; 'erro' = não foi possível ler; objeto = configuração ao vivo
  const [chosen, setChosen] = useState(() => new Set());

  useEffect(() => {
    if (!open) { setLive(null); setChosen(new Set()); return undefined; }
    let cancelled = false;
    Promise.resolve(getLive()).then((cfg) => { if (!cancelled) setLive(cfg); }).catch(() => { if (!cancelled) setLive('erro'); });
    return () => { cancelled = true; };
  }, [open, getLive]);

  const plan = useMemo(
    () => (live && live !== 'erro' ? buildScannerPlan({ params, defaults, live, asset }) : null),
    [params, defaults, live, asset],
  );
  // Ao chegar a leitura: marca por padrão os globais que diferem (o Range Filter por ativo fica desmarcado até o usuário marcar).
  useEffect(() => {
    if (plan) setChosen(new Set(appliable(plan).filter((i) => i.scope === 'global').map((i) => i.id)));
  }, [plan]);

  const warnings = useMemo(() => applyWarnings({ summary, testedCount }), [summary, testedCount]);
  const canChange = plan ? appliable(plan) : [];
  const chosenCount = canChange.filter((i) => chosen.has(i.id)).length;
  const toggle = (id) => setChosen((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setAll = (on) => setChosen(on ? new Set(canChange.filter((i) => i.scope === 'global').map((i) => i.id)) : new Set());

  const renderRow = (item) => (
    <li key={item.id} className="flex items-start gap-2">
      <input type="checkbox" className="mt-0.5" aria-label={item.label} disabled={!item.differs} checked={item.differs && chosen.has(item.id)} onChange={() => toggle(item.id)} />
      <span className={item.differs ? '' : 'text-muted-foreground'}>
        {item.label}:{' '}
        {item.differs
          ? <span className="font-mono"><span className="text-muted-foreground">{fmt(item.from)}</span> → <span className="font-semibold" style={{ color: BLUE }}>{fmt(item.to)}</span></span>
          : <span className="font-mono">{fmt(item.to)} <span className="font-sans">(igual ao scanner)</span></span>}
      </span>
    </li>
  );
  const globalItems = plan ? plan.items.filter((i) => i.scope === 'global') : [];
  const assetItems = plan ? plan.items.filter((i) => i.scope === 'asset') : [];
  const globalDiffer = globalItems.filter((i) => i.differs);
  const globalSame = globalItems.filter((i) => !i.differs);
  const assetDiffer = assetItems.filter((i) => i.differs);
  const assetSame = assetItems.filter((i) => !i.differs);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Escolha o que aplicar ao scanner AO VIVO</AlertDialogTitle>
          <AlertDialogDescription>
            Marque só o que você quer levar para o scanner. Vale a partir do próximo scan, para todos os ativos. Você pode voltar aqui e mudar quando quiser. Nenhuma ordem é enviada.
          </AlertDialogDescription>
          <div className="text-xs text-foreground/80 space-y-3 text-left" aria-live="polite">
            {live === 'erro' ? (
              <p style={{ color: AMBER }}>Não foi possível ler a configuração atual do scanner para comparar — por segurança não dá para aplicar agora. Tente de novo em instantes.</p>
            ) : live === null ? (
              <p className="text-muted-foreground">Lendo a configuração atual do scanner…</p>
            ) : plan ? (
              <>
                {canChange.length === 0 ? (
                  <p>Nenhum parâmetro desta tela difere do scanner agora: não há o que aplicar.</p>
                ) : (
                  <div className="flex items-center gap-3 flex-wrap">
                    <p className="font-medium">{canChange.length} {canChange.length === 1 ? 'parâmetro difere' : 'parâmetros diferem'} do scanner — escolha:</p>
                    <button type="button" className="underline underline-offset-2 text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>marcar todos</button>
                    <button type="button" className="underline underline-offset-2 text-muted-foreground hover:text-foreground" onClick={() => setAll(false)}>desmarcar todos</button>
                  </div>
                )}
                {globalDiffer.length > 0 && <ul className="space-y-1.5" aria-label="Parâmetros do scanner">{globalDiffer.map(renderRow)}</ul>}
                {assetDiffer.length > 0 && (
                  <div className="rounded-md px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <p className="font-medium mb-1">Só deste ativo ({asset?.symbol ?? 'ativo'}) — o Range Filter é por ativo (vem desmarcado):</p>
                    <ul className="space-y-1.5">{assetDiffer.map(renderRow)}</ul>
                  </div>
                )}
                {(globalSame.length + assetSame.length) > 0 && (
                  <details className="rounded-md" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <summary className="px-3 py-1.5 cursor-pointer select-none text-muted-foreground">Já iguais ao scanner ({globalSame.length + assetSame.length}) — nada a aplicar</summary>
                    <ul className="space-y-1.5 px-3 pb-2 pt-1" aria-label="Parâmetros já iguais ao scanner">{[...globalSame, ...assetSame].map(renderRow)}</ul>
                  </details>
                )}
                {plan.blocked.length > 0 && (
                  <div className="rounded-md px-3 py-2" style={{ background: 'rgba(221,154,74,0.07)', border: '1px solid rgba(221,154,74,0.25)' }}>
                    <p className="font-medium" style={{ color: AMBER }}>Não dá para aplicar ao scanner:</p>
                    <ul className="space-y-1 mt-1">
                      {plan.blocked.map((b) => <li key={b.key}><span className="font-medium">{b.label}</span> — {b.why}</li>)}
                    </ul>
                  </div>
                )}
                <ul className="space-y-1 list-disc pl-4 text-muted-foreground">
                  {warnings.map((w) => <li key={w}>{w}</li>)}
                  <li>Se você salvar o Pine Script depois, a configuração volta aos valores do código.</li>
                </ul>
              </>
            ) : null}
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction disabled={!plan || chosenCount === 0} onClick={() => plan && onApply(plan, new Set(chosen))}>
            {chosenCount > 0 ? `Aplicar ${chosenCount} ${chosenCount === 1 ? 'escolhido' : 'escolhidos'}` : 'Aplicar escolhidos'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
