import TokenIcon from '@/components/TokenIcon';
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Crown, TrendingUp, TrendingDown } from 'lucide-react';
import { fetch24hStats } from '@/lib/marketDataProvider';
import { formatPrice } from '@/lib/priceProximity';
import { describeChange24h, resolvePriceDisplay, queryChangeOptions, CHANGE_TONE_COLOR } from '@/lib/priceChange24h';
import { useNow } from '@/hooks/useNow';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { agreementLabel } from '@/lib/ruleAgreement';

const BUY = '#5db586';
const SELL = '#e06a5b';
const AMBER = '#e3b45a';
const BLUE = '#8db4e2';
const NEUTRAL = '#64748b';

// Mesmos nomes do cartão do ativo (AssetCard): "Runner ativo", "Compra ativa", "Venda ativa" — antes mostrava o código cru (RUNNER_ACTIVE).
function tradeStatusLabel(tradeOp) {
  if (tradeOp.status === 'RUNNER_ACTIVE') return 'Runner ativo';
  if (tradeOp.side === 'SELL') return 'Venda ativa';
  if (tradeOp.side === 'BUY') return 'Compra ativa';
  return 'Operação ativa';
}

function dirCfg(dir) {
  if (dir === 1) return { icon: '▲', color: BUY, label: 'Bull' };
  if (dir === -1) return { icon: '▼', color: SELL, label: 'Bear' };
  return { icon: '—', color: NEUTRAL, label: 'Neu' };
}

function computeOpportunity(states, signal, tradeOp) {
  let score = 0;
  const reasons = [];

  const tfs = ['1h', '4h', '1d'];
  const dirs = tfs.map(tf => states.find(s => s.timeframe === tf)?.rf_direction).filter(d => d !== undefined && d !== 0);
  const allAligned = dirs.length >= 2 && dirs.every(d => d === dirs[0]);
  if (allAligned) { score += 25; reasons.push('TFs alinhados'); }

  if (signal) { score += 30; reasons.push('Sinal RF ativo'); }

  const sigScore = signal?.context?.score || tradeOp?.score || 0;
  if (sigScore >= 85) { score += 15; reasons.push(agreementLabel({ score: sigScore })); }
  else if (sigScore >= 75) { score += 8; }

  const TERMINAL = ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'];
  const hasActive = tradeOp && !TERMINAL.includes(tradeOp.status);
  if (!hasActive && signal) { score += 10; reasons.push('Pronto para entrada'); }
  if (hasActive) { score -= 15; reasons.push('Já em operação'); }

  const state1h = states.find(s => s.timeframe === '1h');
  if (state1h?.rsi_zone === 'oversold' && signal?.signal_type === 'BUY') { score += 5; reasons.push('RSI sobrevenda'); }
  if (state1h?.rsi_zone === 'overbought' && signal?.signal_type === 'SELL') { score += 5; reasons.push('RSI sobrecompra'); }

  return { score, reasons, hasActive };
}

// Achado M-17 do Raio-X de UI/UX: RSI/MACD/EMA são termos técnicos "nus"
// nesta tela — prop opcional `tooltip` (mesmo padrão de `ParamCard`/
// `SummaryCard` já usado no resto do projeto) envolve a label num Tooltip
// do Radix quando presente; sem a prop, renderiza igual a antes.
/** @param {{ label: string, value: any, color?: string, tooltip?: string }} props */
function MetricRow({ label, value, color, tooltip }) {
  return (
    <div className="flex items-center justify-between py-2" style={{ borderTop: '1px solid hsl(var(--border))' }}>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs text-muted-foreground cursor-help" tabIndex={0}>{label}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-xs text-muted-foreground">{label}</span>
      )}
      <span className="text-sm font-mono font-medium tabular-nums" style={{ color: color || 'rgba(255,255,255,0.8)' }}>
        {value}
      </span>
    </div>
  );
}

