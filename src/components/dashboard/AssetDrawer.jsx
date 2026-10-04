import React, { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Clock, Activity } from 'lucide-react';
import moment from 'moment';
import SignalChecklist from './SignalChecklist';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { formatPrice } from '@/lib/priceProximity';
import { buildDecisionCard, NOT_RECORDED } from '@/lib/decisionCardPresenter';
import FundingLine from './FundingLine';
import { QueryErrorState } from '@/components/QueryErrorState';

// Frescor REAL do ativo (assetHealthcheckReason via presenter) — antes o
// cabeçalho mostrava "LIVE" verde fixo mesmo com o ativo parado. Texto sempre
// acompanha a cor (a11y); dado sem leitura nunca vira "LIVE".
const QUALITY_BADGE = {
  ok: { label: 'LIVE', color: '#00ff80' },
  stale: { label: 'STALE', color: '#ff9f43' },
  error: { label: 'ERRO', color: '#ef4444' },
  inactive: { label: 'OFF', color: '#64748b' },
  unknown: { label: 'SEM LEITURA', color: '#64748b' },
};

const STATE_COLOR = {
  active_op: '#00e5ff',
  waiting: '#ffd166',
  expired: '#64748b',
  info: '#60a5fa',
  unavailable: '#ff9f43',
  none: 'rgba(255,255,255,0.5)',
};

// O frescor é função do relógio: sem este tick, um drawer aberto com dados que
// não mudam ficaria "LIVE" para sempre depois que o scan parasse (Codex, PR #461).
const NOW_TICK_MS = 30 * 1000;

const POSTURE_NOTE = { breakeven: 'breakeven', locked: 'lucro protegido', risk: 'em risco' };

function formatBrt(iso) {
  return iso ? `${moment(iso).utcOffset(-3).format('DD/MM HH:mm')} BRT` : null;
}

function Level({ label, value, note = null }) {
  return (
    <div className="min-w-0">
      <div className="text-8px font-mono text-muted-foreground">{label}</div>
      <div className="text-10px font-mono text-foreground/80">{value === null ? '—' : `$${formatPrice(value)}`}</div>
      {note && <div className="text-7px font-mono text-muted-foreground/70">{note}</div>}
    </div>
  );
}

