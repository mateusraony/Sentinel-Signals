import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { TrendingUp, TrendingDown, Zap, ChevronDown, ChevronUp } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { fetch24hStats } from '@/lib/marketDataProvider';
import { activateSignalManually } from '@/lib/scanner';
import { logError } from '@/lib/logger';
import moment from 'moment';
import ProximityBar, { calcProximity } from '@/components/dashboard/ProximityBar';
import { formatPrice, formatSignedPct } from '@/lib/priceProximity';
import { useFundingRate } from '@/hooks/useFundingRate';
import { assetHealthcheckReason } from '@/lib/assetHealthcheck';
import { closesFullyAtTp1 } from '@/lib/opExitRules';

// Duração de cada timeframe suportado (states só existem pra 1h/4h/1d —
// ver `timeframes_enabled` em MonitoredAsset). Usado só pra calcular o
// horário de ABERTURA do candle a partir do horário de fechamento
// (`last_candle_time`), que o backend só grava o fechamento.
const TF_DURATION_HOURS = { '1h': 1, '4h': 4, '1d': 24 };

// Achado A-9 do Raio-X de UI/UX: o badge LIVE/STALE usava um threshold de
// 2h fixo, arbitrário (24x maior que a cadência real de scan, ~5min) e sem
// relação com o dead-man's-switch OFICIAL do sistema
// (`assetHealthcheckReason`, `src/lib/assetHealthcheck.js`, graceMs=30min,
// já testado, já usado pelo cron pra alertar no Telegram). Texto/cor por
// motivo — 'persistent_error' (o ativo falha toda passada) é mais grave que
// 'silent' (só parou de ser tocado).
const STALE_REASON_META = {
  persistent_error: { label: '⚠️ Falha persistente', shortLabel: 'ERRO', color: '#ff1478' },
  silent: { label: '⚠️ STALE', shortLabel: 'STALE', color: '#ff9f43' },
};

// Achado M-17 do Raio-X de UI/UX: coluna do grid de preços — só TP1/TP2
// precisam de explicação (Entrada/Stop/Stop+ já são autoexplicativos em
// português). Texto reaproveitado do glossário da auditoria (seção I).
//
// Achado do Codex review no PR #430: o texto original era estático e
// descrevia sempre um runner saindo do TP1 rumo ao TP2 — falso quando a
// operação foi criada com `partial_percent: 100` (fecha 100% no TP1, sem
// runner — `runnerEnabled: false` congelado na criação) ou com
// `tp2_cap_disabled: true` (o runner ignora o teto de TP2 e segue em
// trailing, ver `scanner.js`/`opExitRules.js`). Deriva do estado REAL da
// própria operação (mesma regra pura que o motor usa,
// `closesFullyAtTp1`), nunca de config ao vivo — igual ao resto do motor.
// Exportadas (não só usadas localmente) pra teste de regressão unitário —
// testar via render+foco do Radix Tooltip provou ser lento/instável em
// jsdom neste projeto (o componente tem 3 useQuery ativos), então a lógica
// pura é testada isolada, sem depender de abrir o tooltip de verdade.
export function getTp1Tooltip(op) {
  if (op && closesFullyAtTp1(op)) {
    return 'Único alvo de lucro desta operação — fecha 100% da posição quando atingido (sem runner).';
  }
  return 'Primeiro alvo de lucro — realiza parte da posição quando atingido; o restante (runner) segue para o TP2.';
}
export function getTp2Tooltip(op) {
  if (op?.tp2_cap_disabled) {
    return 'Não usado nesta operação — o runner ignora este teto e segue em trailing, sem alvo fixo.';
  }
  if (op && closesFullyAtTp1(op)) {
    return 'Não aplicável nesta operação — a posição já foi fechada inteira no TP1 (sem runner).';
  }
  return 'Segundo e último alvo de lucro — o que sobrou da posição (runner) depois do TP1.';
}

function Dot({ color, filled = true }) {
  return (
    <span style={{
      display: 'inline-block', width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
      background: filled ? color : 'transparent',
      border: `1.5px solid ${color}`,
      boxShadow: filled ? `0 0 4px ${color}80` : 'none',
    }} />
  );
}

