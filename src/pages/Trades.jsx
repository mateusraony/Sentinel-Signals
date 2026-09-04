import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { rtdbEntities } from '@/api/rtdbEntities';
import {
  Loader2, Target, History, XCircle, Eye,
  TrendingUp, TrendingDown, AlertTriangle,
  BarChart2, Edit3, X, Search, Calendar
} from 'lucide-react';
import TradeCard from '@/components/dashboard/TradeCard';
import TradeEntryMarkers from '@/components/trades/TradeEntryMarkers';
import PortfolioVsMarket from '@/components/trades/PortfolioVsMarket';
import PerformanceReport from '@/components/trades/PerformanceReport';
import { fetchCurrentPrice } from '@/lib/marketDataProvider';
import { describeProximity, rrGeometry, formatPrice, formatSignedPct, formatQuoteAge, usablePrice } from '@/lib/priceProximity';
import moment from 'moment';
import { isClosedOp, getExitPrice, calcRealizedPnlPct, classifyOutcome, summarizeOps } from '@/lib/tradeMetrics';
import { logError } from '@/lib/logger';

const ACTIVE_STATUSES = ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'];

// Traduz SignalEvent.last_rejection_reason (docs/schema-reference/SignalEvent.jsonc,
// docs/known-risks.md item 45.3/49/50/6) para texto que o usuário entende sem
// abrir o Debug Log. Puramente informativo — mesmo campo que o motor já
// grava sozinho (write-on-change, scanner.js), nenhuma lógica nova aqui.
const REJECTION_LABELS = {
  trend_reversed: 'A tendência do timeframe maior reverteu antes de confirmar — o sinal pode expirar sem abrir operação.',
  regime_rejected: 'Regime de mercado (ADX/Choppiness) não passou no filtro de qualidade — mercado sem tendência forte o bastante.',
  smc_confirm_zone_rejected: 'A estrutura SMC do timeframe maior não concorda com a direção do sinal.',
  retest_pending: 'Aguardando o preço retestar o nível rompido antes de confirmar (gate opcional).',
  displacement_gate_rejected: 'Aguardando um candle de deslocamento válido na direção do sinal (gate opcional).',
  confirmation_15m_not_aligned: 'Aguardando o Range Filter de 15m confirmar a mesma direção do sinal de 4h.',
  insufficient_data: 'Dados insuficientes no timeframe menor (5m) pra avaliar o gatilho de entrada ainda.',
  no_trigger: 'Aguardando o gatilho de entrada (varredura/estrutura) disparar no timeframe menor.',
  wrong_direction_trigger: 'O gatilho de entrada disparou, mas na direção oposta ao sinal — segue aguardando.',
  ote_zone_unfavorable: 'Preço fora da zona considerada favorável para entrada.',
  fetch_error: 'Falha ao buscar dados de mercado na última tentativa — deve tentar de novo na próxima passada.',
  rr_below_min: 'A relação risco:retorno calculada ficou abaixo do mínimo configurado (minRR).',
  missing_fields: 'Dados de entrada incompletos para calcular o gate de risco:retorno.',
  invalid_stop_distance: 'Distância de stop inválida (entrada e stop no mesmo preço).',
};

const CONFIRMATION_WINDOW_MS = 4 * 60 * 60 * 1000; // scanner.js FOUR_HOURS_MS — mesma janela pras 2 cascatas

// Uma cotação parada por mais de 3 ciclos de refetch não é mais "ao vivo".
const QUOTE_STALE_MS = 90_000;

/**
 * Preço ao vivo de um símbolo, com honestidade sobre a idade do dado.
 *
 * O TanStack Query mantém o último `data` bem-sucedido quando um refetch
 * falha — sem isto, o card seguiria mostrando uma cotação velha rotulada como
 * "ao vivo" durante uma indisponibilidade da Binance. `isStale` cobre os dois
 * casos: a última tentativa falhou, ou a última tentativa BEM-SUCEDIDA já
 * passou da validade. A idade é recalculada a cada render, e o próprio
 * `refetchInterval` garante um render a cada 30s mesmo em erro contínuo.
 *
 * A `queryKey` por símbolo é o que mantém a dedup do TanStack Query: dois
 * cards do mesmo par compartilham uma única requisição.
 */
