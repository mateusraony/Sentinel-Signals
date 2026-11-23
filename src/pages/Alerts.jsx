import TokenIcon from '@/components/TokenIcon';
import React, { useState, useEffect, useRef } from 'react';
import { agreementLabel } from '@/lib/ruleAgreement';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { Bell, Archive, TrendingUp, TrendingDown, Search, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { QueryErrorState } from '@/components/QueryErrorState';
import moment from 'moment';
import { dayLabel } from '@/lib/dayLabel';
import { POLL_DIAGNOSTIC_MS } from '@/lib/pollingIntervals';
// Auditoria do Telegram (2026-09-29), Fase 2 item 2.11 — fonte única dos
// pares id→rótulo de origem do sinal, antes duplicada aqui e em
// telegram.js/adminTelegram.js. Mesmos textos de antes (achado M-17 do
// Raio-X de UI/UX), só a fonte dos dados virou uma.
import { SIGNAL_SOURCES, longSourceLabel } from '@/lib/signalSourceLabels';
import { translateSignalContext } from '@/lib/signalContextTranslation';
// Auditoria do Telegram, Fase 4 (2026-10-02) — mesma fonte de rótulo de
// prioridade que SignalAlertBanner.jsx agora usa (antes, 3 lugares
// independentes repetiam "Alta"/"Média"/"Baixa" com grafias ligeiramente
// diferentes). Os chips do filtro usam a mesma função (item 280: ⭐ Alta).
import { priorityLabel } from '@/lib/signalStatus';

const PRIORITY_CONFIG = {
  high:   { color: '#dd9a4a', bg: 'rgba(221,154,74,0.12)', border: 'rgba(221,154,74,0.3)', label: priorityLabel('high') },
  medium: { color: 'rgba(255,255,255,0.5)', bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.1)', label: priorityLabel('medium') },
  low:    { color: 'rgba(255,255,255,0.55)', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.07)', label: priorityLabel('low') },
};

/** Um grupo de filtros em abas ligadas, com rótulo ("Tipo", "Prioridade", "Fonte"). */
function FilterGroup({ label, children }) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center rounded-md overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
        {children}
      </div>
    </div>
  );
}

const TAB_BASE = 'text-11px font-mono px-3 py-1.5 transition-all whitespace-nowrap';
const tabStyle = (active, first, color) => ({
  borderLeft: first ? 'none' : '1px solid rgba(255,255,255,0.08)',
  ...(active
    ? { background: color ? `${color}22` : 'rgba(141,180,226,0.15)', color: color || '#8db4e2' }
    : { background: 'rgba(255,255,255,0.02)', color: 'rgba(255,255,255,0.55)' }),
});