function IndicatorDots({ state }) {
  if (!state) return null;
  const rfDir = state.rf_direction;
  const rfColor = rfDir === 1 ? '#00ff80' : rfDir === -1 ? '#ff1478' : '#64748b';
  const rfLabel = rfDir === 1 ? 'Bull' : rfDir === -1 ? 'Bear' : 'Neu';
  const macdH = state.macd_histogram || 0;
  const macdColor = macdH > 0 ? '#00ff80' : macdH < 0 ? '#ff1478' : '#64748b';
  const emaTrend = state.trend_ema;
  const emaColor = emaTrend === 'bullish' ? '#00ff80' : emaTrend === 'bearish' ? '#ff1478' : '#ffd166';
  const rsiZone = state.rsi_zone;
  const rsiColor = rsiZone === 'overbought' ? '#ff1478' : rsiZone === 'oversold' ? '#00ff80' : '#64748b';
  const rsiVal = Number.isFinite(state.rsi_value) ? state.rsi_value.toFixed(0) : '—';

  return (
    <div className="flex items-center gap-3 sm:gap-2 flex-wrap">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1 cursor-help" tabIndex={0}>
            <Dot color={rfColor} />
            <span className="text-10px font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>RF</span>
            <span className="text-10px font-mono font-semibold" style={{ color: rfColor }}>{rfLabel}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
          Range Filter: indicador que filtra o ruído do preço e define uma banda de tendência — o sistema só considera um movimento válido quando o preço rompe essa banda de forma consistente.
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1 cursor-help" tabIndex={0}>
            <Dot color={macdColor} />
            <span className="text-10px font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>MACD</span>
            <span className="text-10px font-mono" style={{ color: macdColor }}>{macdH > 0 ? '▲' : macdH < 0 ? '▼' : '—'}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
          MACD: compara duas médias de preço pra indicar se a força do movimento está aumentando ou diminuindo.
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1 cursor-help" tabIndex={0}>
            <Dot color={emaColor} />
            <span className="text-10px font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>EMA</span>
            <span className="text-10px font-mono" style={{ color: emaColor }}>{emaTrend === 'bullish' ? '▲' : emaTrend === 'bearish' ? '▼' : '—'}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
          EMA: média móvel exponencial — reage mais rápido a mudanças recentes que uma média comum. Quando uma EMA curta cruza uma longa, é sinal de mudança de tendência.
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1 cursor-help" tabIndex={0}>
            <Dot color={rsiColor} filled={rsiZone !== 'neutral'} />
            <span className="text-10px font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>RSI</span>
            <span className="text-10px font-mono" style={{ color: rsiColor }}>{rsiVal}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
          RSI (Índice de Força Relativa): mede se o ativo está sendo comprado ou vendido com força incomum (0 a 100) — aqui, só confirmação, nunca sinal sozinho.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Multi-TF trend mini row — shown as subtle overlay on hover */
function TFTrendRow({ states }) {
  const tfs = ['1h', '4h', '1d'];
  return (
    <div className="flex items-center gap-2.5 flex-wrap">
      {tfs.map(tf => {
        const s = states?.find(st => st.timeframe === tf);
        if (!s) return (
          <span key={tf} className="text-9px font-mono" style={{ color: 'rgba(255,255,255,0.18)' }}>
            {tf.toUpperCase()} —
          </span>
        );
        const dir = s.rf_direction;
        const color = dir === 1 ? '#00ff80' : dir === -1 ? '#ff1478' : '#64748b';
        const arrow = dir === 1 ? '▲' : dir === -1 ? '▼' : '—';
        const label = dir === 1 ? 'Bull' : dir === -1 ? 'Bear' : 'Neu';
        return (
          <span key={tf} className="flex items-center gap-0.5 text-9px font-mono">
            <span style={{ color: 'rgba(255,255,255,0.3)' }}>{tf.toUpperCase()}</span>
            <span style={{ color }}>{arrow}{label}</span>
          </span>
        );
      })}
    </div>
  );
}

// Achado A-15 do Raio-X de UI/UX: o card mostrava ~20+ blocos de
// informação de uma vez, bem acima da faixa de 5-9 elementos já validada
// (com pesquisa) pro TradeCard.jsx — card de operação, referência de
// qualidade do projeto. Tendência multi-TF, funding rate e os dots de
// indicador (RF/MACD/EMA/RSI) são legítimos, mas não essenciais pro
// primeiro olhar (nenhum é lido por outro componente) — ficam atrás de um
// toggle "Detalhes técnicos", mesmo padrão de divulgação progressiva já
// usado em TradeCard.jsx (useState local + render condicional, sem CSS
// hidden).
function Details({ states, fundingRate, nextFundingTime, primaryState }) {
  return (
    <div className="mb-2.5">
      <div className="mb-1.5">
        <TFTrendRow states={states} />
      </div>
      {fundingRate !== null && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="text-8px font-mono mb-1.5 cursor-help" tabIndex={0} style={{ color: 'rgba(255,255,255,0.3)' }}>
              Fund.: <span style={{ color: fundingRate >= 0 ? '#00ff80' : '#ff1478' }}>{formatSignedPct(fundingRate * 100, 4)}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
            {`Funding rate (Futures): taxa paga entre posições compradas e vendidas a cada 8h. Só informativo — não influencia nenhum sinal ou operação.${nextFundingTime ? ` Próximo: ${moment(nextFundingTime).utcOffset(-3).format('DD/MM HH:mm')} BRT.` : ''}`}
          </TooltipContent>
        </Tooltip>
      )}
      <div className="mb-1.5" style={{ height: 1, background: 'rgba(255,255,255,0.05)' }} />
      <IndicatorDots state={primaryState} />
    </div>
  );
}

export default function AssetCard({ asset, states, latestSignal, tradeOp, tradeOpsUnavailable = false, onClick, expandAll = false }) {
  const queryClient = useQueryClient();
  const availableTfs = states?.map(s => s.timeframe).filter(Boolean) || [];
  const defaultTf = availableTfs.includes('1h') ? '1h' : availableTfs[0] || '1h';
  const [selectedTf, setSelectedTf] = useState(defaultTf);
  const [open, setOpen] = useState(expandAll);
  useEffect(() => { setOpen(expandAll); }, [expandAll]);
  const state1h = states?.find(s => s.timeframe === '1h');
  const state4h = states?.find(s => s.timeframe === '4h');
  const primaryState = states?.find(s => s.timeframe === selectedTf) || state1h || state4h || states?.[0];

  const { data: stats24h } = useQuery({
    queryKey: ['24h-stats', asset.symbol],
    queryFn: () => fetch24hStats(asset.symbol),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const { fundingRate, nextFundingTime } = useFundingRate(asset.symbol);

  // "Activate signal" mutation — delega ao motor (activateSignalManually).
  //
  // Antes criava a TradeOperation aqui, com `TradeOperation.create` cru e
  // 50/50 fixos: a operação nascia SEM stop, SEM tp1/tp2 e SEM o ponteiro
  // `assetActiveOps`, ou seja, inoperável pelos loops de saída e capaz de
  // colidir com uma operação do scanner no mesmo ativo — o que suspende a
  // gestão daquele ativo (guarda do item 39.1). Ver known-risks item 46.5.
  //
  // Regra desta pasta: componente não implementa lógica de trading. O motor
  // calcula stop/alvo/tier e cria pelo caminho transacional único.
  const activateMutation = useMutation({
    mutationFn: (sig) => activateSignalManually(sig, asset),
    onSuccess: (res) => {
      if (!res?.created) {
        const msg = res?.reason === 'no_4h_atr'
          ? 'Não foi possível ativar: sem dados de ATR no 4h para calcular o stop.'
          : res?.reason === 'active_op_exists'
            ? 'Não foi possível ativar: já existe uma operação ativa neste ativo.'
            : 'Não foi possível ativar a operação.';
        window.alert(msg);
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['trade-operations'] });
      queryClient.invalidateQueries({ queryKey: ['trade-operations-dashboard'] });
    },
    onError: (err) => {
      logError('AssetCard', `Falha ao ativar operação manual em ${asset.symbol}`, { error: err.message });
      window.alert('Falha ao ativar a operação. Veja o Debug Log.');
    },
  });

  const lastPrice = primaryState?.last_close;
  const priceChange = stats24h?.priceChangePercent;

  const healthReason = assetHealthcheckReason(asset); // 'persistent_error' | 'silent' | null
  const isStale = Boolean(healthReason);
  const staleMeta = healthReason ? STALE_REASON_META[healthReason] : null;

  const TERMINAL = ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'];
  const hasActiveOp = tradeOp && !TERMINAL.includes(tradeOp.status);
  const opSide = tradeOp?.side;
  const sigSide = latestSignal?.signal_type;
  const isBuy = (opSide || sigSide) === 'BUY';
  const isSell = (opSide || sigSide) === 'SELL';

  const score = tradeOp?.score || latestSignal?.context?.score || 0;

  // Flash animation
  const [flashing, setFlashing] = useState(false);
  const prevTradeOpId = useRef(null);
  useEffect(() => {
    if (hasActiveOp && tradeOp?.id !== prevTradeOpId.current) {
      const age = tradeOp?.created_date ? Date.now() - new Date(tradeOp.created_date).getTime() : Infinity;
      if (age < 5 * 60 * 1000) {
        setFlashing(true);
        const t = setTimeout(() => setFlashing(false), 4000);
        prevTradeOpId.current = tradeOp.id;
        return () => clearTimeout(t);
      }
      prevTradeOpId.current = tradeOp.id;
    }
  }, [tradeOp?.id, hasActiveOp]);

  // Signal flash for new signals without trade op (< 3min)
  const [sigFlashing, setSigFlashing] = useState(false);
  const prevSigId = useRef(null);
  useEffect(() => {
    if (latestSignal && !hasActiveOp && latestSignal.id !== prevSigId.current) {
      const age = latestSignal.created_date ? Date.now() - new Date(latestSignal.created_date).getTime() : Infinity;
      if (age < 3 * 60 * 1000) {
        setSigFlashing(true);
        const t = setTimeout(() => setSigFlashing(false), 3000);
        prevSigId.current = latestSignal.id;
        return () => clearTimeout(t);
      }
      prevSigId.current = latestSignal.id;
    }
  }, [latestSignal?.id, hasActiveOp]);

  let statusLabel = null;
  let statusColor = '#64748b';
  if (isStale) {
    statusLabel = staleMeta.label; statusColor = staleMeta.color;
  } else if (hasActiveOp) {
    if (tradeOp.status === 'RUNNER_ACTIVE') { statusLabel = '⚡ Runner Ativo'; statusColor = '#00e5ff'; }
    else if (opSide === 'BUY') { statusLabel = '🟢 Compra Ativa'; statusColor = '#00ff80'; }
    else { statusLabel = '🔴 Venda Ativa'; statusColor = '#ff1478'; }
  } else if (latestSignal) {
    statusLabel = sigSide === 'BUY' ? '👀 Observando BUY' : '👀 Observando SELL';
    statusColor = sigSide === 'BUY' ? 'rgba(0,255,128,0.65)' : 'rgba(255,20,120,0.65)';
  }

  // Proximidade à zona de entrada só faz sentido antes de já ter posição
  // aberta — uma vez com operação ativa, "distância até o filtro" deixa de
  // ser informação acionável.
  const proximity = !hasActiveOp && primaryState ? calcProximity(primaryState) : null;

  const showBadge = hasActiveOp ? opSide : (latestSignal ? sigSide : null);
  const strengthMap = { strong: '🔥 Forte', moderate: '⚡ Mod.', weak: '〰 Fraco' };
  const strengthLabel = strengthMap[latestSignal?.strength] || '⚡ Mod.';

  const candleCloseTime = primaryState?.last_candle_time;
  // Achado A-2 do Raio-X de UI/UX: subtraía 1h fixo do fechamento pra achar
  // a abertura, certo só pro TF 1h — pra 4h/1d mostrava uma janela de
  // candle errada (ex.: um candle 4h aparecia como se durasse 1h).
  const candleDurationHours = TF_DURATION_HOURS[primaryState?.timeframe] ?? 1;
  const candleOpen = candleCloseTime ? moment(candleCloseTime).utcOffset(-3).subtract(candleDurationHours, 'hours').format('DD/MM HH:mm') : null;
  const candleClose = candleCloseTime ? moment(candleCloseTime).utcOffset(-3).format('HH:mm') : null;

  // Border & glow
  let cardBorder = 'rgba(255,255,255,0.06)';
  let cardGlow = 'none';
  let flashStyle = '';
  let zonePulseVars = {};
  if (flashing || sigFlashing) {
    const fc = isBuy ? '#00ff80' : '#ff1478';
    cardBorder = fc;
    cardGlow = `0 0 30px ${fc}60, 0 0 60px ${fc}30`;
    flashStyle = isBuy ? 'flash-buy' : 'flash-sell';
  } else if (proximity?.level === 'very_close') {
    // Marcador vibrante: ativo entrando na zona de sinal do Range Filter
    // (preço a <1% do filtro) — mesma cor do lado (BUY/SELL) que a
    // ProximityBar já usa, via signal-zone-pulse (src/index.css).
    const zc = proximity.side === 'BUY' ? '#00ff80' : '#ff1478';
    cardBorder = `${zc}55`;
    cardGlow = `0 0 16px ${zc}25`;
    flashStyle = 'signal-zone-pulse';
    zonePulseVars = { '--zone-glow-color': `${zc}70` };
  } else if (hasActiveOp && isBuy) {
    cardBorder = 'rgba(0,255,128,0.22)'; cardGlow = '0 0 20px rgba(0,255,128,0.07)';
  } else if (hasActiveOp && isSell) {
    cardBorder = 'rgba(255,20,120,0.22)'; cardGlow = '0 0 20px rgba(255,20,120,0.07)';
  } else if (latestSignal && !hasActiveOp) {
    const bc = sigSide === 'BUY' ? 'rgba(0,255,128,0.12)' : 'rgba(255,20,120,0.12)';
    cardBorder = bc;
  } else if (isStale) {
    cardBorder = healthReason === 'persistent_error' ? 'rgba(255,20,120,0.22)' : 'rgba(255,159,67,0.22)';
  }

  const priceVals = hasActiveOp
    ? [tradeOp.entry_price, tradeOp.initial_stop, tradeOp.tp1, tradeOp.tp2, tradeOp.current_stop]
    : [null, null, null, null, null];
  const priceColColors = [
    'rgba(255,255,255,0.75)', '#ff1478',
    tradeOp?.tp1_hit ? '#00ff80' : '#ffd166',
    tradeOp?.tp2_hit ? '#00ff80' : 'rgba(255,209,102,0.55)',
    tradeOp?.tp1_hit ? '#ffd166' : '#ff1478',
  ];
  const priceColTooltips = {
    TP1: getTp1Tooltip(tradeOp),
    TP2: getTp2Tooltip(tradeOp),
  };

  const candleStatus = tradeOp?.candle_status || 'CLOSED';

  return (
    <>
      <style>{`
        @keyframes flash-buy { 0%,100%{box-shadow:0 0 20px rgba(0,255,128,0.07)} 50%{box-shadow:0 0 40px rgba(0,255,128,0.5),0 0 80px rgba(0,255,128,0.2)} }
        @keyframes flash-sell { 0%,100%{box-shadow:0 0 20px rgba(255,20,120,0.07)} 50%{box-shadow:0 0 40px rgba(255,20,120,0.5),0 0 80px rgba(255,20,120,0.2)} }
        .flash-buy { animation: flash-buy 0.8s ease-in-out 5; }
        .flash-sell { animation: flash-sell 0.8s ease-in-out 5; }
        @media (prefers-reduced-motion: reduce) {
          .flash-buy, .flash-sell { animation: none; }
        }
      `}</style>
      <div
        role="button"
        tabIndex={0}
        aria-label={`${asset.display_name} — abrir detalhes`}
        className={`rounded-xl p-4 relative overflow-hidden transition-all duration-300 cursor-pointer hover:scale-[1.01] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${flashStyle}`}
        onClick={onClick}
        onKeyDown={(e) => {
          // Achado A-8 do Raio-X de UI/UX: card só abria por clique de
          // mouse. Ignora key events que borbulharem dos 2 botões filhos
          // (TF Quick Switcher, "Ativar sinal") — eles já tratam o próprio
          // Enter/Space nativamente; sem isso, o card duplicaria a ação.
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); }
        }}
        style={{ background: 'rgba(10,13,22,0.82)', backdropFilter: 'blur(20px)', border: `1px solid ${cardBorder}`, boxShadow: cardGlow, ...zonePulseVars }}>

        {/* Row 1: Symbol + Price */}
        <div className="flex items-start justify-between mb-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-bold text-sm text-foreground tracking-tight">{asset.display_name}</span>
              <span className="text-8px font-mono text-muted-foreground">{asset.exchange?.toUpperCase() || 'BINANCE'}</span>
              <span className="flex items-center gap-0.5">
                <span style={{ width: 5, height: 5, borderRadius: '50%', display: 'inline-block', background: isStale ? staleMeta.color : '#00ff80', boxShadow: isStale ? 'none' : '0 0 5px #00ff80' }} />
                <span className="text-8px font-mono" style={{ color: isStale ? staleMeta.color : '#00ff80' }}>{isStale ? staleMeta.shortLabel : 'LIVE'}</span>
              </span>
              {tradeOpsUnavailable && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex items-center gap-0.5 cursor-help" tabIndex={0}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', display: 'inline-block', background: '#ff9f43' }} />
                      <span className="text-8px font-mono" style={{ color: '#ff9f43' }}>OP?</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
                    Não foi possível confirmar operações ativas agora — o status abaixo pode estar desatualizado.
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {candleCloseTime && (
              <div className="text-8px font-mono text-muted-foreground mt-0.5">🕐 {candleOpen} → {candleClose} BRT</div>
            )}
          </div>
          <div className="text-right shrink-0 ml-2">
            {lastPrice ? (
              <>
                <div className="font-bold font-mono text-sm text-foreground">${formatPrice(lastPrice)}</div>
                {priceChange !== undefined && priceChange !== null && (
                  <div className="text-10px font-mono" style={{ color: priceChange >= 0 ? '#00ff80' : '#ff1478' }}>
                    {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}%
                  </div>
                )}
              </>
            ) : <span className="text-xs text-muted-foreground">—</span>}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="text-8px font-mono mt-0.5 cursor-help" tabIndex={0} style={{ color: 'rgba(255,255,255,0.3)' }}>
                  Confl.: <span style={{ color: score >= 85 ? '#00ff80' : score >= 65 ? '#ffd166' : '#ff9f43' }}>{score}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
                Confluência de indicadores técnicos alinhados — não é uma probabilidade de acerto do trade.
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* TF Quick Switcher — larger touch targets for mobile */}
        {availableTfs.length > 0 && (
          <div className="flex items-center gap-1.5 mb-2">
            {['1h','4h','1d'].filter(tf => availableTfs.includes(tf)).map(tf => {
              const tfState = states?.find(s => s.timeframe === tf);
              const rfDir = tfState?.rf_direction;
              const dirColor = rfDir === 1 ? '#00ff80' : rfDir === -1 ? '#ff1478' : null;
              const isSelected = selectedTf === tf;
              return (
                <button key={tf}
                  onClick={e => { e.stopPropagation(); setSelectedTf(tf); }}
                  className="flex items-center gap-1 text-xs font-mono font-bold px-3 py-1.5 rounded-lg transition-all hover:scale-105"
                  style={isSelected
                    ? { background: 'rgba(0,229,255,0.18)', border: '1px solid rgba(0,229,255,0.45)', color: '#00e5ff', minWidth: 44 }
                    : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.3)', minWidth: 44 }}>
                  {tf.toUpperCase()}
                  {dirColor && <span style={{ color: dirColor, fontSize: 10 }}>{rfDir === 1 ? '▲' : '▼'}</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* Signal badge + status — larger for touch, wraps gracefully on mobile */}
        <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            {showBadge && (
              <span className="flex items-center gap-1 text-sm font-mono font-bold px-4 py-1.5 rounded-lg"
                style={showBadge === 'BUY'
                  ? { background: 'rgba(0,255,128,0.15)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.4)', boxShadow: '0 0 12px rgba(0,255,128,0.15)' }
                  : { background: 'rgba(255,20,120,0.15)', color: '#ff1478', border: '1px solid rgba(255,20,120,0.4)', boxShadow: '0 0 12px rgba(255,20,120,0.15)' }}>
                {showBadge === 'BUY' ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                {showBadge}
              </span>
            )}
            {latestSignal && !hasActiveOp && (
              <span className="text-10px font-mono px-2 py-1 rounded"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.45)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {strengthLabel}
              </span>
            )}
          </div>
          {statusLabel && (
            <span className="text-10px font-mono font-semibold text-right" style={{ color: statusColor }}>{statusLabel}</span>
          )}
        </div>

        {/* Proximity indicator — mostra sempre que há proximidade e ainda não
            existe posição aberta, mesmo com um sinal pendente (latestSignal),
            para destacar a zona de sinal em vez de escondê-la. */}
        {!hasActiveOp && primaryState && (
          <ProximityBar state={primaryState} />
        )}

        {/* Candle status */}
        {hasActiveOp && (
          <div className="text-8px font-mono mb-2" style={{ color: candleStatus === 'OPEN' ? '#ff9f43' : 'rgba(255,255,255,0.3)' }}>
            {candleStatus === 'OPEN' ? '⏳ Candle aberto — aguardando fechamento' : '✅ Candle fechado'}
          </div>
        )}

        <div className="mb-2.5" style={{ height: 1, background: 'rgba(255,255,255,0.05)' }} />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
          aria-expanded={open}
          className="flex items-center gap-1 text-8px font-mono mb-2.5 transition-colors hover:text-foreground"
          style={{ color: 'rgba(255,255,255,0.35)' }}>
          {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {open ? 'Menos detalhes' : 'Detalhes técnicos'}
        </button>
        {open && (
          <Details states={states} fundingRate={fundingRate} nextFundingTime={nextFundingTime} primaryState={primaryState} />
        )}

        {/* Price grid — responsive, scrollable on very small screens */}
        <div className="grid grid-cols-5 gap-1 mb-2.5 overflow-x-auto">
          {['Entrada', 'Stop', 'TP1', 'TP2', 'Stop+'].map((col, i) => (
            <div key={col} className="text-center px-1 py-1.5 rounded min-w-[48px]"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.04)' }}>
              {priceColTooltips[col] ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="text-8px font-mono text-muted-foreground mb-0.5 leading-tight truncate cursor-help" tabIndex={0}>{col}</div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
                    {priceColTooltips[col]}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <div className="text-8px font-mono text-muted-foreground mb-0.5 leading-tight truncate">{col}</div>
              )}
              <div className="text-10px font-mono font-semibold" style={{ color: priceVals[i] ? priceColColors[i] : 'rgba(255,255,255,0.15)' }}>
                {formatPrice(priceVals[i])}
              </div>
            </div>
          ))}
        </div>

        {/* Runner progress */}
        {hasActiveOp && tradeOp.status === 'RUNNER_ACTIVE' && (
          <div className="rounded-lg px-3 py-2 mb-2.5" style={{ background: 'rgba(0,229,255,0.05)', border: '1px solid rgba(0,229,255,0.15)' }}>
            <div className="flex items-center justify-between text-9px font-mono">
              <span style={{ color: '#00ff80' }}>✅ TP1 + {tradeOp.partial_percent || 50}% realizados</span>
              <span style={{ color: '#ffd166' }}>⚡ {tradeOp.runner_percent || 50}% em runner</span>
            </div>
          </div>
        )}

        {/* Activate button — only for signals without active op */}
        {latestSignal && !hasActiveOp && !isStale && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              // O aviso diz a verdade sobre a gestão: qualquer que seja o
              // sinal que motivou o clique, a operação é gerida pelas regras
              // da cascata RF 4h (stop ATR×tier do 4h, Time Stop em barras de
              // 4h) — é a única gestão que o motor sabe aplicar a partir de um
              // clique. Ver known-risks item 46.5.
              if (window.confirm(
                `Ativar operação ${sigSide} em ${asset.display_name}?\n\n`
                + 'A entrada usa o preço ATUAL de mercado, e a operação será gerida '
                + 'pelas regras da cascata 4h (stop por ATR/tier, TP1/TP2 e Time Stop).'
              )) activateMutation.mutate(latestSignal);
            }}
            disabled={activateMutation.isPending}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-11px font-mono font-bold mt-1 transition-all"
            style={sigSide === 'BUY'
              ? { background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }
              : { background: 'rgba(255,20,120,0.1)', border: '1px solid rgba(255,20,120,0.3)', color: '#ff1478' }}>
            <Zap className="w-3 h-3" />
            {activateMutation.isPending ? 'Ativando...' : `Ativar ${sigSide} agora`}
          </button>
        )}

        {/* Click hint */}
        <div className="absolute bottom-1.5 right-2.5 text-7px font-mono opacity-0 hover:opacity-100 transition-opacity" style={{ color: 'rgba(255,255,255,0.15)' }}>
          detalhes →
        </div>
      </div>
    </>
  );
}