function useLivePrice(symbol) {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ['live-price', symbol],
    queryFn: () => fetchCurrentPrice(symbol),
    enabled: Boolean(symbol),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  const price = usablePrice(data);
  const ageMs = price !== null && dataUpdatedAt ? Math.max(0, Date.now() - dataUpdatedAt) : null;
  const isStale = price !== null && (isError || (ageMs !== null && ageMs > QUOTE_STALE_MS));

  return { price, isLoading, isError, isStale, ageMs, ageLabel: formatQuoteAge(ageMs) };
}

// Cores por nível — mesmas de PriceGrid em TradeCard.jsx, para o card inteiro
// falar a mesma língua visual.
function levelColor(key, op) {
  switch (key) {
    case 'stop': return op.tp1_hit ? '#ffd166' : '#ff1478';
    case 'entry': return '#e2e8f0';
    case 'tp1': return op.tp1_hit ? '#00ff80' : '#ffd166';
    case 'tp2': return op.tp2_hit ? '#00ff80' : 'rgba(255,209,102,0.55)';
    default: return 'rgba(255,255,255,0.5)';
  }
}

const SEGMENT_COLOR = {
  risk: 'rgba(255,20,120,0.4)',
  tp1: 'rgba(0,255,128,0.35)',
  tp2: 'rgba(0,255,128,0.6)',
};

/**
 * Preço ao vivo + distância até cada nível + barra de risco/retorno.
 *
 * Só exibição: o preço vem da Binance direto pro navegador (mesmo
 * `fetchCurrentPrice` que o motor usa, nada de Firestore/RTDB aqui) e não
 * dispara nenhuma transição — quem move a operação continua sendo o scanner.
 * A `queryKey` por símbolo mantém a dedup do TanStack Query: dois cards do
 * mesmo par compartilham uma única requisição a cada 30s.
 */
