import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Sparkles, TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react';
import { backend } from '@/api/entities';
import { summarizeOps } from '@/lib/tradeMetrics';

// Mesmo gate de amostra/IC dos relatórios e do LiveConfidenceCard
// (summarizeOps, minTrades=30 + IC95 da expectância). Abaixo disso a amostra
// é ruído; e operações simultâneas são correlacionadas (N efetivo ≈ N/3,
// docs/roadmap.md), então mesmo n≥30 costuma ser INCONCLUSIVO.
const SCORE_TOLERANCE = 15;
const SCORE_BUCKET_SIZE = 20;
// Terminal TradeOperation statuses (.claude/rules/trading-engine.md) — the
// only ones classifyOutcome can score.
const TERMINAL_STATUSES = ['TP2_HIT', 'STOP_HIT', 'INVALIDATED', 'CLOSED'];
// Explicit, documented cap (not unbounded) — consistent with the project's
// Firestore quota posture (.claude/rules/firestore-concurrency.md).
const HISTORY_LIMIT = 500;

// TradeOperation does NOT store rsi/macd_histogram at entry (only
// SignalEvent.context does) — those fields don't exist to match against
// historical operations. tf_4h_direction IS on both (SignalEvent.context and
// TradeOperation, copied at entry — see TradeOperation.jsonc), so it's used
// here as the trend-alignment dimension instead of a fabricated RSI/MACD
// match.
function isSimilarShape(op, signal) {
  if (op.side !== signal.signal_type) return false;
  const opTf = op.signal_timeframe || op.timeframe;
  if (opTf !== signal.timeframe) return false;
  const sigDir = signal.context?.tf_4h_direction;
  if (Number.isFinite(sigDir) && Number.isFinite(op.tf_4h_direction) && op.tf_4h_direction !== sigDir) {
    return false;
  }
  return true;
}

function scoreOf(op) {
  return Number.isFinite(op.entry_score) ? op.entry_score : (Number.isFinite(op.score) ? op.score : null);
}

