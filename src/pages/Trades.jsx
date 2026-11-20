import TokenIcon from '@/components/TokenIcon';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { MANUAL_EDIT_REASON, MANUAL_CLOSE_REASON, MANUAL_INVALIDATE_REASON } from '@/lib/operationProvenance';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { Link } from 'react-router-dom';
import {
  Loader2, Target, History, XCircle, Eye, AlertTriangle,
  BarChart2, Edit3, X, ChevronDown, ChevronUp
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import TradeCard, { ScoreBar } from '@/components/dashboard/TradeCard';
import TradeEntryMarkers from '@/components/trades/TradeEntryMarkers';
import PortfolioVsMarket from '@/components/trades/PortfolioVsMarket';
import PerformanceReport from '@/components/trades/PerformanceReport';
import TradesNowSummary from '@/components/trades/TradesNowSummary';
import TradesFilterBar from '@/components/trades/TradesFilterBar';
import OpEventMarker from '@/components/trades/OpEventMarker';
import { useOperationEvents } from '@/hooks/useOperationEvents';
import { EMPTY_FILTERS, applyTradeFilters, countActiveFilters, summarizeActiveOps } from '@/lib/tradesOverview';
import { timeframeChipLabel } from '@/lib/tradeStory';
import { formatSignedR } from '@/lib/stopGuarantee';
import { formatBackfillLag } from '@/lib/backfillDetection';
import { outcomeColor } from '@/lib/outcomeColor';
import { describeProximity, formatPrice, formatSignedPct, formatQuoteAge } from '@/lib/priceProximity';
import { classifySignal, phaseCopy, rejectionCopy, formatTimeLeft, REASON_KIND, SIGNAL_PHASE } from '@/lib/signalStatus';
import { signalTimeline, opTimeline, closedReasonLabel } from '@/lib/eventTimeline';
import { EventTimeline, fmtBRT } from '@/components/dashboard/EventTimeline';
import { QueryErrorState } from '@/components/QueryErrorState';
import { useLivePrice } from '@/hooks/useLivePrice';
import moment from 'moment';
import { isClosedOp, getExitPrice, calcRealizedPnlPct, calcRealizedR, classifyOutcome, summarizeOps } from '@/lib/tradeMetrics';
import { logError } from '@/lib/logger';
import { POLL_OPERATIONAL_MS } from '@/lib/pollingIntervals';
import { buildManualCloseSnapshot } from '@/lib/decisionSnapshot';
import { explainDecision, explainOperationDecision, legacyClosedOperationText } from '@/lib/decisionExplanation';
import { useAllMonitoredAssets } from '@/hooks/useAllMonitoredAssets';

const ACTIVE_STATUSES = ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'];
/** Quantas operações (ativas + fechadas) a página pede ao banco. A lista do histórico avisa quando bate nesse teto. */
const OPERATIONS_PAGE_SIZE = 100;

/** Modal for editing an active operation */
function EditModal({ op, onClose, onSave }) {
  const [stop, setStop] = useState(op.current_stop ?? '');
  const [tp1, setTp1] = useState(op.tp1 ?? '');
  const [tp2, setTp2] = useState(op.tp2 ?? '');
  const [status, setStatus] = useState(op.status ?? 'SIGNAL_CONFIRMED');
  const [exitPrice, setExitPrice] = useState(op.exit_price ?? '');

  const fieldStyle = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: 'rgba(255,255,255,0.85)',
    outline: 'none',
  };

  return (
    <Dialog open={!!op} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-sm p-5 rounded-2xl"
        style={{ background: 'rgba(10,13,22,0.98)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 0 40px rgba(0,0,0,0.5)' }}>
        <DialogHeader>
          <DialogTitle className="font-bold text-sm text-foreground text-left flex items-center gap-2"><TokenIcon symbol={op.symbol} size={18} />{op.symbol?.replace('USDT', '/USDT')}</DialogTitle>
          <div className="text-9px font-mono text-muted-foreground">{op.timeframe?.toUpperCase()} · {op.side}</div>
        </DialogHeader>

        <div className="space-y-3">
          {/* Status manual */}
          <div>
            <label className="text-9px font-mono mb-1 block" style={{ color: '#00e5ff' }}>Status Manual</label>
            <select value={status} onChange={e => setStatus(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-xs font-mono"
              style={fieldStyle}>
              <option value="SIGNAL_CONFIRMED">SIGNAL_CONFIRMED — Entrada confirmada, aguardando TP1</option>
              <option value="RUNNER_ACTIVE">RUNNER_ACTIVE — TP1 atingido, runner ativo</option>
              <option value="TP2_HIT">TP2_HIT — TP2 atingido (win)</option>
              <option value="STOP_HIT">STOP_HIT — Stop atingido</option>
              <option value="INVALIDATED">INVALIDATED — Invalidado</option>
              <option value="CLOSED">CLOSED — Encerrado manualmente</option>
            </select>
          </div>

          {/* Preço de saída (para status terminais) */}
          {['TP2_HIT','STOP_HIT','INVALIDATED','CLOSED'].includes(status) && (
            <div>
              <label className="text-9px font-mono mb-1 block" style={{ color: '#ffd166' }}>Preço de Saída (exit_price)</label>
              <input type="number" step="any" value={exitPrice} onChange={e => setExitPrice(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-xs font-mono" style={fieldStyle} />
            </div>
          )}

          {[
            { label: 'Stop Atual', value: stop, set: setStop, color: '#ff1478' },
            { label: 'TP1', value: tp1, set: setTp1, color: '#ffd166' },
            { label: 'TP2', value: tp2, set: setTp2, color: '#00ff80' },
          ].map(({ label, value, set, color }) => (
            <div key={label}>
              <label className="text-9px font-mono mb-1 block" style={{ color }}>{label}</label>
              <input type="number" step="any" value={value} onChange={e => set(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-xs font-mono" style={fieldStyle} />
            </div>
          ))}
        </div>

        {/* Item 278 (PR-C): editar não passa pelo motor. */}
        <p className="text-9px font-mono leading-relaxed" style={{ color: '#ffd166' }}>
          Salvar altera o registro desta operação, e o motor passa a usar os valores novos. Só o
          encerramento por aqui deixa a marca &quot;encerrada à mão&quot; (sai da medição do motor); mudar
          status, stop ou alvos sem encerrar não deixa marca.
        </p>

        <div className="flex gap-2 pt-1">
          <button onClick={onClose}
            className="flex-1 py-2 rounded-lg text-10px font-mono transition-all"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
            Cancelar
          </button>
          <button
            onClick={() => {
              // Firestore's updateDoc rejects `undefined` field values and
              // throws — clearing a field must omit the key entirely, not
              // send it as undefined (was silently failing the whole save).
              const data = { status };
              if (stop) data.current_stop = parseFloat(stop);
              if (tp1) data.tp1 = parseFloat(tp1);
              if (tp2) data.tp2 = parseFloat(tp2);
              if (exitPrice) data.exit_price = parseFloat(exitPrice);
              if (['TP2_HIT','STOP_HIT','INVALIDATED','CLOSED'].includes(status)) {
                data.closed_at = new Date().toISOString();
                data.closed_reason = MANUAL_EDIT_REASON;
              }
              if (status === 'RUNNER_ACTIVE') data.tp1_hit = true;
              onSave(data);
            }}
            className="flex-1 py-2 rounded-lg text-10px font-mono font-bold transition-all"
            style={{ background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }}>
            Salvar Alterações
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Monitoring card */
/**
 * Card de aviso em análise — reescrito em 2026-09-05 (item 156).
 *
 * Um teste de usabilidade com persona leiga leu a versão anterior como uma
 * ORDEM DE COMPRA ("o app mandou comprar BTC") quando a resposta certa era
 * "não faça nada". Três causas, todas endereçadas aqui:
 *  1. o elemento mais forte (badge BUY/SELL) era idêntico nos 3 estados, e o
 *     que os diferenciava vivia em 8px cinza no rodapé → estado virou o badge
 *     dominante, direção virou texto discreto;
 *  2. nenhuma das frases dizia quem age → toda fase agora traz a linha de
 *     "você não precisa fazer nada" (src/lib/signalStatus.js);
 *  3. os dois preços e o score não tinham rótulo visível (só `title=`, que
 *     morre no toque) → rótulos na tela, e o score reusa a ScoreBar do card
 *     de operação, que já carrega a ressalva "não é probabilidade de acerto".
 */
function MonitoringCard({ signal, asset = null, onDismiss, isDismissing, expandAll = false }) {
  const [showDetails, setShowDetails] = useState(expandAll);
  // Refinamentos (seção E): mesmo padrão de sincronização já usado em
  // TradeCard.jsx (open/expandAll) — sem isso, o toggle Compacto/Detalhado
  // da página não tinha efeito nenhum sobre estes cards.
  useEffect(() => { setShowDetails(expandAll); }, [expandAll]);
  const { price, isStale } = useLivePrice(signal.symbol);

  const { phase, msLeft, expiresAt } = classifySignal(signal, Date.now(), asset);
  const copy = phaseCopy(phase);
  const reason = rejectionCopy(signal, phase);
  // Achado de clareza (pedido do usuário, 2026-09-18): esta seção só usava
  // rejectionCopy() — a frase categórica ("força do movimento insuficiente")
  // sem o número medido por trás. explainDecision (Fase 1 do Explainability
  // V2, já consumida por Dashboard/SignalChecklist) traduz
  // decision_snapshot.facts em "ADX 18 — mínimo exigido 22"; nada novo é
  // medido, só reconectado aqui. Fail-closed: evidence fica null quando o
  // snapshot não descreve o motivo ATUAL (ver decisionExplanation.js).
  const evidence = explainDecision(signal, { asset }).evidence;
  const isBuy = signal.signal_type === 'BUY';
  const timeLeft = formatTimeLeft(msLeft);

  const { unrealizedPct } = describeProximity(
    { side: signal.signal_type, entry_price: signal.price_at_signal }, price);
  const moveColor = unrealizedPct === null ? 'rgba(255,255,255,0.35)' : unrealizedPct >= 0 ? '#00ff80' : '#ff1478';

  // Já passou: uma linha discreta, com saída. Antes ficava com o mesmo peso
  // visual de um aviso vivo e só sumia quando 50 sinais novos o empurravam.
  if (phase === SIGNAL_PHASE.EXPIRED) {
    return (
      <div className="rounded-xl px-3 py-2.5 flex items-start gap-2"
        style={{ background: 'rgba(12,15,26,0.5)', border: '1px solid rgba(255,255,255,0.05)', borderLeft: `3px solid ${copy.color}` }}>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <TokenIcon symbol={signal.symbol} size={16} />
            <span className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.6)' }}>
              {signal.symbol?.replace('USDT', '/USDT')}
            </span>
            <span className="text-9px font-mono" style={{ color: 'rgba(255,255,255,0.3)' }}>
              {isBuy ? 'alta' : 'baixa'}
            </span>
            <span className="text-9px font-mono px-1.5 py-0.5 rounded"
              style={{ background: `${copy.color}1a`, color: copy.color, border: `1px solid ${copy.color}40` }}>
              {copy.icon} {copy.badge}
            </span>
          </div>

          <p className="text-10px font-mono leading-relaxed" style={{ color: 'rgba(255,255,255,0.4)' }}>
            {copy.reassurance}
          </p>

          {/* O QUE O SISTEMA NÃO GOSTOU. Antes o card expirado só dizia que
              nada foi aberto e engolia o motivo — que estava ali, em
              last_rejection_reason. Pedido do usuário, item 161. */}
          <div className="rounded-lg px-2 py-1.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="text-9px font-mono font-semibold" style={{ color: 'rgba(255,255,255,0.5)' }}>
              {reason.icon} O que travou: {reason.chip}
            </div>
            <p className="text-9px font-mono leading-relaxed mt-0.5" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {reason.detail}
            </p>
            {evidence && (
              <p className="text-9px font-mono leading-relaxed mt-1 opacity-70" style={{ color: 'rgba(0,229,255,0.6)' }}>
                📐 {evidence}
              </p>
            )}
          </div>

          <EventTimeline events={signalTimeline(signal, { asset })} title={null} />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={() => onDismiss?.(signal)} disabled={isDismissing}
              aria-label="Tirar este aviso da lista"
              className="shrink-0 p-1 rounded-lg transition-colors hover:bg-white/[0.06]">
              <X className="w-3.5 h-3.5" style={{ color: 'rgba(255,255,255,0.35)' }} />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
            Tirar este aviso da lista
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-4 space-y-3"
      style={{
        background: 'rgba(12,15,26,0.75)', backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.06)', borderLeft: `3px solid ${copy.color}`,
      }}>
      {/* 1 · Identidade — e o ESTADO como elemento dominante, não a direção */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold text-sm text-foreground truncate flex items-center gap-2"><TokenIcon symbol={signal.symbol} size={18} />{signal.symbol?.replace('USDT', '/USDT')}</div>
          <div className="text-10px font-mono mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>
            {isBuy ? 'Aviso de alta (compra)' : 'Aviso de baixa (venda)'} · {moment(signal.created_date).fromNow()}
          </div>
          {/* Horário absoluto ao lado do relativo: "há 2 horas" não serve
              para conferir nada depois (item 161). */}
          <div className="text-9px font-mono" style={{ color: 'rgba(255,255,255,0.28)' }}>
            apareceu {fmtBRT(signal.created_date)} BRT
          </div>
        </div>
        <span className="text-10px font-mono px-2 py-0.5 rounded shrink-0 font-semibold"
          style={{ background: `${copy.color}1a`, color: copy.color, border: `1px solid ${copy.color}45` }}>
          {copy.icon} {copy.badge}
        </span>
      </div>

      {/* 2 · Preço agora — rotulado. Antes eram dois números sem legenda. */}
      <div className="flex items-end justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-lg font-mono font-bold leading-none truncate"
            style={{ color: price === null ? 'rgba(255,255,255,0.35)' : isStale ? '#ff9f43' : 'rgba(255,255,255,0.95)' }}>
            {price !== null ? `$${formatPrice(price)}` : '—'}
          </div>
          <div className="text-9px font-mono uppercase tracking-widest mt-1"
            style={{ color: isStale ? '#ff9f43' : 'rgba(255,255,255,0.35)' }}>
            {isStale ? 'preço desatualizado' : 'preço agora'}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-11px font-mono" style={{ color: 'rgba(255,255,255,0.5)' }}>
            avisou em ${formatPrice(signal.price_at_signal)}
          </div>
          {unrealizedPct !== null && (
            <div className="text-10px font-mono font-bold" style={{ color: moveColor, opacity: isStale ? 0.55 : 1 }}>
              {formatSignedPct(unrealizedPct)} a favor do aviso
            </div>
          )}
        </div>
      </div>

      {/* 3 · O que falta — chip curto + frase que termina em "nada a fazer".
          Omitido no aviso INFO sem motivo salvo: a linha 4 já diz que ele
          não vira operação (achado do Codex, review do PR #502). */}
      {reason.kind !== REASON_KIND.INFO && (
      <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <div className="text-10px font-mono font-semibold" style={{ color: copy.color }}>
            {reason.icon} {reason.chip}
          </div>
          {/* "desde", não "às": o motor só recarimba quando o MOTIVO muda
              (item 163) — é há quanto tempo o aviso está preso nisto, o que
              é justamente o que o usuário quer comparar depois. */}
          {signal.last_rejection_at && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-9px font-mono shrink-0 cursor-help" tabIndex={0} style={{ color: 'rgba(255,255,255,0.3)' }}>
                  desde {fmtBRT(signal.last_rejection_at)}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
                Desde quando este aviso está travado neste mesmo motivo (horário de Brasília)
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <p className="text-10px font-mono leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>
          {reason.detail}
        </p>
        {evidence && (
          <p className="text-9px font-mono leading-relaxed mt-1 opacity-70" style={{ color: 'rgba(0,229,255,0.6)' }}>
            📐 {evidence}
          </p>
        )}
      </div>
      )}

      {/* 4 · Quem age, e até quando */}
      <p className="text-10px font-mono leading-relaxed" style={{ color: 'rgba(255,255,255,0.45)' }}>
        {copy.reassurance}
        {phase === SIGNAL_PHASE.WAITING && expiresAt && timeLeft
          ? ` Prazo: até ${moment(expiresAt).utcOffset(-3).format('DD/MM [às] HH[h]mm')} (faltam ${timeLeft}).`
          : ''}
      </p>

      {/* 5 · O técnico, a um clique */}
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setShowDetails(!showDetails)}
          aria-expanded={showDetails}
          className="flex items-center gap-1 text-10px font-mono transition-colors hover:text-foreground/70"
          style={{ color: 'rgba(255,255,255,0.35)' }}>
          {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          Detalhes técnicos
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={() => onDismiss?.(signal)} disabled={isDismissing}
              className="text-10px font-mono px-2 py-1 rounded-lg transition-colors hover:bg-white/[0.06]"
              style={{ color: 'rgba(255,255,255,0.3)' }}>
              Dispensar
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
            Tirar este aviso da lista
          </TooltipContent>
        </Tooltip>
      </div>

      {showDetails && (
        <div className="space-y-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="text-9px font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>
            Gráfico de {signal.timeframe?.toUpperCase()}
          </div>
          <EventTimeline events={signalTimeline(signal, { asset })} />
          {/* Auditoria do Telegram (2026-09-29), item 1.11 — só RF carrega
              score real; sem esse guard, um sinal SMC/MACD/EMA/RSI mostrava
              a barra em "〰 Fraco" como se tivesse confluência baixa medida,
              quando na verdade essa fonte não usa score. */}
          {signal.context?.score > 0 && <ScoreBar score={signal.context.score} />}
          {signal.reason && (
            <p className="text-9px font-mono leading-relaxed" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {signal.reason}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Linha do histórico — refeita em 14/11/2026 (docs/known-risks.md item 304). Antes a data e os preços sumiam no celular
 * (`hidden sm:block`), o selo dizia só o gráfico da entrada ("15M") e o resultado vinha sem o R. Agora, em qualquer tela:
 * o que foi, quanto deu (% e R), quando abriu e fechou (e quanto durou), por onde entrou e saiu, e o porquê.
 */
function HistoryRow({ op, eventCtx = null }) {
  const isBuy = op.side === 'BUY';
  const exitPrice = getExitPrice(op);
  const pnlPct = calcRealizedPnlPct(op);
  const realizedR = calcRealizedR(op);
  const outcome = classifyOutcome(op);
  // O selo do stop segue o RESULTADO, não só o fato de ter batido no stop: stop elevado que fechou no lucro aparecia como
  // "🛑 Stop" vermelho ao lado de um +2,86% verde (mesma regra de cor do resto do app, `outcomeColor`).
  const stopLabel = outcome === 'WIN' ? '💰 Stop com lucro' : outcome === 'BE' ? '🟡 BE' : '🛑 Stop';

  const STATUS_MAP = {
    TP2_HIT:     { label: '🏆 TP2', color: '#00ff80' },
    STOP_HIT:    { label: stopLabel, color: outcomeColor('STOP_HIT', outcome) },
    INVALIDATED: { label: '⚠ Invalidada', color: '#ff9f43' },
    CLOSED:      { label: '✗ Encerrada', color: '#64748b' },
  };
  const s = STATUS_MAP[op.status] || { label: op.status, color: '#64748b' };
  const eventos = opTimeline(op);
  const fechamento = eventos.length > 1 ? eventos[eventos.length - 1] : null;
  const motivo = closedReasonLabel(op);
  const tfChip = timeframeChipLabel(op);
  const openedMs = new Date(op.created_date).getTime();
  const closedMs = fechamento ? new Date(fechamento.at).getTime() : NaN;
  const duration = Number.isFinite(openedMs) && Number.isFinite(closedMs) && closedMs >= openedMs
    ? formatBackfillLag(closedMs - openedMs)
    : null;
  const pnlColor = pnlPct === null ? 'rgba(255,255,255,0.5)' : pnlPct >= 0 ? '#00ff80' : '#ff1478';

  // Achado de clareza (pedido do usuário, 2026-09-18): esta era a seção mais
  // vaga de todas — nenhum "por quê" visível, só o status de 1-2 palavras +
  // o motivo escondido num `title=` (tooltip que morre no toque em mobile,
  // mesmo antipadrão já corrigido em MonitoringCard pelo item 156). Reusa a
  // mesma explicação (Fase 4) que TradeHistory.jsx/TradeCard.jsx já mostram
  // — nada novo é medido, só reconectado aqui.
  const decisionOut = op.decision_snapshot?.decision === 'EXIT' ? explainOperationDecision(op) : null;
  const whyText = decisionOut?.why ?? legacyClosedOperationText(op, pnlPct, outcome, motivo);

  return (
    <div className="rounded-xl px-4 py-3 flex flex-col gap-1.5" data-history-row={op.id}
      style={{ background: 'rgba(12,15,26,0.55)', border: '1px solid rgba(255,255,255,0.05)', borderLeft: `3px solid ${s.color}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <TokenIcon symbol={op.symbol} size={16} />
          <span className="font-semibold text-sm text-foreground shrink-0">{op.symbol?.replace('USDT', '/USDT')}</span>
          <span className="text-9px font-mono font-bold px-1.5 py-0.5 rounded"
            style={{ color: isBuy ? '#00ff80' : '#ff1478', background: isBuy ? 'rgba(0,255,128,0.1)' : 'rgba(255,20,120,0.1)' }}>
            {op.side}
          </span>
          {tfChip && <span className="text-9px font-mono text-muted-foreground">{tfChip}</span>}
          <span className="text-10px font-mono font-semibold" style={{ color: s.color }}>{s.label}</span>
        </div>
        {pnlPct !== null && (
          <div className="text-right shrink-0 leading-tight">
            <div className="text-sm font-mono font-bold" style={{ color: pnlColor }}>
              {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
            </div>
            {realizedR !== null && (
              <div className="text-9px font-mono" style={{ color: 'rgba(255,255,255,0.45)' }}>{formatSignedR(realizedR)}</div>
            )}
          </div>
        )}
      </div>
      {/* Aberta -> fechada, ambos absolutos (item 161) e agora visíveis também no celular, com a duração. */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-9px font-mono text-muted-foreground">
        <span>
          Aberta {fmtBRT(op.created_date)}
          {fechamento ? ` → fechada ${fmtBRT(fechamento.at)}` : ''}
          {duration ? ` (${duration})` : ''}
        </span>
        <span>
          Entrada ${formatPrice(op.entry_price)}
          {exitPrice ? ` → saída $${formatPrice(exitPrice)}` : ''}
        </span>
      </div>
      {/* Fase 5 do Contexto (item 285): só aparece se a operação ficou aberta durante CPI, Payroll ou FOMC e há dado confiável. Correlação, nunca causa. */}
      <OpEventMarker op={op} ctx={eventCtx} />
      <p className="text-9px font-mono leading-relaxed line-clamp-2" style={{ color: 'rgba(255,255,255,0.5)' }}>
        💡 {whyText}
      </p>
    </div>
  );
}

/**
 * "Atualizado há …" do cabeçalho. Tem o próprio relógio (1 s) de propósito: antes o `setInterval` ficava dentro de `Trades()` e a
 * página inteira era redesenhada a cada segundo. Escrita com `formatQuoteAge` ("25min", "3h"): com a tela atualizando a cada
 * 30 min (item 301) um "há 1543s" não se lê.
 */
function UpdatedAgo({ dataUpdatedAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!dataUpdatedAt) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [dataUpdatedAt]);
  const age = dataUpdatedAt ? formatQuoteAge(Math.max(0, now - dataUpdatedAt)) : null;
  return (
    <span className="flex items-center gap-1.5">
      <span className="live-dot" style={{ width: 5, height: 5 }} />
      <span className="text-muted-foreground">{age ? `Atualizado há ${age}` : 'Carregando…'}</span>
    </span>
  );
}

export default function Trades() {
  const [showHistory, setShowHistory] = useState(false);
  const eventCtx = useOperationEvents({ enabled: showHistory });
  const [showInfoSignals, setShowInfoSignals] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showChart, setShowChart] = useState(true);
  // Item 304: os 4 filtros num estado só; a regra (inclusive o recorte de período) mora em src/lib/tradesOverview.js.
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [editingOp, setEditingOp] = useState(null);
  /** @type {[{ op: object, action: 'invalidate' | 'close' } | null, Function]} */
  const [confirmingOp, setConfirmingOp] = useState(null);
  const queryClient = useQueryClient();
  const clearFilters = () => setFilters(EMPTY_FILTERS);

  // Reset filters on global event
  useEffect(() => {
    const handler = () => setFilters(EMPTY_FILTERS);
    window.addEventListener('app-reset-filters', handler);
    return () => window.removeEventListener('app-reset-filters', handler);
  }, []);

  const { data: operations = [], isLoading, isError, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['trade-operations'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', OPERATIONS_PAGE_SIZE),
    refetchInterval: POLL_OPERATIONAL_MS,
  });

  // Fase 5 da auditoria do Telegram (2026-10-02), item 5.4 — abre direto a
  // operação que a mensagem do Telegram apontou (`?id=`), em vez de só a
  // lista genérica. Mesmo guard de 1x-por-carregamento de Alerts.jsx — sem
  // ele, o polling de `operations` (POLL_OPERATIONAL_MS) reabriria o modal
  // sempre que o usuário o fechasse manualmente.
  const appliedDeepLink = useRef(false);
  useEffect(() => {
    if (appliedDeepLink.current) return;
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) { appliedDeepLink.current = true; return; }
    if (operations.length === 0) return;
    const match = operations.find(op => op.id === id);
    if (match) setEditingOp(match);
    appliedDeepLink.current = true;
  }, [operations]);

  const { data: recentSignals = [], isError: signalsError, refetch: refetchSignals } = useQuery({
    queryKey: ['recent-signals'],
    queryFn: () => backend.entities.SignalEvent.list('-created_date', 50),
    refetchInterval: POLL_OPERATIONAL_MS,
  });

  // Item 276 — o ativo decide se um aviso ainda pode virar operação (o motor
  // reconfere `smc_enabled`, os timeframes ligados e só escaneia ativo ativo).
  // Enquanto a lista carrega ou se ela falhar, a regra cai no padrão da emissão.
  const { data: monitoredAssets = [] } = useAllMonitoredAssets();
  const assetById = useMemo(() => new Map(monitoredAssets.map(a => [a.id, a])), [monitoredAssets]);

  // As 3 mutações abaixo passam pela MESMA CAS transacional
  // (backend.tradeOps.transitionTradeOp) usada pelos dois loops do scanner —
  // nunca backend.entities.TradeOperation.update() direto, que sobrescreveria
  // o status sem checar se a op ainda está no estado lido (regra em
  // .claude/rules/trading-engine.md: "não introduza um terceiro caminho de
  // mutação de op"). `fromStatus` é o status do `op` no momento do clique
  // (pode ter até 15s de defasagem — refetchInterval da query acima); se o
  // scanner já tiver mudado a op nesse meio-tempo, a transação rejeita
  // (`applied: false`) em vez de aplicar um patch stale por cima.
  /** @param {object} op */
  function manualTransition(op, patch) {
    return backend.tradeOps.transitionTradeOp(op.id, op.status, patch, {
      assetId: op.asset_id,
      cascade: op.hierarchical_cascade === true ? op.cascade : undefined,
    }).then(({ applied, currentStatus }) => {
      if (!applied) {
        throw new Error(`A operação já mudou de status (agora: ${currentStatus ?? 'desconhecido'}) — atualize a lista e tente de novo.`);
      }
    });
  }

  // Mesma mutacao de Alerts.jsx — o campo ja existe no schema e ja e
  // respeitado pelo motor; faltava so o botao aqui.
  const dismissSignalMutation = useMutation({
    mutationFn: (signal) => backend.entities.SignalEvent.update(signal.id, { is_dismissed: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recent-signals'] }),
    onError: (err) => logError('Falha ao dispensar aviso', err),
  });

  const closeMutation = useMutation({
    /** @param {object} op */
    mutationFn: (op) => manualTransition(op, {
      status: 'CLOSED', closed_reason: MANUAL_CLOSE_REASON,
      decision_snapshot: buildManualCloseSnapshot({ status: 'CLOSED' }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trade-operations'] }),
    onError: (err) => {
      logError('Trades', 'Falha ao encerrar operação manualmente', { error: err.message });
      window.alert(err.message);
    },
  });

  const invalidateMutation = useMutation({
    /** @param {object} op */
    mutationFn: (op) => manualTransition(op, {
      status: 'INVALIDATED', closed_reason: MANUAL_INVALIDATE_REASON,
      decision_snapshot: buildManualCloseSnapshot({ status: 'INVALIDATED' }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trade-operations'] }),
    onError: (err) => {
      logError('Trades', 'Falha ao invalidar operação manualmente', { error: err.message });
      window.alert(err.message);
    },
  });

  const editMutation = useMutation({
    /** @param {{ op: object, data: object }} args */
    mutationFn: ({ op, data }) => manualTransition(op, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trade-operations'] });
      setEditingOp(null);
    },
    onError: (err) => {
      logError('Trades', 'Falha ao salvar edição manual de operação', { error: err.message });
      window.alert(err.message);
    },
  });

  const active  = operations.filter(o => ACTIVE_STATUSES.includes(o.status));
  const history = operations.filter(isClosedOp);

  // TradeOperation.timeframe é o timeframe de EXECUÇÃO ('15m'/'5m' — onde a
  // entrada foi confirmada), nunca o timeframe do SinalEvent que a originou
  // ('4h'/'1h' — signal_timeframe). Comparar contra o `timeframe` errado
  // fazia essa chave nunca bater para nenhuma operação da cascata nativa —
  // o aviso "em análise" do sinal que abriu a operação nunca era escondido,
  // mesmo com a operação ativa (docs/known-risks.md item 174 addendum).
  // Item 276: a chave inclui a fonte (cascata 1h_5m = SMC), senão uma operação
  // SMC 1h escondia todo aviso Range Filter 1h do mesmo ativo.
  const opSource = (o) => (o.cascade === '1h_5m' ? 'smc_structure' : 'range_filter');
  const activeKey = new Set(active.map(o => `${o.symbol}_${o.signal_timeframe ?? o.timeframe}_${opSource(o)}`));
  const monitoringMap = new Map();
  recentSignals
    // is_dismissed ja e respeitado pelo scanner e pela pagina Alerts; so esta
    // lista o ignorava, entao um aviso dispensado voltava a aparecer aqui.
    // Item 276: só avisos das cascatas (Range Filter e SMC); MACD/EMA/RSI e
    // avisos sem fonte ficam fora. A fase decide "em análise" × acordeão abaixo.
    .filter(s => !s.is_dismissed && !activeKey.has(`${s.symbol}_${s.timeframe}_${s.source}`)
      && (s.source === 'range_filter' || s.source === 'smc_structure'))
    .forEach(s => {
      // `source` na chave: um RF 1h mais novo não pode esconder um SMC 1h pendente.
      const key = `${s.symbol}_${s.timeframe}_${s.source}`;
      if (!monitoringMap.has(key) || new Date(s.created_date) > new Date(monitoringMap.get(key).created_date))
        monitoringMap.set(key, s);
    });
  const monitoringList = [...monitoringMap.values()];
  // Range Filter 1h/1d nunca vira operacao (so RF 4h e SMC 1h alimentam a fila).
  // Misturados na lista principal eles eram ruido com peso de conteudo — vao
  // para um acordeao fechado. Ver docs/known-risks.md item 156.
  const nowMs = Date.now();
  const monitoringActionable = [];
  const monitoringInfoOnly = [];
  for (const s of monitoringList) {
    // Uma única classificação por aviso (mesma regra do resto do app).
    const phase = classifySignal(s, nowMs, assetById.get(s.asset_id) ?? null).phase;
    (phase === SIGNAL_PHASE.INFO ? monitoringInfoOnly : monitoringActionable).push(s);
  }

  // Item 304: o filtro de gráfico comparava com `timeframe` (o da ENTRADA, '15m'/'5m') e escondia toda operação da cascata ao
  // escolher 1H/4H/1D; a regra corrigida e testada mora em `applyTradeFilters`. As listas são calculadas uma vez aqui (antes
  // cada bloco do JSX refiltrava a mesma lista, e a página inteira era redesenhada a cada segundo por um contador "há Ns").
  const filtersOn = countActiveFilters(filters) > 0;
  const shownActive = applyTradeFilters(active, filters);
  const shownHistory = applyTradeFilters(history, filters);
  const shownActionable = applyTradeFilters(monitoringActionable, filters);
  const shownInfoOnly = applyTradeFilters(monitoringInfoOnly, filters);
  const activeSummary = summarizeActiveOps(shownActive);
  const closedSummary = summarizeOps(shownHistory);

  return (
    <>
      {editingOp && (
        <EditModal
          op={editingOp}
          onClose={() => setEditingOp(null)}
          onSave={(data) => editMutation.mutate({ op: editingOp, data })}
        />
      )}

      {/* Achado da varredura pós-Raio-X, Round 2 (2026-09-27): confirm()
          nativo quebrava o tema escuro — migrado pro AlertDialog já
          existente e nunca usado. 1 diálogo compartilhado entre
          Invalidar/Encerrar (mesma forma de op, muda só o verbo/mutação). */}
      <AlertDialog open={!!confirmingOp} onOpenChange={(open) => !open && setConfirmingOp(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmingOp?.action === 'invalidate' ? 'Invalidar operação?' : 'Encerrar operação?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmingOp?.action === 'invalidate'
                ? `Invalidar ${confirmingOp?.op.symbol} ${confirmingOp?.op.side}? O registro é mantido como histórico (status muda para INVALIDATED) — esta ação não pode ser desfeita pela interface.`
                : `Encerrar ${confirmingOp?.op.symbol} ${confirmingOp?.op.side}? O registro é mantido como histórico (status muda para CLOSED) — esta ação não pode ser desfeita pela interface.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmingOp?.action === 'invalidate') invalidateMutation.mutate(confirmingOp.op);
                else if (confirmingOp?.action === 'close') closeMutation.mutate(confirmingOp.op);
              }}>
              {confirmingOp?.action === 'invalidate' ? 'Invalidar' : 'Encerrar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="space-y-5 max-w-7xl mx-auto">
        {/* Header — como era antes (item 304, revisão do usuário em 16/11: "não faz sentido tirar algumas coisas"):
            o "Atualizado há …" e a linha de contagem voltaram. O contador agora vive num componente só dele, então
            o relógio não redesenha mais a página inteira a cada segundo. */}
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <p className="text-11px font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Gestão de Operações</p>
            <h1 className="text-3xl font-bold text-foreground tracking-tight">Plano de Trade</h1>
          </div>
          <div className="flex items-center gap-3 text-10px font-mono flex-wrap">
            <UpdatedAgo dataUpdatedAt={dataUpdatedAt} />
            <span className="text-muted-foreground">
              {monitoringActionable.length} em análise · {active.length} ativas · {history.length} histórico
            </span>
          </div>
        </div>

        {/* Resumo de agora (item 304): o que está em jogo, em quatro números. Fica acima de tudo; o resto da página segue
            na ordem de sempre. */}
        <TradesNowSummary
          active={activeSummary}
          analysisCount={shownActionable.length}
          closed={{ total: shownHistory.length, wins: closedSummary.wins, be: closedSummary.be, losses: closedSummary.losses }}
          filtered={filtersOn}
        />

        {/* Performance Report + Charts — de volta ao lugar original, logo depois do resumo (item 304). */}
        {shownHistory.length > 0 && (
          <div className="space-y-4">
            <PerformanceReport trades={shownHistory} />
            <div>
            <button onClick={() => setShowChart(!showChart)} aria-expanded={showChart}
              className="flex items-center gap-2 mb-3 group">
              <BarChart2 className="w-4 h-4" style={{ color: '#00e5ff' }} />
              <h2 className="text-base font-bold text-foreground/80 group-hover:text-foreground transition-colors">
                Performance Acumulada
              </h2>
              <span className="text-10px font-mono" style={{ color: '#00e5ff' }}>
                {showChart ? '▲ esconder' : '▼ mostrar'}
              </span>
            </button>
            {showChart && (
              <>
                <TradeEntryMarkers history={shownHistory} />
                <div className="mt-4">
                  <PortfolioVsMarket trades={shownHistory} />
                </div>
              </>
            )}
            </div>
          </div>
        )}

        <TradesFilterBar
          filters={filters}
          onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
          onClear={clearFilters}
          showDetails={showDetails}
          onToggleDetails={() => setShowDetails((v) => !v)}
          counts={{
            activeShown: shownActive.length, activeTotal: active.length,
            analysisShown: shownActionable.length, analysisTotal: monitoringActionable.length,
            closedShown: shownHistory.length, closedTotal: history.length,
          }}
        />

        {/* Active Operations — logo depois dos filtros (item 304): é o que está em jogo agora. */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Target className="w-4 h-4" style={{ color: '#00ff80' }} />
            <h2 className="text-base font-bold text-foreground">Operações Ativas</h2>
            <span className="text-xs font-mono text-muted-foreground">({shownActive.length})</span>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : isError && operations.length === 0 ? (
            <div className="glass-card rounded-xl p-8">
              <QueryErrorState message="Não foi possível carregar as operações agora." onRetry={refetch} />
            </div>
          ) : shownActive.length === 0 ? (
            isError ? (
              // Há dado em cache (por isso não caiu no ramo acima), mas a
              // atualização mais recente falhou — "Nenhuma operação ativa"
              // seria uma afirmação que não foi confirmada de verdade (achado
              // da revisão pós-PR #396, docs/claude/ui-audit-criticos.md).
              <div className="glass-card rounded-xl p-8">
                <QueryErrorState message="Não foi possível confirmar se há operações ativas agora — a atualização falhou. Mostrando o último dado conhecido." onRetry={refetch} />
              </div>
            ) : active.length > 0 ? (
              // Item 304: antes aqui também saía "Nenhuma operação ativa." — com operação aberta e só o filtro escondendo.
              <div className="glass-card rounded-xl p-8 text-center space-y-3">
                <p className="text-muted-foreground text-sm">
                  {active.length === 1
                    ? 'Há 1 operação ativa, mas os filtros ligados a escondem.'
                    : `Há ${active.length} operações ativas, mas os filtros ligados as escondem.`}
                </p>
                <button type="button" onClick={clearFilters}
                  className="text-10px font-mono px-3 py-1.5 rounded-md"
                  style={{ background: 'rgba(255,209,102,0.1)', border: '1px solid rgba(255,209,102,0.35)', color: '#ffd166' }}>
                  Limpar filtros e mostrar
                </button>
              </div>
            ) : (
              <div className="glass-card rounded-xl p-12 text-center">
                <Target className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
                <p className="text-muted-foreground text-sm">Nenhuma operação ativa.</p>
              </div>
            )
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {shownActive.map(op => (
                <TradeCard
                  key={op.id}
                  operation={op}
                  expandAll={showDetails}
                  actions={
                    <div className="flex items-center gap-1.5 p-2">
                      <button
                        onClick={() => setEditingOp(op)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-10px font-mono transition-all hover:opacity-90"
                        style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
                        <Edit3 className="w-3 h-3" />
                        Editar
                      </button>
                      <button
                        onClick={() => setConfirmingOp({ op, action: 'invalidate' })}
                        disabled={invalidateMutation.isPending}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-10px font-mono transition-all hover:opacity-90"
                        style={{ background: 'rgba(255,159,67,0.08)', border: '1px solid rgba(255,159,67,0.2)', color: '#ff9f43' }}>
                        <AlertTriangle className="w-3 h-3" />
                        Invalidar
                      </button>
                      <button
                        onClick={() => setConfirmingOp({ op, action: 'close' })}
                        disabled={closeMutation.isPending}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-10px font-mono ml-auto transition-all hover:opacity-90"
                        style={{ background: 'rgba(255,20,120,0.1)', border: '1px solid rgba(255,20,120,0.25)', color: '#ff1478' }}>
                        <XCircle className="w-3 h-3" />
                        Encerrar
                      </button>
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </div>

        {/* "Avisos em análise"/"Observações de mercado" dependem de
            recentSignals — uma falha de rede aqui fazia as duas seções
            simplesmente sumirem da tela (ambas só renderizam com
            `.length > 0`), sem nenhum aviso: o mesmo silêncio enganoso que
            o C-3 original corrigiu na query principal de cada página, só
            que numa query secundária fora do escopo daquela rodada (achado
            da 3ª revisão cética, docs/claude/ui-audit-criticos.md). */}
        {signalsError && (
          <div className="glass-card rounded-xl p-6">
            <QueryErrorState message="Não foi possível verificar avisos/sinais recentes agora." onRetry={refetchSignals} />
          </div>
        )}

        {/* Avisos em análise — rótulo antigo ("Em Monitoramento") mentia para
            2 dos 3 estados: expirado não está sendo monitorado e informativo
            nunca foi. Ver docs/known-risks.md item 156. */}
        {monitoringActionable.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Eye className="w-4 h-4" style={{ color: '#ffd166' }} />
              <h2 className="text-base font-bold text-foreground">Avisos em análise</h2>
              <span className="text-xs font-mono" style={{ color: '#ffd166' }}>
                ({shownActionable.length})
              </span>
            </div>
            <p className="text-10px font-mono mb-3" style={{ color: 'rgba(255,255,255,0.35)' }}>
              O app está checando estes. Se algum virar operação, ele abre sozinho e ela aparece em Operações Ativas.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {shownActionable.map(signal => (
                <MonitoringCard
                  key={signal.id}
                  signal={signal}
                  asset={assetById.get(signal.asset_id) ?? null}
                  onDismiss={(sig) => dismissSignalMutation.mutate(sig)}
                  isDismissing={dismissSignalMutation.isPending}
                  expandAll={showDetails}
                />
              ))}
            </div>
          </div>
        )}

        {/* Observações de mercado — nunca viram operação, então saem da lista
            principal e ficam num acordeão fechado. */}
        {shownInfoOnly.length > 0 && (
          <div>
            <button onClick={() => setShowInfoSignals(!showInfoSignals)}
              aria-expanded={showInfoSignals}
              className="flex items-center gap-2 text-11px font-mono transition-colors hover:text-foreground/70"
              style={{ color: '#60a5fa' }}>
              {showInfoSignals ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              ℹ {shownInfoOnly.length} observações de mercado
              <span style={{ color: 'rgba(255,255,255,0.3)' }}>— não viram operação</span>
            </button>
            {showInfoSignals && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-3">
                {shownInfoOnly.map(signal => (
                  <MonitoringCard
                    key={signal.id}
                    signal={signal}
                    asset={assetById.get(signal.asset_id) ?? null}
                    onDismiss={(sig) => dismissSignalMutation.mutate(sig)}
                    isDismissing={dismissSignalMutation.isPending}
                    expandAll={showDetails}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* History */}
        {history.length > 0 && (
          <div>
            <button onClick={() => setShowHistory(!showHistory)} aria-expanded={showHistory} className="flex items-center gap-2 mb-3 group">
              <History className="w-4 h-4 text-muted-foreground group-hover:text-foreground/60 transition-colors" />
              <h2 className="text-base font-bold text-foreground/60 group-hover:text-foreground/80 transition-colors">
                Histórico Completo
              </h2>
              <span className="text-xs font-mono text-muted-foreground">({shownHistory.length})</span>
              <span className="text-10px font-mono" style={{ color: '#00e5ff' }}>
                {showHistory ? '▲ esconder' : '▼ mostrar'}
              </span>
            </button>

            {showHistory && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-x-4 gap-y-1 flex-wrap px-3 py-2 rounded-lg mb-3 text-10px font-mono"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <span style={{ color: '#00ff80' }}>✓ Ganhos: {closedSummary.wins}</span>
                  <span style={{ color: '#ffd166' }}>↔ Empates: {closedSummary.be}</span>
                  <span style={{ color: '#ff1478' }}>✗ Perdas: {closedSummary.losses}</span>
                  <span className="text-muted-foreground">Total: {closedSummary.total}</span>
                  <Link to="/history" className="ml-auto underline underline-offset-2" style={{ color: '#00e5ff' }}>
                    Ver a história de cada operação na aba Histórico →
                  </Link>
                </div>
                {shownHistory.map(op => <HistoryRow key={op.id} op={op} eventCtx={eventCtx} />)}
                {operations.length >= OPERATIONS_PAGE_SIZE && (
                  <p className="text-9px font-mono pt-1" style={{ color: 'rgba(255,255,255,0.35)' }}>
                    Esta página carrega só as {OPERATIONS_PAGE_SIZE} operações mais recentes (ativas e fechadas); as mais antigas não entram nesta lista nem nos números acima.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