export default function Alerts() {
  const [filterSource, setFilterSource] = useState('all');
  const [filterPriority, setFilterPriority] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedSignal, setSelectedSignal] = useState(null);
  // Guarda os IDs visíveis no momento do clique, não um boolean — a query
  // `all-signals` faz polling (achado do Codex review no PR #442) e
  // `filtered` pode ganhar alertas novos enquanto o diálogo está aberto;
  // sem o snapshot, confirmar dispensaria alertas que o usuário nunca viu.
  const [confirmingDismissAll, setConfirmingDismissAll] = useState(null);
  const queryClient = useQueryClient();

  const { data: signals = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['all-signals'],
    queryFn: () => backend.entities.SignalEvent.list('-created_date', 200),
    refetchInterval: POLL_DIAGNOSTIC_MS,
  });

  // Fase 5 da auditoria do Telegram (2026-10-02), item 5.4 — abre direto o
  // sinal que a mensagem do Telegram apontou (`?id=`), em vez de só a lista
  // genérica. `appliedDeepLink` garante que isso só roda UMA VEZ por
  // carregamento da página — sem o guard, o polling de `signals`
  // (POLL_DIAGNOSTIC_MS) reabriria o diálogo sempre que o usuário o
  // fechasse manualmente. Busca em `signals` (lista completa), não
  // `filtered` — um sinal já arquivado ainda deve abrir via deep link.
  const appliedDeepLink = useRef(false);
  useEffect(() => {
    if (appliedDeepLink.current) return;
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) { appliedDeepLink.current = true; return; }
    if (signals.length === 0) return;
    const match = signals.find(s => s.id === id);
    if (match) setSelectedSignal(match);
    appliedDeepLink.current = true;
  }, [signals]);

  const dismissMutation = useMutation({
    mutationFn: (id) => backend.entities.SignalEvent.update(id, { is_dismissed: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['all-signals'] }),
  });

  const filtered = signals.filter(s => {
    if (s.is_dismissed) return false;
    if (search && !s.symbol?.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterSource !== 'all' && s.source !== filterSource) return false;
    if (filterPriority !== 'all' && s.priority !== filterPriority) return false;
    if (filterType !== 'all' && s.signal_type !== filterType) return false;
    return true;
  });

  const highCount = signals.filter(s => !s.is_dismissed && s.priority === 'high').length;
  const buyCount = filtered.filter(s => s.signal_type === 'BUY').length;
  const sellCount = filtered.filter(s => s.signal_type === 'SELL').length;

  // Enquanto carrega, ou se a carga falhou sem dado nenhum, as contagens NÃO sabem o número: mostram "—" em vez de afirmar "0".
  const countsUnknown = isLoading || (isError && signals.length === 0);
  const showCount = (n) => (countsUnknown ? '—' : n);

  const hasActiveFilters = filterSource !== 'all' || filterPriority !== 'all' || filterType !== 'all' || search;

  // Lista agrupada por dia (a ordem é a de sempre: mais recente primeiro; só ganhou um título a cada troca de dia).
  // Agrupa por chave de dia (Map, na ordem em que cada dia aparece) — não depende de a lista chegar perfeitamente ordenada.
  const groupMap = new Map();
  for (const sig of filtered) {
    const day = moment(sig.created_date);
    const key = day.format('YYYY-MM-DD');
    if (!groupMap.has(key)) groupMap.set(key, { key, day, items: [] });
    groupMap.get(key).items.push(sig);
  }
  const groups = [...groupMap.values()];

  const clearFilters = () => { setSearch(''); setFilterSource('all'); setFilterPriority('all'); setFilterType('all'); };

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-muted-foreground mb-1">Monitoramento</p>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Alertas</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs font-mono">
            <div className="live-dot" style={{ width: 5, height: 5 }} />
            <span className="text-muted-foreground">{isLoading ? 'carregando…' : countsUnknown ? 'alertas indisponíveis' : `${filtered.length} alertas`}</span>
          </div>
          {filtered.length > 0 && (
            <button
              onClick={() => setConfirmingDismissAll(filtered.map(s => s.id))}
              disabled={dismissMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-11px font-mono transition-all hover:opacity-80"
              style={{ background: 'rgba(221,154,74,0.08)', border: '1px solid rgba(221,154,74,0.2)', color: '#dd9a4a' }}>
              <X className="w-3 h-3" />Arquivar todos
            </button>
          )}
        </div>
      </div>

      {/* Contagens: uma linha só (eram 3 cartões com ícone). */}
      <div className="rounded-md px-4 py-2.5 flex flex-wrap items-center gap-x-8 gap-y-1.5" style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.07)' }}>
        {[
          { label: 'Alta Prioridade', value: showCount(highCount), color: '#dd9a4a' },
          { label: 'BUY', value: showCount(buyCount), color: '#5db586' },
          { label: 'SELL', value: showCount(sellCount), color: '#e06a5b' },
        ].map(({ label, value, color }) => (
          <div key={label} className="flex items-baseline gap-2">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-lg font-mono font-medium tabular-nums" style={{ color }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Filtros: busca + 3 grupos rotulados em abas ligadas (rolam de lado no celular) */}
      <div className="rounded-md p-3 space-y-3" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            <input type="text" placeholder="Buscar símbolo..." value={search} onChange={e => setSearch(e.target.value)}
              className="w-full pl-7 pr-3 py-1.5 rounded-md text-11px font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }} />
          </div>
          {hasActiveFilters && (
            <button onClick={clearFilters}
              className="ml-auto text-11px font-mono px-2.5 py-1.5 rounded-md flex items-center gap-1 transition-all"
              style={{ background: 'rgba(224,106,91,0.08)', border: '1px solid rgba(224,106,91,0.2)', color: '#e06a5b' }}>
              <X className="w-3 h-3" />Limpar
            </button>
          )}
        </div>

        <div className="flex items-center gap-x-5 gap-y-2 overflow-x-auto sm:flex-wrap pb-0.5">
          <FilterGroup label="Tipo">
            {[{ id: 'all', label: 'Todos' }, { id: 'BUY', label: '▲ BUY', color: '#5db586' }, { id: 'SELL', label: '▼ SELL', color: '#e06a5b' }].map((f, i) => (
              <button key={f.id} onClick={() => setFilterType(f.id)} className={TAB_BASE}
                style={tabStyle(filterType === f.id, i === 0, f.color)}>
                {f.label}
              </button>
            ))}
          </FilterGroup>

          <FilterGroup label="Prioridade">
            {[{ id: 'all', label: 'Todas' }, { id: 'high', label: priorityLabel('high') }, { id: 'medium', label: priorityLabel('medium') }, { id: 'low', label: priorityLabel('low') }].map((f, i) => (
              <button key={f.id} onClick={() => setFilterPriority(f.id)} className={TAB_BASE}
                style={tabStyle(filterPriority === f.id, i === 0)}>
                {f.label}
              </button>
            ))}
          </FilterGroup>

          <FilterGroup label="Fonte">
            {['all', 'range_filter', 'smc_structure', 'rsi', 'macd', 'ema_cross'].map((src, i) => {
              const button = (
                <button key={src} onClick={() => setFilterSource(src)}
                  className={`${TAB_BASE}${src !== 'all' ? ' cursor-help' : ''}`}
                  tabIndex={src !== 'all' ? 0 : undefined}
                  style={tabStyle(filterSource === src, i === 0)}>
                  {src === 'all' ? 'Todas Fontes' : longSourceLabel(src)}
                </button>
              );
              if (src === 'all') return button;
              return (
                <Tooltip key={src}>
                  <TooltipTrigger asChild>{button}</TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                    {SIGNAL_SOURCES[src]?.tooltip}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </FilterGroup>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : isError && signals.length === 0 ? (
        <div className="rounded-md p-8" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <QueryErrorState message="Não foi possível carregar os alertas agora." onRetry={refetch} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md px-5 py-6 flex flex-wrap items-center gap-x-4 gap-y-3" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <Bell className="w-5 h-5 shrink-0 text-muted-foreground opacity-40" />
          <p className="text-muted-foreground text-sm">Nenhum alerta com esses filtros.</p>
          {/* Achado da varredura pós-Raio-X, Round 3 (2026-09-27): botão
              "Limpar" já existia no topo, mas não bem perto deste texto —
              versão inline reusa o mesmo handler. */}
          {hasActiveFilters && (
            <button onClick={clearFilters}
              className="ml-auto text-11px font-mono px-2.5 py-1.5 rounded-md inline-flex items-center gap-1 transition-all"
              style={{ background: 'rgba(224,106,91,0.08)', border: '1px solid rgba(224,106,91,0.2)', color: '#e06a5b' }}>
              <X className="w-3 h-3" />Limpar filtros
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map(group => (
            <section key={group.key} className="space-y-1.5">
              <div className="flex items-center gap-2 px-1">
                <span aria-hidden="true" style={{ width: 3, height: 16, borderRadius: 2, background: '#8db4e2', display: 'inline-block' }} />
                <h2 className="text-sm font-semibold text-foreground/80">{dayLabel(group.day)}</h2>
                <span className="text-xs font-mono text-muted-foreground">{group.day.format('DD/MM')} · {group.items.length} {group.items.length === 1 ? 'alerta' : 'alertas'}</span>
              </div>
              {group.items.map(signal => {
                const isBuy = signal.signal_type === 'BUY';
                const prio = PRIORITY_CONFIG[signal.priority] || PRIORITY_CONFIG.low;
                // Sem role="button" de propósito (achado do Codex review no PR
                // #419): esta linha contém um <button> real (dispensar) — um
                // role de widget (button/link/...) torna os filhos
                // "presentational" pra árvore de acessibilidade, escondendo o
                // botão de dispensar como controle próprio. tabIndex+onKeyDown
                // já bastam pra foco/ativação por teclado sem precisar do role.
                return (
                  <div key={signal.id}
                    tabIndex={0}
                    aria-label={`${signal.symbol?.replace('USDT', '/USDT')} — ver detalhes do alerta`}
                    className="rounded-md px-4 py-3 flex items-center gap-3 transition-all duration-200 cursor-pointer group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    style={{
                      background: 'rgba(24,23,21,0.82)',
                      // Alta prioridade: contorno mais forte (sem brilho).
                      border: signal.priority === 'high'
                        ? (isBuy ? '1px solid rgba(93,181,134,0.35)' : '1px solid rgba(224,106,91,0.35)')
                        : (isBuy ? '1px solid rgba(93,181,134,0.1)' : '1px solid rgba(224,106,91,0.1)'),
                    }}
                    onClick={() => setSelectedSignal(signal)}
                    onKeyDown={(e) => {
                      // Achado A-7 do Raio-X de UI/UX: ignora key events que
                      // borbulharem do botão de dispensar (já trata o próprio
                      // Enter/Space nativamente e faz stopPropagation no clique;
                      // sem isso, Enter no botão duplicaria a ação de abrir o
                      // detalhe, igual ao mesmo cuidado já tomado em AssetCard.jsx).
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedSignal(signal); }
                    }}>

                    {/* Hora (a data fica no título do dia) + selo BUY/SELL: lado a lado em tela larga, empilhados no celular */}
                    <div className="flex flex-col sm:flex-row items-center gap-1 sm:gap-3 shrink-0">
                    <span className="text-xs font-mono tabular-nums sm:w-11 shrink-0" style={{ color: 'rgba(255,255,255,0.62)' }}>
                      {moment(signal.created_date).format('HH:mm')}
                    </span>

                    {/* Signal badge */}
                    <span className="flex items-center justify-center gap-1 text-xs font-mono font-semibold px-2.5 py-1.5 rounded-md shrink-0 w-[4.75rem]"
                      style={isBuy
                        ? { background: 'rgba(93,181,134,0.12)', color: '#5db586', border: '1px solid rgba(93,181,134,0.35)' }
                        : { background: 'rgba(224,106,91,0.12)', color: '#e06a5b', border: '1px solid rgba(224,106,91,0.35)' }}>
                      {isBuy ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                      {signal.signal_type}
                    </span>
                    </div>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <TokenIcon symbol={signal.symbol} size={18} />
                        <span className="font-semibold text-sm text-foreground">{signal.symbol?.replace('USDT', '/USDT')}</span>
                        <span className="text-11px font-mono px-1.5 py-0.5 rounded"
                          style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.62)', border: '1px solid rgba(255,255,255,0.07)' }}>
                          {signal.timeframe?.toUpperCase()}
                        </span>
                        {SIGNAL_SOURCES[signal.source]?.tooltip ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-11px font-mono px-1.5 py-0.5 rounded cursor-help" tabIndex={0}
                                style={{ background: 'rgba(141,180,226,0.06)', color: 'rgba(141,180,226,0.75)', border: '1px solid rgba(141,180,226,0.15)' }}>
                                {longSourceLabel(signal.source)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                              {SIGNAL_SOURCES[signal.source]?.tooltip}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-11px font-mono px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(141,180,226,0.06)', color: 'rgba(141,180,226,0.75)', border: '1px solid rgba(141,180,226,0.15)' }}>
                            {longSourceLabel(signal.source)}
                          </span>
                        )}
                        <span className="text-11px font-mono px-1.5 py-0.5 rounded"
                          style={{ background: prio.bg, color: prio.color, border: `1px solid ${prio.border}` }}>
                          {prio.label}
                        </span>
                        {Number.isFinite(signal.context?.score) && signal.context.score > 0 && (
                          <span className="text-11px font-mono" style={{ color: signal.context.score >= 85 ? '#e3b45a' : 'rgba(255,255,255,0.6)' }}>
                            {agreementLabel({ score: signal.context.score })}
                          </span>
                        )}
                      </div>
                      {signal.reason && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{signal.reason}</p>
                      )}
                    </div>

                    {/* Right side */}
                    <div className="flex items-center gap-2 shrink-0">
                      {signal.price_at_signal && (
                        <span className="text-xs font-mono text-muted-foreground hidden sm:block">
                          ${signal.price_at_signal?.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </span>
                      )}
                      <button
                        aria-label="Arquivar este alerta"
                        className="p-2 rounded-md transition-all hover:bg-rose-500/10"
                        onClick={(e) => { e.stopPropagation(); dismissMutation.mutate(signal.id); }}>
                        <Archive className="w-3.5 h-3.5 text-muted-foreground hover:text-rose-400 transition-colors" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}

      {/* Detail Dialog */}
      <Dialog open={!!selectedSignal} onOpenChange={(open) => !open && setSelectedSignal(null)}>
        <DialogContent style={{ background: 'rgba(21,20,18,0.97)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <DialogHeader>
            <DialogTitle className="font-mono flex items-center gap-2 text-sm">
              <span style={{ color: selectedSignal?.signal_type === 'BUY' ? '#5db586' : '#e06a5b' }}>
                {selectedSignal?.signal_type === 'BUY' ? '▲' : '▼'} {selectedSignal?.signal_type}
              </span>
              {selectedSignal?.symbol?.replace('USDT', '/USDT')} — {selectedSignal?.timeframe?.toUpperCase()}
            </DialogTitle>
          </DialogHeader>
          {selectedSignal && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['Fonte', longSourceLabel(selectedSignal.source)],
                  ['Preço', `$${selectedSignal.price_at_signal?.toLocaleString(undefined, { maximumFractionDigits: 6 })}`],
                  ['Horário', moment(selectedSignal.created_date).format('DD/MM/YYYY HH:mm:ss')],
                  // Auditoria do Telegram (2026-09-29), item 1.2 — só RF carrega
                  // score real (0-100); SMC/MACD/EMA/RSI não têm essa métrica, e
                  // `|| 0` mostrava "Score: 0/100" como se fosse um sinal fraco
                  // real. Mesmo guard `> 0` já usado no card da lista (abaixo).
                  selectedSignal.context?.score > 0
                    ? ['Score', `${selectedSignal.context.score}/100`]
                    : null,
                ].filter(Boolean).map(([label, val]) => (
                  <div key={label} className="rounded-md p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <p className="text-11px font-mono text-muted-foreground">{label}</p>
                    <p className="text-sm font-mono font-semibold text-foreground mt-0.5">{val}</p>
                  </div>
                ))}
              </div>
              {selectedSignal.reason && (
                <div className="rounded-md p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <p className="text-11px font-mono text-muted-foreground mb-1">Razão</p>
                  <p className="text-sm text-foreground/80">{selectedSignal.reason}</p>
                </div>
              )}
              {selectedSignal.context && (
                <div className="rounded-md p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <p className="text-11px font-mono text-muted-foreground mb-2">Por que este alerta apareceu?</p>
                  {/* Auditoria do Telegram (2026-09-29), Fase 2 item 2.8 —
                      antes só havia o JSON bruto aqui; tradução humana das
                      chaves conhecidas do context entra ANTES dele, que
                      continua existindo atrás de "ver dados técnicos". */}
                  {(() => {
                    const rows = translateSignalContext(selectedSignal.context);
                    return rows.length > 0 ? (
                      <div className="space-y-1 mb-2">
                        {rows.map((row) => (
                          <div key={row.label} className="flex items-center gap-2 text-xs">
                            {Number.isFinite(row.direction) ? (
                              <span style={{ color: row.direction === 1 ? '#5db586' : '#e06a5b' }}>
                                {row.direction === 1 ? '↑' : '↓'}
                              </span>
                            ) : null}
                            <span className="text-muted-foreground">{row.label}:</span>
                            <span className="text-foreground/80">{row.value}</span>
                          </div>
                        ))}
                      </div>
                    ) : null;
                  })()}
                  {/* Refinamentos (seção E): JSON cru ficava sempre visível
                      no modal — mesmo padrão de <details> já usado em
                      Logs.jsx pra payload técnico, fechado por padrão.
                      Achado do Codex review (PR #439): 0.25 dava ~2.3:1 de
                      contraste sobre o fundo escuro do dialog, abaixo do
                      4.5:1 exigido pra texto pequeno — mesmo problema já
                      corrigido pro timestamp nesta mesma rodada, aqui é o
                      único controle visível pra revelar o payload. */}
                  <details>
                    <summary className="text-11px cursor-pointer select-none rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" style={{ color: 'rgba(255,255,255,0.62)' }}>ver dados técnicos →</summary>
                    <pre className="mt-1 text-11px font-mono overflow-x-auto" style={{ color: 'rgba(93,181,134,0.7)' }}>
                      {JSON.stringify(selectedSignal.context, null, 2)}
                    </pre>
                  </details>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Achado da varredura pós-Raio-X, Round 2 (2026-09-27): confirm()
          nativo quebrava o tema escuro — migrado pro AlertDialog já
          existente e nunca usado. Texto agora diz quantos alertas serão
          afetados e que não há undo na UI (é só flag is_dismissed, sem
          controle de reverter). */}
      <AlertDialog open={!!confirmingDismissAll} onOpenChange={(open) => !open && setConfirmingDismissAll(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Arquivar todos os alertas visíveis?</AlertDialogTitle>
            <AlertDialogDescription>
              Arquivar os {confirmingDismissAll?.length} alertas visíveis agora? Eles saem da
              lista (marcados como arquivados) — não há como reverter isso pela interface.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction destructive onClick={() => confirmingDismissAll?.forEach(id => dismissMutation.mutate(id))}>
              Arquivar todos
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}