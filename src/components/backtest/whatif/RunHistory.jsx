import React, { useState } from 'react';
import moment from 'moment';
import { Star, Trash2, Undo2, Info } from 'lucide-react';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { formatParams } from './params';
import { GREEN, RED, AMBER, BLUE, fmtR, fmtPct, Panel } from './ui';

// "O que eu já testei e o que deu melhor": cada combinação testada nesta janela (ativo + timeframe + candles) fica registrada sozinha, do melhor
// para o pior. Só testes da MESMA janela são comparáveis; os de outras janelas ficam à parte. Fica salvo neste navegador (não vai para o banco).
function Row({ run, rank, best, current, onUse, onStar, onRemove, showDataset = false }) {
  const s = run.summary;
  const exp = s.expectancyR;
  return (
    <li className="rounded-md px-3 py-2" style={{ background: current ? 'rgba(141,180,226,0.08)' : 'rgba(255,255,255,0.02)', border: `1px solid ${current ? 'rgba(141,180,226,0.3)' : 'rgba(255,255,255,0.05)'}` }}>
      <div className="flex items-start gap-2">
        <button onClick={onStar} aria-pressed={run.starred} aria-label={run.starred ? 'Tirar dos favoritos' : 'Marcar como favorito'} className="shrink-0 mt-0.5">
          <Star className="w-4 h-4" style={{ color: run.starred ? AMBER : 'rgba(255,255,255,0.35)', fill: run.starred ? AMBER : 'none' }} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            {rank != null && <span className="text-11px text-muted-foreground">#{rank}</span>}
            <span className="text-sm font-mono font-medium tabular-nums" style={{ color: exp === null ? undefined : exp >= 0 ? GREEN : RED }}>{fmtR(exp)}</span>
            {best && <span className="text-11px px-1.5 rounded" style={{ background: 'rgba(93,181,134,0.12)', color: GREEN }}>melhor até agora</span>}
            {current && <span className="text-11px px-1.5 rounded" style={{ background: 'rgba(141,180,226,0.15)', color: BLUE }}>em tela</span>}
          </div>
          <p className="text-11px font-mono text-foreground/75 break-words">{showDataset ? `${run.dataset.symbol} ${run.dataset.timeframe.toUpperCase()} ${run.dataset.candleCount}c${run.dataset.windowEnd ? ` · dados até ${moment(run.dataset.windowEnd).format('DD/MM HH:mm')}` : ''} · ` : ''}{formatParams(run.params)}</p>
          <p className="text-11px text-muted-foreground">{s.counted} op. · acerto {fmtPct(s.winRate, 0)} · PF {s.profitFactor === null || s.profitFactor === undefined ? '—' : s.profitFactor.toFixed(2)}{!s.conclusive && s.counted > 0 ? ' · amostra curta' : ''}</p>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <button onClick={onUse} disabled={current} className="flex items-center gap-1 text-11px px-2 py-1 rounded-md disabled:opacity-40" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)' }}>
            <Undo2 className="w-3 h-3" aria-hidden="true" />Usar
          </button>
          <button onClick={onRemove} aria-label="Apagar este teste" className="flex items-center justify-center text-11px px-2 py-1 rounded-md" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }}>
            <Trash2 className="w-3 h-3" aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  );
}