export default function PredictiveAnalysis({ recentSignals = [], signalsUnavailable = false }) {
  // Dedicated query instead of reusing the Dashboard's `tradeOps` prop — that
  // list is capped at 100 most-recently-CREATED operations and mixes
  // active+closed, so with more than ~100 operations total it could hand
  // this feature a closed-operation sample that's small and skewed toward
  // recent history, silently misreporting "amostra insuficiente" or a biased
  // win rate as if it were the full historical picture (Codex review, PR
  // #159 follow-up). Filtering by terminal status server-side also means
  // isClosedOp doesn't need to be re-applied client-side.
  const { data: historicalClosed = [] } = useQuery({
    queryKey: ['trade-operations-history-predictive'],
    queryFn: () => backend.entities.TradeOperation.filter({ status: TERMINAL_STATUSES }, '-created_date', HISTORY_LIMIT),
    staleTime: 60000,
  });

  const candidates = useMemo(() => {
    // Most recent RF signal per asset, highest score first — same "alta
    // prioridade" candidates the Dashboard/Telegram already surface.
    const bySignalAsset = new Map();
    for (const s of recentSignals) {
      if (s.source !== 'range_filter') continue;
      const existing = bySignalAsset.get(s.asset_id);
      if (!existing || new Date(s.created_date) > new Date(existing.created_date)) {
        bySignalAsset.set(s.asset_id, s);
      }
    }
    return [...bySignalAsset.values()].sort((a, b) => (b.context?.score || 0) - (a.context?.score || 0));
  }, [recentSignals]);

  const [selectedId, setSelectedId] = useState(null);
  const selected = useMemo(() => {
    if (selectedId) return candidates.find(c => c.id === selectedId) || candidates[0] || null;
    // Default: highest-priority, then highest-score candidate.
    return [...candidates].sort((a, b) => {
      if (a.priority === 'high' && b.priority !== 'high') return -1;
      if (b.priority === 'high' && a.priority !== 'high') return 1;
      return (b.context?.score || 0) - (a.context?.score || 0);
    })[0] || null;
  }, [candidates, selectedId]);

  const { sameShape, matches, headline } = useMemo(() => {
    if (!selected) return { sameShape: [], matches: [], headline: null };
    const shape = historicalClosed.filter(op => isSimilarShape(op, selected));
    const selectedScore = selected.context?.score;
    const scored = Number.isFinite(selectedScore)
      ? shape.filter(op => {
          const s = scoreOf(op);
          return s !== null && Math.abs(s - selectedScore) <= SCORE_TOLERANCE;
        })
      : shape;
    return { sameShape: shape, matches: scored, headline: summarizeOps(scored) };
  }, [selected, historicalClosed]);

  const scoreBuckets = useMemo(() => {
    const buckets = new Map();
    for (const op of sameShape) {
      const s = scoreOf(op);
      if (s === null) continue;
      const bucketStart = Math.min(80, Math.floor(s / SCORE_BUCKET_SIZE) * SCORE_BUCKET_SIZE);
      const key = `${bucketStart}-${bucketStart + SCORE_BUCKET_SIZE}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(op);
    }
    return [...buckets.entries()]
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .map(([label, ops]) => {
        const s = summarizeOps(ops);
        return { label, winRate: s.counted > 0 ? s.winRate : null, n: s.counted, minTrades: s.minTrades };
      })
      .filter(b => b.n > 0);
  }, [sameShape]);

  if (candidates.length === 0 && signalsUnavailable) {
    return (
      <div className="glass-card rounded-xl p-8 text-center">
        <AlertTriangle className="w-8 h-8 mx-auto mb-3" style={{ color: '#ff9f43', opacity: 0.6 }} />
        <p className="text-muted-foreground text-sm">Não foi possível carregar os sinais recentes agora — falha ao atualizar.</p>
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div className="glass-card rounded-xl p-8 text-center">
        <Sparkles className="w-8 h-8 mx-auto mb-3 text-muted-foreground opacity-30" />
        <p className="text-muted-foreground text-sm">Nenhum sinal recente do Range Filter para analisar.</p>
        <p className="text-xs text-muted-foreground mt-1">Assim que um sinal for detectado, ele aparece aqui comparado ao histórico.</p>
      </div>
    );
  }

  const minTrades = headline?.minTrades ?? 30;
  const enoughSample = Boolean(headline) && headline.counted >= minTrades && headline.rCounted > 0;
  const ci = headline?.expectancyRCI95;
  const conclusive = Boolean(headline?.conclusive);
  const signColor = headline?.expectancyR >= 0 ? '#00ff80' : '#ff1478';
  const badgeColor = conclusive ? signColor : '#ffd166';
  const badgeLabel = conclusive ? (headline.expectancyR >= 0 ? 'CONCLUSIVO +' : 'CONCLUSIVO −') : 'INCONCLUSIVO';

  return (
    <div className="space-y-4">
      {/* Selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <Sparkles className="w-4 h-4" style={{ color: '#00e5ff' }} />
        <span className="text-11px font-mono text-muted-foreground">Analisando:</span>
        <select
          value={selected?.id || ''}
          onChange={e => setSelectedId(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg text-11px font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(0,229,255,0.2)', color: 'rgba(255,255,255,0.85)' }}>
          {candidates.map(c => (
            <option key={c.id} value={c.id}>
              {c.symbol?.replace('USDT', '/USDT')} · {c.timeframe?.toUpperCase()} · {c.signal_type} · Score {c.context?.score ?? '—'}
            </option>
          ))}
        </select>
      </div>

      {selected && (
        <>
          {/* Gauge */}
          <div className="glass-card rounded-xl p-5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {selected.signal_type === 'BUY'
                  ? <TrendingUp className="w-4 h-4" style={{ color: '#00ff80' }} />
                  : <TrendingDown className="w-4 h-4" style={{ color: '#ff1478' }} />}
                <span className="text-sm font-bold text-foreground">
                  {selected.symbol?.replace('USDT', '/USDT')} — {selected.signal_type} {selected.timeframe?.toUpperCase()}
                </span>
              </div>
              <span className="text-10px font-mono text-muted-foreground">
                {matches.length} operaç{matches.length === 1 ? 'ão' : 'ões'} similar{matches.length === 1 ? '' : 'es'}
              </span>
            </div>

            {!enoughSample ? (
              <div className="flex items-center gap-2 py-3 text-11px font-mono" style={{ color: 'rgba(255,209,102,0.85)' }}>
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                Amostra insuficiente ({headline?.counted ?? 0}/{minTrades} operações fechadas com direção, timeframe
                {Number.isFinite(selected.context?.tf_4h_direction) ? ', alinhamento 4h' : ''} e score ±{SCORE_TOLERANCE} similares) —
                não há dado suficiente para uma estimativa confiável.
              </div>
            ) : (
              <>
                <div className="flex items-baseline gap-2 mb-1.5 flex-wrap">
                  <span className="text-3xl font-bold font-mono" style={{ color: conclusive ? signColor : 'rgba(255,255,255,0.85)' }}>
                    {`${headline.expectancyR >= 0 ? '+' : ''}${headline.expectancyR.toFixed(3)}R`}
                  </span>
                  <span className="text-11px font-mono text-muted-foreground">expectância histórica em padrões similares</span>
                  <span className="text-8px font-mono px-1.5 py-0.5 rounded"
                    style={{ background: `${badgeColor}18`, border: `1px solid ${badgeColor}40`, color: badgeColor }}>
                    {badgeLabel}
                  </span>
                </div>
                <p className="text-10px font-mono text-muted-foreground mb-3">
                  {headline.counted} operações{ci ? ` · IC95 [${ci[0].toFixed(3)}; ${ci[1].toFixed(3)}]` : ''} · taxa de acerto {headline.winRate.toFixed(0)}%
                  {' '}(taxa de acerto não é expectância — com TP1 parcial ela pode ser alta com R líquido negativo)
                </p>
              </>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
              <div className="rounded-lg p-2.5" style={{ background: 'rgba(0,255,128,0.06)', border: '1px solid rgba(0,255,128,0.15)' }}>
                <div className="text-9px font-mono text-muted-foreground mb-0.5">Vitórias</div>
                <div className="text-base font-bold" style={{ color: '#00ff80' }}>{headline?.wins ?? 0}</div>
              </div>
              <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,20,120,0.06)', border: '1px solid rgba(255,20,120,0.15)' }}>
                <div className="text-9px font-mono text-muted-foreground mb-0.5">Derrotas</div>
                <div className="text-base font-bold" style={{ color: '#ff1478' }}>{headline?.losses ?? 0}</div>
              </div>
              <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="text-9px font-mono text-muted-foreground mb-0.5 flex items-center gap-1"><Minus className="w-2.5 h-2.5" />Breakeven</div>
                <div className="text-base font-bold text-foreground">{headline?.be ?? 0}</div>
              </div>
              <div className="rounded-lg p-2.5" style={{ background: 'rgba(0,229,255,0.06)', border: '1px solid rgba(0,229,255,0.15)' }}>
                <div className="text-9px font-mono text-muted-foreground mb-0.5">R médio</div>
                <div className="text-base font-bold" style={{ color: '#00e5ff' }}>
                  {Number.isFinite(headline?.expectancyR) ? `${headline.expectancyR >= 0 ? '+' : ''}${headline.expectancyR.toFixed(2)}R` : '—'}
                </div>
              </div>
            </div>
          </div>

          {/* Score bucket chart */}
          {scoreBuckets.length > 0 && (
            <div className="glass-card rounded-xl p-4">
              <h3 className="text-xs font-bold text-foreground mb-3">Taxa de acerto por faixa de score — {selected.signal_type} {selected.timeframe?.toUpperCase()}</h3>
              <div role="img" aria-label={`Gráfico de barras da taxa de acerto por faixa de score, para ${selected.signal_type} ${selected.timeframe?.toUpperCase()}: ${scoreBuckets.map(b => `faixa ${b.label} pontos, ${b.winRate.toFixed(0)}% de acerto em ${b.n} operaç${b.n === 1 ? 'ão' : 'ões'}`).join('; ')}`}>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={scoreBuckets} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.4)' }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ background: 'rgba(6,8,15,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11 }}
                      formatter={(value, name, props) => [`${Number(value).toFixed(0)}% (${props.payload.n} op.)`, 'Taxa de acerto']}
                    />
                    <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                      {scoreBuckets.map((b, i) => (
                        <Cell key={i} fill="#00e5ff" fillOpacity={b.n >= b.minTrades ? 0.85 : 0.3} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="text-10px font-mono text-muted-foreground mt-1">
                Cada barra é uma faixa de score de {SCORE_BUCKET_SIZE} pontos, entre operações fechadas com a mesma direção/timeframe do sinal selecionado.
                Barras apagadas têm menos de {scoreBuckets[0]?.minTrades ?? 30} operações — indicativo, não conclusivo.
              </p>
            </div>
          )}

          <p className="text-10px font-mono text-muted-foreground">
            Estimativa baseada em confluência de indicadores e desempenho histórico de padrões similares — não é garantia de resultado.
          </p>
        </>
      )}
    </div>
  );
}