function CompareColumn({ asset, states, signal, tradeOp, statsQuery, now, opp, isWinner, label, dataUnavailable }) {
  const TERMINAL = ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'];
  const hasActive = tradeOp && !TERMINAL.includes(tradeOp.status);
  const candleClose = states.find(s => s.timeframe === '1h')?.last_close || states[0]?.last_close;
  // Item 279: mesma regra do cartão (resolvePriceDisplay).
  const priceView = resolvePriceDisplay(describeChange24h(statsQuery?.data, now, queryChangeOptions(statsQuery)), candleClose);
  const score = signal?.context?.score || tradeOp?.score || 0;
  const sigSide = signal?.signal_type || tradeOp?.side;
  const oppColor = opp.score >= 50 ? BUY : opp.score >= 25 ? AMBER : NEUTRAL;
  const barWidth = Math.max(0, Math.min(100, opp.score));

  return (
    <div className="glass-card rounded-md p-5 relative" style={isWinner ? { borderColor: 'rgba(93,181,134,0.55)' } : undefined}>
      {/* Cabeçalho: letra, ativo e selo "Melhor" */}
      <div className="flex items-center gap-2.5 h-7">
        <span className="text-xs font-mono font-medium w-6 h-6 rounded flex items-center justify-center shrink-0"
          style={{ background: 'rgba(141,180,226,0.12)', color: BLUE, border: '1px solid rgba(141,180,226,0.25)' }}>
          {label}
        </span>
        <TokenIcon symbol={asset.symbol} size={22} />
        <span className="font-semibold text-base text-foreground">{asset.display_name}</span>
        {isWinner && (
          <span className="ml-auto flex items-center gap-1 text-xs font-medium px-2 py-1 rounded"
            style={{ background: 'rgba(93,181,134,0.12)', border: '1px solid rgba(93,181,134,0.3)', color: BUY }}>
            <Crown className="w-3 h-3" />Melhor
          </span>
        )}
      </div>

      {/* Preço e variação de 24h */}
      <div className="flex items-end justify-between mt-4">
        <div>
          <div className="text-2xl font-mono font-medium tabular-nums text-foreground leading-none">
            ${formatPrice(priceView.price)}
            {priceView.isCandle && <span className="text-11px font-normal text-muted-foreground"> fech. 1h</span>}
          </div>
          {/* Item 279: rótulo e fonte; sem dado, "% 24h indisponível" (nunca NaN). */}
          <div className="text-xs font-mono mt-1.5" style={{ color: CHANGE_TONE_COLOR[priceView.tone] }}>
            {priceView.pctText}
          </div>
        </div>
        {sigSide && (
          <span className="flex items-center gap-1.5 text-sm font-mono font-medium px-3 py-1.5 rounded-md"
            style={sigSide === 'BUY'
              ? { background: 'rgba(93,181,134,0.14)', color: BUY, border: '1px solid rgba(93,181,134,0.4)' }
              : { background: 'rgba(224,106,91,0.14)', color: SELL, border: '1px solid rgba(224,106,91,0.4)' }}>
            {sigSide === 'BUY' ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            {sigSide}
          </span>
        )}
      </div>

      {/* Tendência nos 3 timeframes */}
      <div className="mt-5">
        <div className="text-xs text-muted-foreground mb-2">Tendência nos 3 timeframes</div>
        <div className="flex items-center gap-2">
          {['1h', '4h', '1d'].map(tf => {
            const s = states.find(st => st.timeframe === tf);
            const d = dirCfg(s?.rf_direction);
            return (
              <div key={tf} className="flex-1 text-center rounded-md py-2.5"
                style={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))' }}>
                <div className="text-11px font-mono text-muted-foreground">{tf.toUpperCase()}</div>
                <div className="text-base font-mono font-medium" style={{ color: d.color }}>{d.icon}</div>
                <div className="text-11px font-mono" style={{ color: d.color }}>{d.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Indicadores */}
      <div className="mt-5">
        <div className="text-xs text-muted-foreground mb-1">Indicadores</div>
        {(() => {
          const s1h = states.find(s => s.timeframe === '1h');
          const s4h = states.find(s => s.timeframe === '4h');
          return (
            <>
              <MetricRow label="RF Valor (4h)" value={s4h ? `$${formatPrice(s4h.rf_filter_value)}` : '—'} color="rgba(141,180,226,0.85)" />
              <MetricRow label="RSI (1h)" value={Number.isFinite(s1h?.rsi_value) ? s1h.rsi_value.toFixed(0) : '—'}
                color={s1h?.rsi_zone === 'overbought' ? SELL : s1h?.rsi_zone === 'oversold' ? BUY : 'rgba(255,255,255,0.8)'}
                tooltip="Índice de Força Relativa: mede se o ativo está sendo comprado ou vendido com força incomum (0 a 100) — aqui, só confirmação, nunca sinal sozinho." />
              <MetricRow label="MACD Hist" value={s1h?.macd_histogram !== undefined ? (s1h.macd_histogram > 0 ? '▲ Pos' : '▼ Neg') : '—'}
                color={s1h?.macd_histogram > 0 ? BUY : s1h?.macd_histogram < 0 ? SELL : NEUTRAL}
                tooltip="Compara duas médias de preço pra indicar se a força do movimento está aumentando ou diminuindo." />
              <MetricRow label="EMA Trend" value={s1h?.trend_ema === 'bullish' ? '▲ Bull' : s1h?.trend_ema === 'bearish' ? '▼ Bear' : '— Neu'}
                color={s1h?.trend_ema === 'bullish' ? BUY : s1h?.trend_ema === 'bearish' ? SELL : NEUTRAL}
                tooltip="Média móvel exponencial — reage mais rápido a mudanças recentes que uma média comum. Quando uma EMA curta cruza uma longa, é sinal de mudança de tendência." />
              <MetricRow label="Regras" value={score > 0 ? agreementLabel({ score }) : '—'}
                color={score >= 85 ? BUY : score >= 75 ? AMBER : 'rgba(255,255,255,0.55)'} />
              <MetricRow
                label="Trade"
                value={hasActive ? tradeStatusLabel(tradeOp) : signal ? 'Aguardando' : dataUnavailable ? 'Não verificado' : 'Livre'}
                color={hasActive ? BLUE : signal ? AMBER : dataUnavailable ? '#dd9a4a' : NEUTRAL}
              />
            </>
          );
        })()}
      </div>

      {/* Oportunidade */}
      <div className="mt-5 pt-4" style={{ borderTop: '1px solid hsl(var(--border))' }}>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">Oportunidade</span>
          <span className="text-2xl font-mono font-medium tabular-nums leading-none" style={{ color: oppColor }}>{opp.score}</span>
        </div>
        <div className="h-1.5 rounded-sm mt-2.5" style={{ background: 'rgba(255,255,255,0.08)' }} role="img" aria-label={`Oportunidade ${opp.score} de 100`}>
          <div className="h-full rounded-sm" style={{ width: `${barWidth}%`, background: oppColor }} />
        </div>
        {opp.reasons.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {opp.reasons.map((r, i) => (
              <span key={i} className="text-xs px-2 py-0.5 rounded"
                style={{ background: 'rgba(93,181,134,0.08)', color: 'rgba(93,181,134,0.85)', border: '1px solid rgba(93,181,134,0.18)' }}>
                {r}
              </span>
            ))}
          </div>
        )}
        <p className="text-11px text-muted-foreground mt-3">
          Regras alinhadas e Oportunidade são pontuações das regras atuais — não são probabilidade de acerto.
        </p>
      </div>
    </div>
  );
}

export default function ComparePanel({ assetA, assetB, statesA, statesB, signalA, signalB, opA, opB, dataUnavailable = false }) {
  // Item 279: relógio próprio para o frescor. Sem intervalo de busca aqui: os
  // cartões já atualizam a mesma chave a cada 60 s (um 2º intervalo dobraria as
  // chamadas à Binance); sem cartão montado, a coluna se marca desatualizada.
  const now = useNow();
  const statsAQuery = useQuery({
    queryKey: ['24h-stats', assetA.symbol],
    queryFn: () => fetch24hStats(assetA.symbol),
    staleTime: 30000,
  });
  const statsBQuery = useQuery({
    queryKey: ['24h-stats', assetB.symbol],
    queryFn: () => fetch24hStats(assetB.symbol),
    staleTime: 30000,
  });

  const oppA = computeOpportunity(statesA, signalA, opA);
  const oppB = computeOpportunity(statesB, signalB, opB);
  const winner = oppA.score > oppB.score ? 'A' : oppB.score > oppA.score ? 'B' : null;
  const winnerAsset = winner === 'A' ? assetA : winner === 'B' ? assetB : null;

  return (
    <div className="space-y-4">
      {/* Veredito: quem tem a melhor oportunidade pelas regras de hoje */}
      <div className="glass-card rounded-md px-4 py-3 flex items-center gap-3 flex-wrap"
        style={winner ? { borderLeft: `3px solid ${BUY}` } : undefined}>
        <Crown className="w-4 h-4 shrink-0" style={{ color: winner ? BUY : NEUTRAL }} />
        {winnerAsset ? (
          <>
            <span className="text-xs text-muted-foreground">Melhor oportunidade agora</span>
            <TokenIcon symbol={winnerAsset.symbol} size={18} />
            <span className="text-sm font-semibold text-foreground">{winnerAsset.display_name}</span>
          </>
        ) : (
          <span className="text-sm text-foreground">Empate nas regras atuais</span>
        )}
        <span className="ml-auto text-xs font-mono text-muted-foreground tabular-nums">
          Oportunidade {oppA.score} × {oppB.score}
        </span>
      </div>

      {/* Colunas */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CompareColumn asset={assetA} states={statesA} signal={signalA} tradeOp={opA} statsQuery={statsAQuery} now={now} opp={oppA} isWinner={winner === 'A'} label="A" dataUnavailable={dataUnavailable} />
        <CompareColumn asset={assetB} states={statesB} signal={signalB} tradeOp={opB} statsQuery={statsBQuery} now={now} opp={oppB} isWinner={winner === 'B'} label="B" dataUnavailable={dataUnavailable} />
      </div>
    </div>
  );
}
