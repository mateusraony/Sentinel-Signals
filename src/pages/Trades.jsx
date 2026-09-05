import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { rtdbEntities } from '@/api/rtdbEntities';
import {
  Loader2, Target, History, XCircle, Eye, AlertTriangle,
  BarChart2, Edit3, X, Search, Calendar, ChevronDown, ChevronUp
} from 'lucide-react';
import TradeCard, { ScoreBar } from '@/components/dashboard/TradeCard';
import TradeEntryMarkers from '@/components/trades/TradeEntryMarkers';
import PortfolioVsMarket from '@/components/trades/PortfolioVsMarket';
import PerformanceReport from '@/components/trades/PerformanceReport';
import { describeProximity, formatPrice, formatSignedPct } from '@/lib/priceProximity';
import { classifySignal, phaseCopy, rejectionCopy, formatTimeLeft, SIGNAL_PHASE } from '@/lib/signalStatus';
import { signalTimeline, opTimeline, closedReasonLabel } from '@/lib/eventTimeline';
import { EventTimeline, fmtBRT } from '@/components/dashboard/EventTimeline';
import { useLivePrice } from '@/hooks/useLivePrice';
import moment from 'moment';
import { isClosedOp, getExitPrice, calcRealizedPnlPct, classifyOutcome, summarizeOps } from '@/lib/tradeMetrics';
import { logError } from '@/lib/logger';
import { POLL_OPERATIONAL_MS } from '@/lib/pollingIntervals';

