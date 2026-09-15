import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { backend } from '@/api/entities';
import { classifySignal, phaseCopy, rejectionCopy, SIGNAL_PHASE } from '@/lib/signalStatus';

const OPEN_STATUSES = ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'];

/**
 * Bloco informativo, colapsado por padrão — "por que este aviso ainda não
 * virou operação?" — embutido sob uma linha de sinal em AssetDrawer.jsx e
 * Verification.jsx.
 *
 * Reescrito (conselho de revisão, 2026-09-15, docs/known-risks.md item 180).
 * A versão anterior refazia `fetchCandles` + `calculateRangeFilter` NO
 * NAVEGADOR para montar um checklist "ENTRADA LIBERADA/BLOQUEADA" —
 * duplicando parte da lógica de regime/confirmação que `src/lib/scanner.js`
 * já roda de verdade, sem replicar ADX/Chop/tier/candle-pattern/retest/
 * displacement (que mudam com `pineConfig` sem deploy). Com `regime_rejected`
 * sendo 69% das rejeições reais da cascata RF (`.claude/rules/
 * trading-engine.md`, item 50), o cenário mais provável era mostrar "ENTRADA
 * LIBERADA" quando o motor bloquearia por regime fraco — mesma classe de bug
 * já registrada e corrigida 2x antes (item 168, "UI reimplementando regra do
 * motor").
 *
 * Agora só LÊ o motivo que o motor já gravou
 * (`SignalEvent.last_rejection_reason`/`_detail`, via `rejectionCopy()` de
 * `src/lib/signalStatus.js`) — mesma fonte que `Trades.jsx`'s
 * `MonitoringCard` já usa para os avisos "Esperando confirmação". Zero
 * recálculo, zero I/O de mercado, zero divergência possível com o motor.
 *
 * A checagem de operação ativa abaixo é a ÚNICA que permanece local: é
 * presença simples sobre `tradeOps` (já buscado pelo componente pai), não
 * recomputa gate nenhum — e cobre um caso que `last_rejection_reason`
 * deliberadamente NÃO cobre (`active_op_exists` é contado no funil de
 * entrada mas nunca gravado no campo, ver trading-engine.md "Funil de
 * confirmação de entrada instrumentado").
 *
 * Props: passe `signal` quando o `SignalEvent` completo já estiver em mãos
 * (AssetDrawer.jsx — lista já buscada pelo componente pai). Passe
 * `signalEventId` quando só o id for conhecido (Verification.jsx — uma
 * `VerificationTask` guarda só um snapshot do sinal na criação, sem
 * `last_rejection_reason`/`_detail`, que só existem no `SignalEvent`
 * original); o componente busca o `SignalEvent` real sob demanda (só ao
 * expandir — mesmo padrão lazy-load da versão anterior, evita 1 leitura por
 * tarefa listada).
 */