function LivePricePanel({ op }) {
  const { price, isLoading, isError, isStale, ageLabel } = useLivePrice(op.symbol);

  const { levels, unrealizedPct } = describeProximity(op, price);
  const geo = rrGeometry(op, price);
  if (levels.length === 0) return null;

  const pnlColor = unrealizedPct === null ? 'rgba(255,255,255,0.4)' : unrealizedPct >= 0 ? '#00ff80' : '#ff1478';
  const quoteColor = price === null ? 'rgba(255,255,255,0.35)' : isStale ? '#ff9f43' : '#00e5ff';

  return (
    <div className="px-3 py-2.5 space-y-2"
      style={{ background: 'rgba(6,8,15,0.45)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>

      {/* Preço ao vivo + resultado bruto em aberto */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex items-center gap-1 text-[8px] font-mono uppercase tracking-widest shrink-0"
            style={{ color: 'rgba(255,255,255,0.35)' }}>
            <span
              className={`w-1.5 h-1.5 rounded-full${price !== null && !isStale ? ' animate-pulse motion-reduce:animate-none' : ''}`}
              style={{
                background: quoteColor,
                boxShadow: isStale || price === null ? 'none' : '0 0 5px #00e5ff',
              }} />
            {isStale ? 'Desatualizado' : 'Ao vivo'}
          </span>
          <span className="text-base font-mono font-bold truncate" style={{ color: quoteColor }}>
            {price !== null
              ? `$${formatPrice(price)}`
              : isLoading ? 'buscando…' : '—'}
          </span>
          {isStale && ageLabel && (
            <span className="text-[9px] font-mono shrink-0" style={{ color: '#ff9f43' }}>há {ageLabel}</span>
          )}
        </div>
        {unrealizedPct !== null && (
          <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded shrink-0"
            title={isStale
              ? `Calculado sobre a última cotação recebida (há ${ageLabel ?? '?'}), não sobre o preço de agora. Sem descontar taxas nem funding.`
              : 'Resultado em aberto sobre a entrada, sem descontar taxas nem funding.'}
            style={{ color: pnlColor, background: `${pnlColor}14`, border: `1px solid ${pnlColor}33`, opacity: isStale ? 0.55 : 1 }}>
            {formatSignedPct(unrealizedPct)}
          </span>
        )}
      </div>

      {(isStale || (isError && price === null)) && (
        <p className="text-[8px] font-mono leading-relaxed" style={{ color: '#ff9f43' }}>
          {price === null
            ? '⚠️ Não deu para buscar o preço agora (a Binance não respondeu). Os níveis abaixo continuam válidos; o painel tenta de novo em alguns segundos.'
            : `⚠️ Este é o último preço que chegou${ageLabel ? `, de ${ageLabel} atrás` : ''} — a atualização automática não está passando. As distâncias abaixo foram calculadas sobre ele, não sobre o preço de agora.`}
        </p>
      )}

      {/* Distância até cada nível */}
      {/* 2x2 fixo: o card fica com ~370px nos grids de 2/3 colunas, largura
          em que 4 chips lado a lado cortariam o preço. */}
      <div className="grid grid-cols-2 gap-1.5">
        {levels.map((level) => {
          const color = levelColor(level.key, op);
          return (
            <div key={level.key} className="rounded-lg px-2 py-1.5 min-w-0"
              style={{
                background: level.isNearest ? `${color}12` : 'rgba(255,255,255,0.03)',
                border: `1px solid ${level.isNearest ? `${color}45` : 'rgba(255,255,255,0.05)'}`,
              }}>
              <div className="flex items-center gap-1 text-[8px] font-mono uppercase tracking-wide"
                style={{ color: 'rgba(255,255,255,0.35)' }}>
                <span className="truncate">{level.label}</span>
                {level.isNearest && <span style={{ color }} title="Nível mais próximo do preço atual">•</span>}
              </div>
              <div className="text-[11px] font-mono font-bold truncate" style={{ color }}>${formatPrice(level.price)}</div>
              <div className="text-[9px] font-mono truncate"
                style={{ color: level.pct === null ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.45)' }}
                title={level.pct === null ? undefined : `O preço precisa andar ${formatSignedPct(level.pct)} para chegar em ${level.label}.`}>
                {level.pct === null ? '—' : `${level.position === 'above' ? '↑' : level.position === 'below' ? '↓' : '='} ${Math.abs(level.pct).toFixed(2)}%`}
              </div>
            </div>
          );
        })}
      </div>

      {/* Barra risco/retorno — só quando os 4 níveis existem */}
      {geo && (
        <div>
          <div className="relative h-2 w-full rounded-full overflow-visible"
            role="img"
            aria-label={`Barra de risco e retorno. Stop $${formatPrice(op.current_stop)}, entrada $${formatPrice(op.entry_price)}, TP1 $${formatPrice(op.tp1)}, TP2 $${formatPrice(op.tp2)}.${price !== null ? ` Preço atual $${formatPrice(price)}.` : ''}`}
            style={{ background: 'rgba(255,255,255,0.06)' }}>
            {geo.segments.map((seg) => (
              <div key={seg.key} className="absolute h-full"
                style={{ left: `${seg.from}%`, width: `${seg.to - seg.from}%`, background: SEGMENT_COLOR[seg.key] }} />
            ))}
            {['stop', 'entry', 'tp1', 'tp2'].map((key) => (
              <div key={key} className="absolute top-0 bottom-0 w-0.5"
                style={{ left: `${geo.positions[key]}%`, background: levelColor(key, op), transform: 'translateX(-50%)' }} />
            ))}
            {geo.currentPct !== null && (
              <div className="absolute -top-1 -bottom-1 w-0.5 rounded-full"
                title={[
                  isStale ? `Última cotação recebida (há ${ageLabel ?? '?'})` : 'Preço atual',
                  geo.currentOutOfRange ? '— fora do intervalo stop–TP2, marcador fixado na borda' : '',
                ].filter(Boolean).join(' ')}
                style={{
                  left: `${geo.currentPct}%`,
                  background: quoteColor,
                  boxShadow: `0 0 4px ${quoteColor}`,
                  transform: 'translateX(-50%)',
                  opacity: geo.currentOutOfRange || isStale ? 0.5 : 1,
                }} />
            )}
          </div>
          {geo.currentOutOfRange && (
            <p className="text-[8px] font-mono mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
              O preço saiu do intervalo entre stop e TP2 — o marcador ficou preso na borda.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

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
 * Preço ao vivo de um sinal ainda em monitoramento — responde "quanto falta
 * para a operação abrir" em vez de só mostrar o preço congelado do momento do
 * sinal. Compartilha a MESMA `queryKey` do painel das operações ativas, então
 * um par que aparece nas duas listas custa uma requisição só.
 */
function SignalLivePrice({ symbol, referencePrice, side }) {
  const { price, isError, isStale, ageLabel } = useLivePrice(symbol);

  if (price === null) {
    return isError
      ? <div className="text-[9px] font-mono" style={{ color: '#ff9f43' }} title="A Binance não respondeu na última tentativa.">preço indisponível</div>
      : null;
  }

  const { unrealizedPct } = describeProximity({ side, entry_price: referencePrice }, price);
  const color = unrealizedPct === null ? 'rgba(255,255,255,0.35)' : unrealizedPct >= 0 ? '#00ff80' : '#ff1478';

  return (
    <div className="text-[9px] font-mono flex items-center justify-end gap-1"
      style={{ color: isStale ? '#ff9f43' : '#00e5ff', opacity: isStale ? 0.7 : 1 }}>
      <span title={isStale
        ? `Último preço recebido, de ${ageLabel ?? '?'} atrás — a atualização automática não está passando.`
        : 'Preço de mercado agora'}>
        {isStale ? '⚠️ ' : ''}${formatPrice(price)}
      </span>
      {unrealizedPct !== null && (
        <span style={{ color }} title={isStale
          ? `Calculado sobre o último preço recebido (há ${ageLabel ?? '?'}), não sobre o preço de agora.`
          : 'Quanto o preço andou a favor do sinal desde que ele apareceu.'}>
          {formatSignedPct(unrealizedPct)}
        </span>
      )}
    </div>
  );
}

function MonitoringCard({ signal }) {
  const isBuy = signal.signal_type === 'BUY';

  // Só a cascata nativa 4h→15m entra numa fila de confirmação de verdade
  // (janela de horas, last_rejection_reason) — a Range Filter também dispara
  // em 1h/1d por ativo (MonitoredAsset.timeframes_enabled), mas esses são
  // avisos informativos puros: nunca viram operação por este mecanismo
  // (scanner.js — só tf==='4h' alimenta a cascata de confirmação/retry), e
  // por isso nunca têm "motivo de rejeição" nem "janela" de verdade. Tratar
  // os dois casos como se fossem a mesma coisa é o que gerava a confusão
  // reportada pelo usuário — a explicação de "aguardando/expirou" simplesmente
  // não se aplica a um sinal 1h/1d.
  const isConfirmationEligible = signal.timeframe === '4h';

  const expiresAt = new Date(signal.created_date).getTime() + CONFIRMATION_WINDOW_MS;
  const msLeft = expiresAt - Date.now();
  const isExpired = signal.expired_logged === true || msLeft <= 0;
  const hoursLeft = Math.floor(Math.max(0, msLeft) / (60 * 60 * 1000));
  const minsLeft = Math.floor((Math.max(0, msLeft) % (60 * 60 * 1000)) / (60 * 1000));

  const knownReason = signal.last_rejection_reason
    ? (REJECTION_LABELS[signal.last_rejection_reason] ?? `Última rejeição registrada: ${signal.last_rejection_reason}`)
    : null;

  // Nunca promete uma "próxima checagem" para um sinal que já expirou — isso
  // contradiz o badge de baixo, que já diz que a janela fechou. Expirado
  // sempre fala no passado (o que já aconteceu); só o sinal ainda dentro da
  // janela fala no presente/futuro (o que está sendo avaliado agora).
  const rejectionText = !isConfirmationEligible
    ? `Sinal informativo (${signal.timeframe?.toUpperCase()}) — a Range Filter disparou nesse timeframe, mas só sinais de 4H entram na fila que pode virar operação. Este aqui é só um aviso, não vai confirmar nem expirar.`
    : isExpired
      ? (knownReason ?? 'O motor não chegou a reavaliar esse sinal antes da janela fechar.')
      : (knownReason ?? 'Sinal novo — o motor está avaliando se confirma a entrada (nova checagem em ~5min).');

  const dotColor = !isConfirmationEligible ? '#60a5fa' : (isExpired ? '#64748b' : '#ffd166');
  const showGlow = isConfirmationEligible && !isExpired;

  return (
    <div className="rounded-xl p-4 space-y-2.5"
      style={{ background: 'rgba(12,15,26,0.75)', backdropFilter: 'blur(20px)', border: isBuy ? '1px solid rgba(0,255,128,0.15)' : '1px solid rgba(255,20,120,0.15)' }}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-foreground">{signal.symbol?.replace('USDT', '/USDT')}</span>
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.07)' }}>
              {signal.timeframe?.toUpperCase()}
            </span>
            {!isConfirmationEligible && (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(96,165,250,0.1)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.25)' }}>
                ℹ Só aviso
              </span>
            )}
            <span className="flex items-center gap-0.5 text-[10px] font-mono font-bold px-2 py-0.5 rounded"
              style={isBuy
                ? { background: 'rgba(0,255,128,0.1)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.25)' }
                : { background: 'rgba(255,20,120,0.1)', color: '#ff1478', border: '1px solid rgba(255,20,120,0.25)' }}>
              {isBuy ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {signal.signal_type}
            </span>
          </div>
          <div className="text-[9px] font-mono text-muted-foreground mt-0.5">{moment(signal.created_date).fromNow()}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] font-mono font-semibold text-foreground"
            title="Preço no momento em que o sinal apareceu.">${formatPrice(signal.price_at_signal)}</div>
          <SignalLivePrice symbol={signal.symbol} referencePrice={signal.price_at_signal} side={signal.signal_type} />
          <div className="text-[9px] font-mono" style={{ color: '#ffd166' }}>Score: {signal.context?.score || 0}/100</div>
        </div>
      </div>
      <div style={{ height: 1, background: 'rgba(255,255,255,0.05)' }} />
      <div className="text-[9px] font-mono text-muted-foreground leading-relaxed line-clamp-2">{signal.reason}</div>

      {/* Motivo real que está travando a entrada — SignalEvent.last_rejection_reason,
          gravado pelo próprio motor (write-on-change) a cada passada de retry.
          Só existe/faz sentido para sinais de 4H (isConfirmationEligible). */}
      <div className="flex items-start gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full mt-1 shrink-0" style={{ background: dotColor, boxShadow: showGlow ? `0 0 4px ${dotColor}` : 'none' }} />
        <span className="text-[9px] font-mono leading-relaxed" style={{ color: dotColor }}>
          {rejectionText}
        </span>
      </div>

      <div className="flex items-center justify-between text-[8px] font-mono">
        <span style={{ color: !isConfirmationEligible ? '#60a5fa' : (isExpired ? '#64748b' : 'rgba(255,255,255,0.35)') }}>
          {!isConfirmationEligible
            ? 'Sem fila de confirmação — não vira operação por aqui'
            : (isExpired ? 'Expirado — não virou operação' : `Confirma em até ${hoursLeft}h${minsLeft}m`)}
        </span>
      </div>
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
        <span className="text-[9px] font-mono text-muted-foreground hidden sm:block">{moment(op.created_date).format('DD/MM HH:mm')}</span>
      </div>
    </div>
  );
}

export default function Trades() {
  const [showHistory, setShowHistory] = useState(false);
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
    refetchInterval: 15000,
  });

  const { data: recentSignals = [] } = useQuery({
    queryKey: ['recent-signals'],
    queryFn: () => backend.entities.SignalEvent.list('-created_date', 50),
    refetchInterval: 30000,
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
    .filter(s => s.source === 'range_filter' && !activeKey.has(`${s.symbol}_${s.timeframe}`))
    .forEach(s => {
      const key = `${s.symbol}_${s.timeframe}`;
      if (!monitoringMap.has(key) || new Date(s.created_date) > new Date(monitoringMap.get(key).created_date))
        monitoringMap.set(key, s);
    });
  const monitoringList = [...monitoringMap.values()];

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
              {monitoringList.length} monitorando · {active.length} ativas · {history.length} histórico
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
        </div>

        {/* Monitoring section */}
        {monitoringList.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Eye className="w-4 h-4" style={{ color: '#ffd166' }} />
              <h2 className="text-base font-bold text-foreground">Em Monitoramento</h2>
              <span className="text-xs font-mono" style={{ color: '#ffd166' }}>
                ({applyFilters(monitoringList.map(s => ({ ...s, side: s.signal_type }))).length})
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {applyFilters(monitoringList.map(s => ({ ...s, side: s.signal_type }))).map(signal => (
                <MonitoringCard key={signal.id} signal={signal} />
              ))}
            </div>
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
                <div key={op.id} className="rounded-xl overflow-hidden"
                  style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                  <TradeCard operation={op} />
                  <LivePricePanel op={op} />

                  {/* Action buttons — always visible */}
                  <div className="flex items-center gap-1.5 p-2"
                    style={{ background: 'rgba(6,8,15,0.6)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    {/* Edit */}
                    <button
                      onClick={() => setEditingOp(op)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all hover:opacity-90"
                      style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
                      <Edit3 className="w-3 h-3" />
                      Editar
                    </button>
                    {/* Invalidar */}
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
                    {/* Encerrar */}
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
                </div>
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