const ACTIVE_STATUSES = ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'];

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-sm rounded-2xl p-5 space-y-4"
        style={{ background: 'rgba(10,13,22,0.98)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 0 40px rgba(0,0,0,0.5)' }}>
        <div className="flex items-center justify-between">
          <div>
            <div className="font-bold text-sm text-foreground">{op.symbol?.replace('USDT', '/USDT')}</div>
            <div className="text-[9px] font-mono text-muted-foreground">{op.timeframe?.toUpperCase()} · {op.side}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/[0.05] transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="space-y-3">
          {/* Status manual */}
          <div>
            <label className="text-[9px] font-mono mb-1 block" style={{ color: '#00e5ff' }}>Status Manual</label>
            <select value={status} onChange={e => setStatus(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-xs font-mono"
              style={fieldStyle}>
              <option value="SIGNAL_CONFIRMED">SIGNAL_CONFIRMED — Aguardando entrada</option>
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
              <label className="text-[9px] font-mono mb-1 block" style={{ color: '#ffd166' }}>Preço de Saída (exit_price)</label>
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
              <label className="text-[9px] font-mono mb-1 block" style={{ color }}>{label}</label>
              <input type="number" step="any" value={value} onChange={e => set(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-xs font-mono" style={fieldStyle} />
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={onClose}
            className="flex-1 py-2 rounded-lg text-[10px] font-mono transition-all"
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
                data.closed_reason = 'Alterado manualmente';
              }
              if (status === 'RUNNER_ACTIVE') data.tp1_hit = true;
              onSave(data);
            }}
            className="flex-1 py-2 rounded-lg text-[10px] font-mono font-bold transition-all"
            style={{ background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }}>
            Salvar Alterações
          </button>
        </div>
      </div>
    </div>
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
function MonitoringCard({ signal, onDismiss, isDismissing }) {
  const [showDetails, setShowDetails] = useState(false);
  const { price, isStale } = useLivePrice(signal.symbol);

  const { phase, msLeft, expiresAt } = classifySignal(signal);
  const copy = phaseCopy(phase);
  const reason = rejectionCopy(signal);
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
            <span className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.6)' }}>
              {signal.symbol?.replace('USDT', '/USDT')}
            </span>
            <span className="text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.3)' }}>
              {isBuy ? 'alta' : 'baixa'}
            </span>
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: `${copy.color}1a`, color: copy.color, border: `1px solid ${copy.color}40` }}>
              {copy.icon} {copy.badge}
            </span>
          </div>

          <p className="text-[10px] font-mono leading-relaxed" style={{ color: 'rgba(255,255,255,0.4)' }}>
            {copy.reassurance}
          </p>

          {/* O QUE O SISTEMA NÃO GOSTOU. Antes o card expirado só dizia que
              nada foi aberto e engolia o motivo — que estava ali, em
              last_rejection_reason. Pedido do usuário, item 161. */}
          <div className="rounded-lg px-2 py-1.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="text-[9px] font-mono font-semibold" style={{ color: 'rgba(255,255,255,0.5)' }}>
              {reason.icon} O que travou: {reason.chip}
            </div>
            <p className="text-[9px] font-mono leading-relaxed mt-0.5" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {reason.detail}
            </p>
          </div>

          <EventTimeline events={signalTimeline(signal)} title={null} />
        </div>
        <button onClick={() => onDismiss?.(signal)} disabled={isDismissing}
          title="Tirar este aviso da lista"
          className="shrink-0 p-1 rounded-lg transition-colors hover:bg-white/[0.06]">
          <X className="w-3.5 h-3.5" style={{ color: 'rgba(255,255,255,0.35)' }} />
        </button>
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
          <div className="font-bold text-sm text-foreground truncate">{signal.symbol?.replace('USDT', '/USDT')}</div>
          <div className="text-[10px] font-mono mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>
            {isBuy ? 'Aviso de alta (compra)' : 'Aviso de baixa (venda)'} · {moment(signal.created_date).fromNow()}
          </div>
          {/* Horário absoluto ao lado do relativo: "há 2 horas" não serve
              para conferir nada depois (item 161). */}
          <div className="text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.28)' }}>
            apareceu {fmtBRT(signal.created_date)} BRT
          </div>
        </div>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded shrink-0 font-semibold"
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
          <div className="text-[9px] font-mono uppercase tracking-widest mt-1"
            style={{ color: isStale ? '#ff9f43' : 'rgba(255,255,255,0.35)' }}>
            {isStale ? 'preço desatualizado' : 'preço agora'}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] font-mono" style={{ color: 'rgba(255,255,255,0.5)' }}>
            avisou em ${formatPrice(signal.price_at_signal)}
          </div>
          {unrealizedPct !== null && (
            <div className="text-[10px] font-mono font-bold" style={{ color: moveColor, opacity: isStale ? 0.55 : 1 }}>
              {formatSignedPct(unrealizedPct)} a favor do aviso
            </div>
          )}
        </div>
      </div>

      {/* 3 · O que falta — chip curto + frase que termina em "nada a fazer" */}
      <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <div className="text-[10px] font-mono font-semibold" style={{ color: copy.color }}>
            {reason.icon} {reason.chip}
          </div>
          {/* "desde", não "às": o motor só recarimba quando o MOTIVO muda
              (item 163) — é há quanto tempo o aviso está preso nisto, o que
              é justamente o que o usuário quer comparar depois. */}
          {signal.last_rejection_at && (
            <span className="text-[9px] font-mono shrink-0" style={{ color: 'rgba(255,255,255,0.3)' }}
              title="Desde quando este aviso está travado neste mesmo motivo (horário de Brasília)">
              desde {fmtBRT(signal.last_rejection_at)}
            </span>
          )}
        </div>
        <p className="text-[10px] font-mono leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>
          {reason.detail}
        </p>
      </div>

      {/* 4 · Quem age, e até quando */}
      <p className="text-[10px] font-mono leading-relaxed" style={{ color: 'rgba(255,255,255,0.45)' }}>
        {copy.reassurance}
        {phase === SIGNAL_PHASE.WAITING && expiresAt && timeLeft
          ? ` Prazo: até ${moment(expiresAt).utcOffset(-3).format('DD/MM [às] HH[h]mm')} (faltam ${timeLeft}).`
          : ''}
      </p>

      {/* 5 · O técnico, a um clique */}
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setShowDetails(!showDetails)}
          aria-expanded={showDetails}
          className="flex items-center gap-1 text-[10px] font-mono transition-colors hover:text-foreground/70"
          style={{ color: 'rgba(255,255,255,0.35)' }}>
          {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          Detalhes técnicos
        </button>
        <button onClick={() => onDismiss?.(signal)} disabled={isDismissing}
          title="Tirar este aviso da lista"
          className="text-[10px] font-mono px-2 py-1 rounded-lg transition-colors hover:bg-white/[0.06]"
          style={{ color: 'rgba(255,255,255,0.3)' }}>
          Dispensar
        </button>
      </div>

      {showDetails && (
        <div className="space-y-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>
            Gráfico de {signal.timeframe?.toUpperCase()}
          </div>
          <EventTimeline events={signalTimeline(signal)} />
          <ScoreBar score={signal.context?.score || 0} />
          {signal.reason && (
            <p className="text-[9px] font-mono leading-relaxed" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {signal.reason}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** History row */
function HistoryRow({ op }) {
  const isBuy = op.side === 'BUY';
  const exitPrice = getExitPrice(op);
  const pnlPct = calcRealizedPnlPct(op);
  const isBE = classifyOutcome(op) === 'BE';

  const STATUS_MAP = {
    TP2_HIT:     { label: '🏆 TP2', color: '#00ff80' },
    STOP_HIT:    { label: isBE ? '🔄 BE' : '🛑 Stop', color: isBE ? '#ffd166' : '#ff1478' },
    INVALIDATED: { label: '⚠ Inv.', color: '#ff9f43' },
    CLOSED:      { label: '✗ Enc.', color: '#64748b' },
  };
  const s = STATUS_MAP[op.status] || { label: op.status, color: '#64748b' };
  const eventos = opTimeline(op);
  const fechamento = eventos.length > 1 ? eventos[eventos.length - 1] : null;
  const motivo = closedReasonLabel(op);

  return (
    <div className="rounded-xl px-4 py-2.5 flex items-center gap-3 transition-opacity"
      style={{ background: 'rgba(12,15,26,0.55)', border: '1px solid rgba(255,255,255,0.05)', opacity: 0.8 }}>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="font-semibold text-xs text-foreground shrink-0">{op.symbol?.replace('USDT', '/USDT')}</span>
        <span className="text-[9px] font-mono text-muted-foreground">{op.timeframe?.toUpperCase()}</span>
        <span className="text-[9px] font-mono font-bold" style={{ color: isBuy ? '#00ff80' : '#ff1478' }}>{op.side}</span>
        <span className="text-[9px] font-mono text-muted-foreground hidden sm:block">${formatPrice(op.entry_price)}</span>
        {exitPrice && <span className="text-[9px] font-mono text-muted-foreground hidden md:block">→ ${formatPrice(exitPrice)}</span>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {pnlPct !== null && (
          <span className="text-sm font-mono font-bold" style={{ color: pnlPct >= 0 ? '#00ff80' : '#ff1478' }}>
            {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
          </span>
        )}
        <span className="text-[9px] font-mono font-semibold" style={{ color: s.color }}>{s.label}</span>
        {/* Aberta -> fechada, ambos absolutos, com o motivo quando existe.
            Antes só havia a data de criação (item 161). */}
        <span className="text-[9px] font-mono text-muted-foreground hidden sm:block text-right leading-tight"
          title={motivo ? `Encerrada por: ${motivo}` : undefined}>
          {fmtBRT(op.created_date)}
          {fechamento ? <><br />→ {fmtBRT(fechamento.at)}{motivo ? ` (${motivo})` : ''}</> : null}
        </span>
      </div>
    </div>
  );
}

export default function Trades() {
  const [showHistory, setShowHistory] = useState(false);
  const [showInfoSignals, setShowInfoSignals] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showChart, setShowChart] = useState(true);
  const [filterTf, setFilterTf] = useState('all');
  const [filterSide, setFilterSide] = useState('all');
  const [search, setSearch] = useState('');
  const [datePreset, setDatePreset] = useState('all');
  const [editingOp, setEditingOp] = useState(null);
  const queryClient = useQueryClient();

  // Reset filters on global event
  useEffect(() => {
    const handler = () => { setSearch(''); setFilterTf('all'); setFilterSide('all'); setDatePreset('all'); };
    window.addEventListener('app-reset-filters', handler);
    return () => window.removeEventListener('app-reset-filters', handler);
  }, []);

  const dateRange = useMemo(() => {
    if (datePreset === 'all') return null;
    const now = moment();
    let from, to;
    switch (datePreset) {
      case 'today': from = now.clone().startOf('day'); to = now.clone().endOf('day'); break;
      case 'week': from = now.clone().startOf('week'); to = now.clone().endOf('week'); break;
      case 'month': from = now.clone().startOf('month'); to = now.clone().endOf('month'); break;
      case 'last_month': from = now.clone().subtract(1, 'month').startOf('month'); to = now.clone().subtract(1, 'month').endOf('month'); break;
      case 'quarter': from = now.clone().startOf('quarter'); to = now.clone().endOf('quarter'); break;
      case 'year': from = now.clone().startOf('year'); to = now.clone().endOf('year'); break;
      default: return null;
    }
    return { from: from.toDate(), to: to.toDate() };
  }, [datePreset]);

  const { data: operations = [], isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['trade-operations'],
    queryFn: () => rtdbEntities.TradeOperation.list('-created_date', 100),
    refetchInterval: POLL_OPERATIONAL_MS,
  });

  const { data: recentSignals = [] } = useQuery({
    queryKey: ['recent-signals'],
    queryFn: () => backend.entities.SignalEvent.list('-created_date', 50),
    refetchInterval: POLL_OPERATIONAL_MS,
  });

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
    mutationFn: (op) => manualTransition(op, { status: 'CLOSED', closed_reason: 'Encerrado manualmente' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trade-operations'] }),
    onError: (err) => {
      logError('Trades', 'Falha ao encerrar operação manualmente', { error: err.message });
      window.alert(err.message);
    },
  });

  const invalidateMutation = useMutation({
    /** @param {object} op */
    mutationFn: (op) => manualTransition(op, { status: 'INVALIDATED', closed_reason: 'Invalidado manualmente' }),
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

  const activeKey = new Set(active.map(o => `${o.symbol}_${o.timeframe}`));
  const monitoringMap = new Map();
  recentSignals
    // is_dismissed ja e respeitado pelo scanner e pela pagina Alerts; so esta
    // lista o ignorava, entao um aviso dispensado voltava a aparecer aqui.
    .filter(s => s.source === 'range_filter' && !s.is_dismissed && !activeKey.has(`${s.symbol}_${s.timeframe}`))
    .forEach(s => {
      const key = `${s.symbol}_${s.timeframe}`;
      if (!monitoringMap.has(key) || new Date(s.created_date) > new Date(monitoringMap.get(key).created_date))
        monitoringMap.set(key, s);
    });
  const monitoringList = [...monitoringMap.values()];
  // Sinais de 1h/1d nunca viram operacao (so a cascata 4h alimenta a fila).
  // Misturados na lista principal eles eram ruido com peso de conteudo — vao
  // para um acordeao fechado. Ver docs/known-risks.md item 156.
  const monitoringActionable = monitoringList.filter(s => classifySignal(s).phase !== SIGNAL_PHASE.INFO);
  const monitoringInfoOnly = monitoringList.filter(s => classifySignal(s).phase === SIGNAL_PHASE.INFO);

  const applyFilters = (list) => list
    .filter(o => filterTf === 'all' || o.timeframe === filterTf)
    .filter(o => filterSide === 'all' || (o.side || o.signal_type) === filterSide)
    .filter(o => !search || o.symbol?.toLowerCase().includes(search.toLowerCase()))
    .filter(o => {
      if (!dateRange) return true;
      const d = new Date(o.created_date);
      return d >= dateRange.from && d <= dateRange.to;
    });

  const [secAgo, setSecAgo] = useState(0);
  useEffect(() => {
    if (!dataUpdatedAt) return;
    const interval = setInterval(() => setSecAgo(Math.floor((Date.now() - dataUpdatedAt) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [dataUpdatedAt]);

  const TF_BTNS = ['all', '1h', '4h', '1d'];
  const SIDE_BTNS = ['all', 'BUY', 'SELL'];

  return (
    <>
      {editingOp && (
        <EditModal
          op={editingOp}
          onClose={() => setEditingOp(null)}
          onSave={(data) => editMutation.mutate({ op: editingOp, data })}
        />
      )}

      <div className="space-y-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Gestão de Operações</p>
            <h1 className="text-3xl font-bold text-foreground tracking-tight">Plano de Trade</h1>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="live-dot" style={{ width: 5, height: 5 }} />
              <span className="text-muted-foreground">Atualizado há {secAgo}s</span>
            </span>
            <span className="text-muted-foreground">
              {monitoringActionable.length} em análise · {active.length} ativas · {history.length} histórico
            </span>
          </div>
        </div>

        {/* Performance Report + Charts */}
        {applyFilters(history).length > 0 && (
          <div className="space-y-4">
            <PerformanceReport trades={applyFilters(history)} />
            <div>
            <button onClick={() => setShowChart(!showChart)}
              className="flex items-center gap-2 mb-3 group">
              <BarChart2 className="w-4 h-4" style={{ color: '#00e5ff' }} />
              <h2 className="text-base font-bold text-foreground/80 group-hover:text-foreground transition-colors">
                Performance Acumulada
              </h2>
              <span className="text-[10px] font-mono" style={{ color: '#00e5ff' }}>
                {showChart ? '▲ esconder' : '▼ mostrar'}
              </span>
            </button>
            {showChart && (
              <>
                <TradeEntryMarkers history={applyFilters(history)} />
                <div className="mt-4">
                  <PortfolioVsMarket trades={applyFilters(history)} />
                </div>
              </>
            )}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <input type="text" placeholder="Buscar operação..." value={search} onChange={e => setSearch(e.target.value)}
              className="pl-7 pr-3 h-8 w-44 rounded-lg text-[10px] font-mono outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.75)' }} />
          </div>

          <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(255,255,255,0.08)' }} />

          {/* Date presets */}
          <Calendar className="w-3 h-3 text-muted-foreground shrink-0" />
          {[
            { id: 'all', label: 'Tudo' },
            { id: 'today', label: 'Hoje' },
            { id: 'week', label: 'Semana' },
            { id: 'month', label: 'Mês' },
            { id: 'last_month', label: 'Mês Passado' },
            { id: 'quarter', label: 'Trimestre' },
            { id: 'year', label: 'Ano' },
          ].map(p => (
            <button key={p.id} onClick={() => setDatePreset(p.id)}
              className="text-[10px] font-mono px-2.5 py-1 rounded-md transition-all"
              style={datePreset === p.id
                ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(0,229,255,0.9)' }
                : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
              {p.label}
            </button>
          ))}

          <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(255,255,255,0.08)' }} />

          {TF_BTNS.map(tf => (
            <button key={tf} onClick={() => setFilterTf(tf)}
              className="text-[10px] font-mono px-2.5 py-1 rounded-md transition-all"
              style={filterTf === tf
                ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(0,229,255,0.9)' }
                : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
              {tf === 'all' ? 'Todos TF' : tf.toUpperCase()}
            </button>
          ))}
          <div className="w-px h-4 mx-1" style={{ background: 'rgba(255,255,255,0.08)' }} />
          {SIDE_BTNS.map(side => (
            <button key={side} onClick={() => setFilterSide(side)}
              className="text-[10px] font-mono px-2.5 py-1 rounded-md transition-all"
              style={filterSide === side
                ? side === 'BUY' ? { background: 'rgba(0,255,128,0.12)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }
                  : side === 'SELL' ? { background: 'rgba(255,20,120,0.12)', border: '1px solid rgba(255,20,120,0.3)', color: '#ff1478' }
                  : { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(0,229,255,0.9)' }
                : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
              {side === 'all' ? 'Todos' : side}
            </button>
          ))}

          {/* Densidade — abre/fecha os detalhes técnicos de TODOS os cards de
              uma vez. Cada card continua podendo ser aberto sozinho depois. */}
          <div className="w-px h-4 mx-1" style={{ background: 'rgba(255,255,255,0.08)' }} />
          <button onClick={() => setShowDetails(v => !v)}
            aria-pressed={showDetails}
            title="Abre ou fecha os detalhes técnicos de todos os cards de operação ao mesmo tempo."
            className="flex items-center gap-1 text-[10px] font-mono px-2.5 py-1 rounded-md transition-all"
            style={showDetails
              ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(0,229,255,0.9)' }
              : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
            {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showDetails ? 'Detalhado' : 'Compacto'}
          </button>
        </div>

        {/* Avisos em análise — rótulo antigo ("Em Monitoramento") mentia para
            2 dos 3 estados: expirado não está sendo monitorado e informativo
            nunca foi. Ver docs/known-risks.md item 156. */}
        {monitoringActionable.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Eye className="w-4 h-4" style={{ color: '#ffd166' }} />
              <h2 className="text-base font-bold text-foreground">Avisos em análise</h2>
              <span className="text-xs font-mono" style={{ color: '#ffd166' }}>
                ({applyFilters(monitoringActionable.map(s => ({ ...s, side: s.signal_type }))).length})
              </span>
            </div>
            <p className="text-[10px] font-mono mb-3" style={{ color: 'rgba(255,255,255,0.35)' }}>
              O app está checando estes. Se algum virar operação, ele abre sozinho e ela aparece em Operações Ativas.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {applyFilters(monitoringActionable.map(s => ({ ...s, side: s.signal_type }))).map(signal => (
                <MonitoringCard
                  key={signal.id}
                  signal={signal}
                  onDismiss={(sig) => dismissSignalMutation.mutate(sig)}
                  isDismissing={dismissSignalMutation.isPending}
                />
              ))}
            </div>
          </div>
        )}

        {/* Observações de mercado — nunca viram operação, então saem da lista
            principal e ficam num acordeão fechado. */}
        {applyFilters(monitoringInfoOnly.map(s => ({ ...s, side: s.signal_type }))).length > 0 && (
          <div>
            <button onClick={() => setShowInfoSignals(!showInfoSignals)}
              aria-expanded={showInfoSignals}
              className="flex items-center gap-2 text-[11px] font-mono transition-colors hover:text-foreground/70"
              style={{ color: '#60a5fa' }}>
              {showInfoSignals ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              ℹ {applyFilters(monitoringInfoOnly.map(s => ({ ...s, side: s.signal_type }))).length} observações de mercado
              <span style={{ color: 'rgba(255,255,255,0.3)' }}>— não viram operação</span>
            </button>
            {showInfoSignals && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-3">
                {applyFilters(monitoringInfoOnly.map(s => ({ ...s, side: s.signal_type }))).map(signal => (
                  <MonitoringCard
                    key={signal.id}
                    signal={signal}
                    onDismiss={(sig) => dismissSignalMutation.mutate(sig)}
                    isDismissing={dismissSignalMutation.isPending}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Active Operations */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Target className="w-4 h-4" style={{ color: '#00ff80' }} />
            <h2 className="text-base font-bold text-foreground">Operações Ativas</h2>
            <span className="text-xs font-mono text-muted-foreground">({applyFilters(active).length})</span>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : applyFilters(active).length === 0 ? (
            <div className="glass-card rounded-xl p-12 text-center">
              <Target className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
              <p className="text-muted-foreground text-sm">Nenhuma operação ativa.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {applyFilters(active).map(op => (
                <TradeCard
                  key={op.id}
                  operation={op}
                  expandAll={showDetails}
                  actions={
                    <div className="flex items-center gap-1.5 p-2">
                      <button
                        onClick={() => setEditingOp(op)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all hover:opacity-90"
                        style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
                        <Edit3 className="w-3 h-3" />
                        Editar
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Invalidar ${op.symbol} ${op.side}?`)) invalidateMutation.mutate(op);
                        }}
                        disabled={invalidateMutation.isPending}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all hover:opacity-90"
                        style={{ background: 'rgba(255,159,67,0.08)', border: '1px solid rgba(255,159,67,0.2)', color: '#ff9f43' }}>
                        <AlertTriangle className="w-3 h-3" />
                        Invalidar
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Encerrar ${op.symbol} ${op.side}?`)) closeMutation.mutate(op);
                        }}
                        disabled={closeMutation.isPending}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-mono ml-auto transition-all hover:opacity-90"
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

        {/* History */}
        {history.length > 0 && (
          <div>
            <button onClick={() => setShowHistory(!showHistory)} className="flex items-center gap-2 mb-3 group">
              <History className="w-4 h-4 text-muted-foreground group-hover:text-foreground/60 transition-colors" />
              <h2 className="text-base font-bold text-foreground/60 group-hover:text-foreground/80 transition-colors">
                Histórico Completo
              </h2>
              <span className="text-xs font-mono text-muted-foreground">({applyFilters(history).length})</span>
              <span className="text-[10px] font-mono" style={{ color: '#00e5ff' }}>
                {showHistory ? '▲ esconder' : '▼ mostrar'}
              </span>
            </button>

            {showHistory && (
              <div className="space-y-1.5">
                {(() => {
                  const { wins, losses, be, total } = summarizeOps(applyFilters(history));
                  return (
                    <div className="flex items-center gap-4 px-3 py-2 rounded-lg mb-3 text-[10px] font-mono"
                      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <span style={{ color: '#00ff80' }}>✓ Win: {wins}</span>
                      <span style={{ color: '#ffd166' }}>↔ BE: {be}</span>
                      <span style={{ color: '#ff1478' }}>✗ Loss: {losses}</span>
                      <span className="text-muted-foreground">Total: {total}</span>
                    </div>
                  );
                })()}
                {applyFilters(history).map(op => <HistoryRow key={op.id} op={op} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}