export default function RunHistory({ ranked, best, currentKey, currentRun = null, currentRank = -1, sortBy, onSort, overfit, saveFailed, reevalCount = 0, onReeval = () => {}, reevalMsg = null, onUse, onStar, onRemove, onClear }) {
  const [confirmClear, setConfirmClear] = useState(false);
  const total = ranked.same.length + ranked.others.length;
  return (
    <Panel className="space-y-3" aria-label="Histórico de testes">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-foreground/85">Seus testes</h3>
        <span className="text-xs text-muted-foreground">{total === 0 ? 'nenhum ainda' : `${ranked.same.length} nesta janela`}</span>
        {ranked.same.length > 1 && (
          <div className="ml-auto flex items-center rounded-md overflow-hidden" role="group" aria-label="Ordenar testes" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
            {[['expectancy', 'Melhores'], ['recent', 'Recentes']].map(([id, label], i) => (
              <button key={id} onClick={() => onSort(id)} aria-pressed={sortBy === id} className="text-11px px-2.5 py-1"
                style={{ borderLeft: i ? '1px solid rgba(255,255,255,0.08)' : 'none', ...(sortBy === id ? { background: 'rgba(141,180,226,0.12)', color: BLUE } : { background: 'rgba(255,255,255,0.02)', color: 'rgba(255,255,255,0.62)' }) }}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="text-11px text-muted-foreground">Cada combinação é registrada sozinha quando você <b className="font-medium text-foreground/80">solta o controle</b> (nada é gravado enquanto arrasta), com o resultado. Valores repetidos não duplicam: o teste é um só. Fica salvo neste navegador.</p>
      {currentKey && (
        <div className="rounded-md px-3 py-2 text-xs" role="status" aria-label="Este teste no histórico" style={{ background: 'rgba(141,180,226,0.08)', border: '1px solid rgba(141,180,226,0.25)' }}>
          {currentRun ? (
            <span className="text-foreground/85">
              <span style={{ color: BLUE }}>Em tela agora:</span> {sortBy === 'expectancy' ? <>#{currentRank + 1} de {ranked.same.length} · </> : null}
              <span className="font-mono tabular-nums" style={{ color: currentRun.summary.expectancyR === null ? undefined : currentRun.summary.expectancyR >= 0 ? GREEN : RED }}>{fmtR(currentRun.summary.expectancyR)}</span>
              {best?.key === currentRun.key && <span style={{ color: GREEN }}> · o melhor até agora</span>}
            </span>
          ) : (
            <span className="text-muted-foreground">Em tela agora: ainda não registrado — solte o controle e espere um instante.</span>
          )}
        </div>
      )}
      {reevalCount > 0 && (
        <div className="rounded-md px-3 py-2 space-y-1.5" style={{ background: 'rgba(141,180,226,0.06)', border: '1px solid rgba(141,180,226,0.2)' }}>
          <p className="text-11px text-foreground/80">Há {reevalCount} {reevalCount === 1 ? 'teste feito' : 'testes feitos'} em dados mais antigos deste mesmo ativo e período. Dá para rodar os mesmos parâmetros nos dados de agora e comparar de forma justa.</p>
          <button onClick={onReeval} className="text-xs px-3 py-1.5 rounded-md" style={{ background: 'rgba(141,180,226,0.12)', border: '1px solid rgba(141,180,226,0.3)', color: BLUE }}>
            Reavaliar nos dados atuais ({reevalCount})
          </button>
        </div>
      )}
      {reevalMsg && <p className="text-xs" style={{ color: GREEN }} role="status">{reevalMsg}</p>}
      {saveFailed && <p className="text-xs" style={{ color: AMBER }}>Não foi possível gravar neste navegador (armazenamento bloqueado ou cheio): o histórico some ao fechar a aba.</p>}
      {overfit && (
        <p className="text-xs rounded-md px-3 py-2 flex items-start gap-2" role="note" style={{ color: AMBER, background: 'rgba(221,154,74,0.06)', border: '1px solid rgba(221,154,74,0.2)' }}>
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>{overfit}</span>
        </p>
      )}

      {ranked.same.length === 0 ? (
        <p className="text-xs text-muted-foreground">Escolha um ativo e mexa nos parâmetros: os testes aparecem aqui, do melhor ao pior.</p>
      ) : (
        <ul className="space-y-2 max-h-[26rem] overflow-y-auto pr-1">
          {ranked.same.map((r, i) => (
            <Row key={r.key} run={r} rank={sortBy === 'expectancy' ? i + 1 : null} best={best?.key === r.key} current={r.key === currentKey}
              onUse={() => onUse(r)} onStar={() => onStar(r.key)} onRemove={() => onRemove(r.key)} />
          ))}
        </ul>
      )}

      {ranked.others.length > 0 && (
        <details className="rounded-md" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <summary className="px-3 py-2 text-xs cursor-pointer select-none text-foreground/75 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Testes em outras janelas de dados ({ranked.others.length})</summary>
          <ul className="space-y-2 p-2 max-h-80 overflow-y-auto">
            {ranked.others.map(r => <Row key={r.key} run={r} rank={null} best={false} current={false} showDataset onUse={() => onUse(r)} onStar={() => onStar(r.key)} onRemove={() => onRemove(r.key)} />)}
          </ul>
        </details>
      )}

      {total > 0 && (
        <button onClick={() => setConfirmClear(true)} className="text-11px text-muted-foreground underline underline-offset-2 hover:text-foreground">Apagar todo o histórico</button>
      )}
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar todo o histórico de testes?</AlertDialogTitle>
            <AlertDialogDescription>{total === 1 ? 'O 1 teste salvo' : `Os ${total} testes salvos`} neste navegador, inclusive os favoritos, {total === 1 ? 'será apagado' : 'serão apagados'}. Não dá para desfazer.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction destructive onClick={onClear}>Apagar tudo</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}