// N1 do Decision Card (plano da Fase 1, known-risks item 256): decisão e ação
// num olhar. Só renderiza o que `buildDecisionCard` devolve — nada é
// recalculado aqui; dado ausente aparece como "—"/"indisponível", nunca favorável.
function DecisionSummary({ card, statesUnavailable }) {
  const { state, levels, action, score, quality } = card;

  if (state.kind === 'loading') {
    return (
      <section aria-label="Resumo da decisão" className="rounded-xl p-4"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="text-8px font-mono uppercase tracking-wider text-muted-foreground">Estado</div>
        <div role="status" className="text-sm font-bold text-muted-foreground">{state.label}</div>
      </section>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <section aria-label="Resumo da decisão" className="rounded-xl"
        style={{ background: 'rgba(255,159,67,0.05)', border: '1px solid rgba(255,159,67,0.2)' }}>
        <QueryErrorState message={`${state.label} — por isso o estado desta decisão não pode ser afirmado agora.`} />
      </section>
    );
  }

  const stateColor = STATE_COLOR[state.kind] ?? STATE_COLOR.none;
  const closeAt = formatBrt(quality.lastCandleTime);
  const sideTf = [state.side, state.timeframe].filter(Boolean).join(' · ');

  return (
    <section aria-label="Resumo da decisão" className="rounded-xl p-4 space-y-3"
      style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${stateColor}33` }}>
      <div>
        <div className="text-8px font-mono uppercase tracking-wider text-muted-foreground">Estado</div>
        <div className="text-sm font-bold" style={{ color: stateColor }}>{state.label}</div>
        {sideTf && <div className="text-9px font-mono text-muted-foreground">{sideTf}</div>}
      </div>

      <div className="text-9px font-mono text-muted-foreground">
        {statesUnavailable
          ? 'Último fechamento: não foi possível carregar agora.'
          : quality.lastClose !== null
            ? <>Último fechamento <span className="text-foreground/80">${formatPrice(quality.lastClose)}</span>{closeAt ? ` · candle ${closeAt}` : ''}</>
            : 'Último fechamento: indisponível.'}
      </div>

      {levels ? (
        <div className="grid grid-cols-5 gap-1.5">
          <Level label="Stop" value={levels.stop} note={POSTURE_NOTE[levels.stopPosture]} />
          <Level label="Entrada" value={levels.entry} />
          <Level label="TP1" value={levels.tp1} />
          <Level label="TP2" value={levels.tp2} />
          <div className="min-w-0">
            <div className="text-8px font-mono text-muted-foreground">R:R</div>
            <div className="text-10px font-mono text-foreground/80">{levels.rr === null ? '—' : `1 : ${Number(levels.rr.toFixed(2))}`}</div>
          </div>
        </div>
      ) : (
        <p className="text-9px font-mono text-muted-foreground">Níveis: ainda não definidos — a operação ainda não existe.</p>
      )}

      {action && (
        <div className="space-y-0.5">
          <div className="text-10px font-mono font-bold text-foreground/90">{action.headline}</div>
          <p className="text-9px font-mono text-muted-foreground leading-snug">{action.why}</p>
          <p className="text-9px font-mono leading-snug" style={{ color: 'rgba(0,229,255,0.75)' }}>{action.userAction}</p>
        </div>
      )}

      {score && (
        <p className="text-8px font-mono text-muted-foreground/80">
          <span className="text-foreground/70">Score técnico {score.value}/100</span> — {score.note}
        </p>
      )}
    </section>
  );
}

// Passo 3 do Decision Card: o PORQUÊ, em português simples. Só lê `card.why`
// (o presenter já entrega pronto); nada é calculado aqui. Fechado por padrão;
// o conteúdo fica sempre montado e é escondido por CSS (`hidden`), como nos
// outros toggles do painel (item 237).
const SCOPE_TAG = { now: 'agora', entry: 'na entrada', signal: 'no sinal' };
const TF_ORDER = ['1h', '4h', '1d'];
const DIRECTION_VIEW = {
  1: { arrow: '↑', word: 'compra', color: 'rgba(0,255,128,0.85)' },
  [-1]: { arrow: '↓', word: 'venda', color: 'rgba(255,20,120,0.85)' },
  // 0 = neutro CONHECIDO (o motor gravou "sem direção"); diferente de dado ausente (null → "?").
  0: { arrow: '→', word: 'neutro', color: 'rgba(255,255,255,0.6)' },
};

function Tag({ scope }) {
  const text = SCOPE_TAG[scope];
  if (!text) return null;
  return <span className="ml-1 text-7px font-mono text-muted-foreground/70">[{text}]</span>;
}

function WhyBlock({ title, children }) {
  return (
    <div className="space-y-1">
      <div className="text-8px font-mono uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function WhySection({ why, consStatus }) {
  const [open, setOpen] = useState(false);
  const { thesis, pros, cons, invalidation, multiTf } = why;
  const textCls = 'text-9px font-mono text-foreground/80 leading-snug';
  const emptyCls = 'text-9px font-mono text-muted-foreground leading-snug';

  return (
    <section aria-label="Por quê" className="rounded-xl"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="decision-why-content"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-10px font-mono font-bold text-foreground/90">Por quê?</span>
        <span aria-hidden="true" className="text-10px font-mono text-muted-foreground">{open ? '▾' : '▸'}</span>
      </button>

      <div id="decision-why-content" className={`${open ? '' : 'hidden'} px-4 pb-4 space-y-3`}>
        <WhyBlock title="Em uma frase">
          <p className={thesis ? textCls : emptyCls}>{thesis ?? 'Não registrado.'}</p>
        </WhyBlock>

        <WhyBlock title="O que ajuda ✅">
          {pros.length > 0 ? (
            <ul className="space-y-0.5">{pros.map((t, i) => <li key={i} className={textCls}>• {t}</li>)}</ul>
          ) : (
            <p className={emptyCls}>Nada registrado.</p>
          )}
        </WhyBlock>

        <WhyBlock title="O que atrapalha ⚠️">
          {cons.length > 0 ? (
            <ul className="space-y-0.5">
              {cons.map(c => (
                <li key={c.code} className={textCls}>
                  • {c.text}<Tag scope={c.scope} />
                  {c.evidence && <div className="ml-3 text-8px text-muted-foreground">{c.evidence}</div>}
                </li>
              ))}
            </ul>
          ) : (
            consStatus === 'not_recorded' && (
              <p className={emptyCls}>Nada registrado — isso não garante que não exista risco.</p>
            )
          )}
        </WhyBlock>

        <WhyBlock title="O que anularia a ideia">
          {invalidation.kind === 'stop' ? (
            <p className={textCls}>
              Stop atual: ${formatPrice(invalidation.stop)} — se o preço chegar aí, a operação é encerrada.
            </p>
          ) : (
            <p className={emptyCls}>{invalidation.text}</p>
          )}
        </WhyBlock>

        <WhyBlock title="Os gráficos concordam?">
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {TF_ORDER.map(tf => {
              const entry = multiTf.find(m => m.tf === tf);
              const view = DIRECTION_VIEW[entry?.direction];
              const tag = SCOPE_TAG[entry?.source];
              return (
                <li key={tf} className="text-9px font-mono"
                  aria-label={`${tf}: ${view ? view.word : 'sem dado'}${tag ? ` (${tag})` : ''}`}>
                  <span className="text-muted-foreground">{tf} </span>
                  <span style={{ color: view ? view.color : 'rgba(255,255,255,0.5)' }}>{view ? view.arrow : '?'}</span>
                  {view && tag && <span className="ml-0.5 text-7px text-muted-foreground/70">[{tag}]</span>}
                </li>
              );
            })}
          </ul>
          <p className="text-7px font-mono text-muted-foreground/70">↑ compra · ↓ venda · → neutro · ? sem dado</p>
        </WhyBlock>
      </div>
    </section>
  );
}

// Passo 4: "Dados técnicos" e "Histórico" — recolhidos por padrão, conteúdo do
// Histórico sempre montado (escondido por CSS, item 237); só o funding busca
// dado, e apenas depois de aberto.
const SOURCE_LABEL = { spot: 'Binance Spot', futures: 'Binance Futures' };
const EXECUTOR_LABEL = { browser: 'este navegador', cron: 'o scan agendado (cron)' };

function Collapsible({ id, title, hint = null, forceMount = true, children }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label={title} className="rounded-xl"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-10px font-mono font-bold text-foreground/90">
          {title}{hint && <span className="ml-2 font-normal text-muted-foreground">{hint}</span>}
        </span>
        <span aria-hidden="true" className="text-10px font-mono text-muted-foreground">{open ? '▾' : '▸'}</span>
      </button>
      <div id={id} className={`${open ? '' : 'hidden'} px-4 pb-4 space-y-4`}>
        {(open || forceMount) && children}
      </div>
    </section>
  );
}

function TechSection({ card, symbol }) {
  const { source, evaluatedAt } = card.quality;
  const textCls = 'text-9px font-mono text-foreground/80 leading-snug';
  return (
    <Collapsible id="decision-tech-content" title="Dados técnicos" forceMount={false}>
      <WhyBlock title="Funding (só informação)">
        <FundingLine symbol={symbol} />
      </WhyBlock>
      <WhyBlock title="De onde vêm os dados">
        <ul className="space-y-0.5">
          <li className={textCls}>Preços: {SOURCE_LABEL[source.marketSource] ?? NOT_RECORDED}</li>
          <li className={textCls}>Lido por: {EXECUTOR_LABEL[source.executor] ?? NOT_RECORDED}</li>
          <li className={textCls}>Avaliação do motor: {formatBrt(evaluatedAt) ?? NOT_RECORDED}</li>
        </ul>
      </WhyBlock>
      <WhyBlock title="Probabilidade">
        <p className="text-9px font-mono text-muted-foreground leading-snug">
          Indisponível — score e histórico não são probabilidade calibrada.
        </p>
      </WhyBlock>
    </Collapsible>
  );
}

const STATUS_CFG = {
  SIGNAL_CONFIRMED: { label: 'Entrada Confirmada', color: '#00ff80' },
  RUNNER_ACTIVE:    { label: 'Runner Ativo',        color: '#ffd166' },
  TP2_HIT:          { label: 'TP2 Atingido',        color: '#00ff80' },
  STOP_HIT:         { label: 'Stop Atingido',       color: '#ff1478' },
  INVALIDATED:      { label: 'Invalidado',          color: '#ff9f43' },
  CLOSED:           { label: 'Encerrado',           color: '#64748b' },
};

export default function AssetDrawer({
  asset, signals, tradeOps, assetStates = [], statesUnavailable = false,
  tradeOpsUnavailable = false, tradeOpsLoading = false, signalsUnavailable = false, now: nowProp = null, onClose,
}) {
  // Hooks antes do return antecipado (regra dos hooks). `now` injetado (testes)
  // desliga o intervalo.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (nowProp != null) return undefined;
    const id = setInterval(() => setTick(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, [nowProp]);

  if (!asset) return null;

  const card = buildDecisionCard({
    asset, assetStates, signals, tradeOps, signalsUnavailable, tradeOpsUnavailable, tradeOpsLoading,
    now: nowProp ?? tick,
  });
  const badge = QUALITY_BADGE[card.quality.status] ?? QUALITY_BADGE.unknown;

  const assetSignals = signals
    .filter(s => s.asset_id === asset.id)
    .sort((a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime())
    .slice(0, 8);

  const assetOps = tradeOps
    .filter(o => o.asset_id === asset.id)
    .sort((a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime());

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md p-0 flex flex-col gap-0"
        style={{ background: 'rgba(8,10,18,0.97)', border: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(24px)' }}
      >
        {/* Header */}
        <SheetHeader
          className="flex-row items-center justify-between px-5 py-4 shrink-0 space-y-0 text-left"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div>
            <SheetTitle className="font-bold text-base text-foreground">{asset.display_name}</SheetTitle>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-9px font-mono text-muted-foreground">{asset.exchange?.toUpperCase()}</span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: badge.color, boxShadow: `0 0 4px ${badge.color}`, display: 'inline-block' }} />
                <span className="text-9px font-mono" style={{ color: badge.color }}>{badge.label}</span>
                {card.quality.ageMin !== null && (
                  <span className="text-8px font-mono text-muted-foreground">· scan há {card.quality.ageMin} min</span>
                )}
              </span>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <DecisionSummary card={card} statesUnavailable={statesUnavailable} />
          {card.why && <WhySection why={card.why} consStatus={card.consStatus} />}
          <TechSection card={card} symbol={asset.symbol} />

          <Collapsible id="decision-history-content" title="Histórico deste ativo" hint={`(${assetOps.length} operações · ${assetSignals.length} sinais)`}>

            {/* Trade Operations */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Activity className="w-3.5 h-3.5" style={{ color: '#00e5ff' }} />
                <span className="text-xs font-bold text-foreground">Operações</span>
                <span className="text-9px font-mono text-muted-foreground">({assetOps.length})</span>
              </div>
              {assetOps.length === 0 && tradeOpsUnavailable ? (
                <p className="text-10px font-mono" style={{ color: '#ff9f43' }}>Não foi possível carregar as operações agora — falha ao atualizar.</p>
              ) : assetOps.length === 0 ? (
                <p className="text-10px font-mono text-muted-foreground">
                  Nenhuma operação registrada ainda — abre aqui quando o motor confirmar um sinal para este ativo.
                </p>
              ) : (
                <div className="space-y-2">
                  {assetOps.map(op => {
                    const cfg = STATUS_CFG[op.status] || { label: op.status, color: '#64748b' };
                    const isBuy = op.side === 'BUY';
                    return (
                      <div key={op.id} className="rounded-lg px-3 py-2.5"
                        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-10px font-mono font-bold" style={{ color: isBuy ? '#00ff80' : '#ff1478' }}>
                              {isBuy ? <TrendingUp className="inline w-3 h-3 mr-0.5" /> : <TrendingDown className="inline w-3 h-3 mr-0.5" />}
                              {op.side}
                            </span>
                            <span className="text-9px font-mono text-muted-foreground">{op.timeframe?.toUpperCase()}</span>
                          </div>
                          <span className="text-9px font-mono" style={{ color: cfg.color }}>{cfg.label}</span>
                        </div>
                        {card.levels && (op.status === 'SIGNAL_CONFIRMED' || op.status === 'RUNNER_ACTIVE') ? (
                          <p className="text-9px font-mono text-muted-foreground">Níveis no resumo, acima.</p>
                        ) : (
                        <div className="grid grid-cols-3 gap-1.5">
                          {[
                            { l: 'Entrada', v: op.entry_price },
                            { l: 'TP1', v: op.tp1 },
                            { l: 'TP2', v: op.tp2 },
                          ].map(({ l, v }) => (
                            <div key={l}>
                              <div className="text-8px font-mono text-muted-foreground">{l}</div>
                              <div className="text-10px font-mono text-foreground/70">${formatPrice(v)}</div>
                            </div>
                          ))}
                        </div>
                        )}
                        <div className="text-8px font-mono text-muted-foreground mt-1.5 flex items-center gap-1">
                          <Clock className="w-2.5 h-2.5" />
                          {moment(op.created_date).format('DD/MM/YY HH:mm')}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Signals */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="w-3.5 h-3.5 flex items-center justify-center">
                  <span className="w-2 h-2 rounded-full" style={{ background: '#ffd166', boxShadow: '0 0 4px #ffd166', display: 'inline-block' }} />
                </span>
                <span className="text-xs font-bold text-foreground">Sinais Recentes</span>
                <span className="text-9px font-mono text-muted-foreground">({assetSignals.length})</span>
              </div>
              {assetSignals.length > 0 && (
                <p className="text-8px font-mono mb-2" style={{ color: 'rgba(255,255,255,0.3)' }}>
                  "Confl." = confluência de indicadores técnicos alinhados — não é uma probabilidade de acerto do trade.
                </p>
              )}
              {assetSignals.length === 0 && signalsUnavailable ? (
                <p className="text-10px font-mono" style={{ color: '#ff9f43' }}>Não foi possível carregar os sinais agora — falha ao atualizar.</p>
              ) : assetSignals.length === 0 ? (
                <p className="text-10px font-mono text-muted-foreground">
                  Nenhum sinal registrado ainda — aparece aqui quando o scan encontrar uma oportunidade neste ativo.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {assetSignals.map(sig => {
                    const isBuy = sig.signal_type === 'BUY';
                    return (
                      <div key={sig.id} className="flex items-start gap-2 px-3 py-2 rounded-lg"
                        style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
                        <span className="mt-0.5 shrink-0 text-10px font-mono font-bold" style={{ color: isBuy ? '#00ff80' : '#ff1478' }}>
                          {isBuy ? '↑' : '↓'} {sig.signal_type}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-8px font-mono text-muted-foreground/60 uppercase tracking-wider">TF</span>
                            <span className="text-9px font-mono text-muted-foreground">{sig.timeframe?.toUpperCase()}</span>
                            <span className="text-9px font-mono text-foreground/60">${formatPrice(sig.price_at_signal)}</span>
                            {sig.context?.score && (
                              <span className="text-8px font-mono" style={{ color: '#ffd166' }}>
                                Confl. {sig.context.score}
                              </span>
                            )}
                          </div>
                          <p className="text-8px font-mono text-muted-foreground mt-0.5 leading-tight line-clamp-2">
                            <span className="text-muted-foreground/60 uppercase tracking-wider">Motivo: </span>
                            {sig.reason}
                          </p>
                          <div className="text-8px font-mono text-muted-foreground/60 mt-0.5">
                            <span className="uppercase tracking-wider">Quando: </span>
                            {moment(sig.created_date).fromNow()}
                          </div>
                          <SignalChecklist signal={sig} tradeOps={tradeOps} tradeOpsUnavailable={tradeOpsUnavailable} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Collapsible>
        </div>
      </SheetContent>
    </Sheet>
  );
}