export default function SignalChecklist({ signal = null, signalEventId = null, tradeOps = [] }) {
  const [expanded, setExpanded] = useState(false);
  const needsFetch = !signal && !!signalEventId;

  const { data: fetchedSignal, isLoading, error } = useQuery({
    queryKey: ['signal-checklist-signal', signalEventId],
    queryFn: () => backend.entities.SignalEvent.get(signalEventId),
    enabled: expanded && needsFetch,
    staleTime: 15000,
  });

  const effectiveSignal = signal ?? fetchedSignal ?? null;

  const hasActiveOp = effectiveSignal
    ? tradeOps.some(op => op.asset_id === effectiveSignal.asset_id && OPEN_STATUSES.includes(op.status))
    : false;

  let phase = null, copy = null, reason = null;
  if (effectiveSignal) {
    phase = classifySignal(effectiveSignal).phase;
    copy = phaseCopy(phase);
    reason = rejectionCopy(effectiveSignal, phase);
  }

  // Achado do Codex (review do PR #369): classifySignal() devolve INFO pra
  // QUALQUER timeframe fora de 4h (isConfirmationEligible só aceita '4h') —
  // com `blocked` derivado só da FASE, um sinal 1h/1d rejeitado (com
  // last_rejection_reason já mostrado acima) caía no "senão" e mostrava
  // ENTRADA LIBERADA verde, contradizendo o próprio motivo exibido. A
  // cascata SMC 1h→5m É real e pode virar operação (trading-engine.md), mas
  // replicar aqui QUAL timeframe tem cascata própria seria o mesmo
  // recálculo de regra do motor que este componente existe para evitar.
  //
  // Correção: `blocked` passa a olhar o DADO real (existe motivo gravado?
  // existe op ativa?) em vez da fase — funciona igual para qualquer
  // timeframe, sem precisar saber qual cascata cada um usa. EXPIRED
  // continua forçando bloqueado mesmo sem motivo salvo (item 175, sinal
  // expirado sem `last_rejection_reason` — o prazo fechou, é terminal).
  // O veredito só é OMITIDO (nem verde nem vermelho) quando não há dado
  // algum — sinal INFO nunca avaliado por gate nenhum, `hasKnownObstacle`
  // falso — mostra a mesma frase neutra que `Trades.jsx`'s `MonitoringCard`
  // já usa pra fase INFO, em vez de inventar um veredito sem lastro.
  const hasKnownObstacle = hasActiveOp || Boolean(effectiveSignal?.last_rejection_reason);
  const blocked = hasKnownObstacle || phase === SIGNAL_PHASE.EXPIRED;
  const showVerdict = hasKnownObstacle || phase !== SIGNAL_PHASE.INFO;

  return (
    <div className="mt-1.5">
      <button onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-1 text-[8px] font-mono px-2 py-1 rounded transition-all"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
        {expanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
        Por que ainda não virou operação?
      </button>

      {expanded && (
        <div className="mt-1.5 rounded-lg p-2.5 space-y-1.5" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
          {needsFetch && isLoading && (
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-muted-foreground py-2">
              <Loader2 className="w-3 h-3 animate-spin" />Buscando o aviso original...
            </div>
          )}
          {needsFetch && !isLoading && (error || !effectiveSignal) && (
            <div className="text-[9px] font-mono text-muted-foreground py-1">Não foi possível carregar o aviso original agora.</div>
          )}
          {effectiveSignal && (
            <>
              {hasActiveOp && (
                <div className="flex items-start gap-1.5 text-[9px] font-mono">
                  <span style={{ color: '#ff9f43' }}>·</span>
                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>Já existe uma operação ativa neste ativo — o motor não abre uma segunda.</span>
                </div>
              )}
              {reason && (
                <div className="text-[9px] font-mono">
                  <div className="font-semibold" style={{ color: copy?.color ?? 'rgba(255,255,255,0.6)' }}>
                    {reason.icon} {reason.chip}
                  </div>
                  <p className="mt-0.5 leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)' }}>{reason.detail}</p>
                </div>
              )}
              {showVerdict ? (
                <div className="pt-1.5 mt-1.5 flex items-center gap-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  {blocked ? <ShieldAlert className="w-3.5 h-3.5" style={{ color: '#ff1478' }} /> : <ShieldCheck className="w-3.5 h-3.5" style={{ color: '#00ff80' }} />}
                  <span className="text-[10px] font-mono font-bold" style={{ color: blocked ? '#ff1478' : '#00ff80' }}>
                    {blocked ? 'BLOQUEADA' : 'ENTRADA LIBERADA'}
                  </span>
                </div>
              ) : (
                <p className="text-[9px] font-mono leading-relaxed pt-1.5 mt-1.5" style={{ color: 'rgba(255,255,255,0.4)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  {copy?.reassurance}
                </p>
              )}
              <p className="text-[7px] font-mono text-muted-foreground/60 pt-0.5">
                Motivo lido direto do que o motor gravou ao avaliar este aviso — nenhum cálculo é refeito aqui.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
