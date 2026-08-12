import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { notifyVerificationTask, isTelegramConfigured } from '@/lib/telegram';
import { ClipboardCheck, Check, X as XIcon, Search, ArrowUpDown, Send, Loader2 } from 'lucide-react';
import SignalChecklist from '@/components/dashboard/SignalChecklist';
import moment from 'moment';

const STATUS_FILTERS = [
  { id: 'all', label: 'Todas' },
  { id: 'pending', label: 'Pendentes' },
  { id: 'reviewed', label: 'Revisadas' },
  { id: 'skipped', label: 'Puladas' },
  { id: 'superseded', label: 'Superadas' },
];

const PRIORITY_FILTERS = [
  { id: 'all', label: 'Todas' },
  { id: 'high', label: 'Alta' },
  { id: 'medium', label: 'Média' },
  { id: 'low', label: 'Baixa' },
];

const STATUS_BADGE = {
  pending: { label: 'Pendente', color: '#ffd166', bg: 'rgba(255,209,102,0.1)', border: 'rgba(255,209,102,0.25)' },
  reviewed: { label: 'Revisada', color: '#00ff80', bg: 'rgba(0,255,128,0.08)', border: 'rgba(0,255,128,0.2)' },
  skipped: { label: 'Pulada', color: 'rgba(255,255,255,0.4)', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.08)' },
  // Marcado automaticamente pelo scanner, não pelo usuário (item 76) — cor
  // própria pra não parecer uma revisão manual que nunca aconteceu.
  superseded: { label: 'Superada por sinal novo', color: '#00e5ff', bg: 'rgba(0,229,255,0.06)', border: 'rgba(0,229,255,0.18)' },
};

// Same age-urgency cue as VerificationWidget — duplicated (not shared) since
// it's a handful of lines and the two components have no other coupling.
function ageColor(createdDate) {
  const hours = (Date.now() - new Date(createdDate).getTime()) / 3600000;
  if (hours >= 6) return '#ff1478';
  if (hours >= 2) return '#ff9f43';
  return 'rgba(255,255,255,0.4)';
}

function NotesField({ task, onSave }) {
  const [value, setValue] = useState(task.notes || '');
  return (
    <textarea
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={() => { if (value !== (task.notes || '')) onSave(value); }}
      placeholder="Anotações sobre esta revisão..."
      rows={2}
      className="w-full px-2.5 py-1.5 rounded-lg text-[11px] font-mono outline-none resize-none"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)' }}
    />
  );
}

function ContextGrid({ ctx }) {
  if (!ctx) return null;
  const items = [
    ['RF', ctx.rf_value?.toFixed?.(4)],
    ['RF Dir', ctx.rf_direction === 1 ? 'Alta' : ctx.rf_direction === -1 ? 'Baixa' : '—'],
    ['RSI', ctx.rsi?.toFixed?.(1)],
    ['MACD Hist', ctx.macd_histogram?.toFixed?.(4)],
    ['EMA Curta', ctx.ema_short?.toFixed?.(4)],
    ['EMA Longa', ctx.ema_long?.toFixed?.(4)],
    ['4H', ctx.tf_4h_direction === 1 ? 'Alta' : ctx.tf_4h_direction === -1 ? 'Baixa' : 'Neutra'],
    ['1D', ctx.tf_1d_direction === 1 ? 'Alta' : ctx.tf_1d_direction === -1 ? 'Baixa' : 'Neutra'],
  ].filter(([, v]) => v !== undefined);
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-[10px] font-mono">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-1">
          <span className="text-muted-foreground">{label}</span>
          <span className="text-foreground/80">{value ?? '—'}</span>
        </div>
      ))}
    </div>
  );
}

export default function Verification() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('pending');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('date'); // 'date' | 'score'
  const [resendingId, setResendingId] = useState(null);

  // Filtra status/prioridade no SERVIDOR (não só no cliente) — com mais de
  // 200 tarefas no total, um `.list()` sem filtro cortaria nas mais recentes
  // e poderia esconder pendências antigas da lista inteira (Codex review, PR
  // #159 follow-up). `filter()` já ignora chaves `undefined`, então "Todas"
  // (undefined) se comporta como o `.list()` de antes; os índices compostos
  // status+created_date / status+priority+created_date já existem para os
  // dois casos.
  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['verification-tasks-all', statusFilter, priorityFilter],
    queryFn: () => backend.entities.VerificationTask.filter({
      status: statusFilter !== 'all' ? statusFilter : undefined,
      priority: priorityFilter !== 'all' ? priorityFilter : undefined,
    }, '-created_date', 200),
    refetchInterval: 15000,
  });

  // Contagem do badge do cabeçalho é independente do filtro ativo — sem isso,
  // trocar para a aba "Revisadas"/"Puladas" faria o número de pendentes
  // sumir ou ficar desatualizado.
  const { data: pendingTasks = [] } = useQuery({
    queryKey: ['verification-tasks-pending-count'],
    queryFn: () => backend.entities.VerificationTask.filter({ status: 'pending' }, '-created_date', 200),
    refetchInterval: 15000,
  });

  const { data: assets = [] } = useQuery({
    queryKey: ['monitored-assets-verification'],
    queryFn: () => backend.entities.MonitoredAsset.list(),
  });

  const { data: tradeOps = [] } = useQuery({
    queryKey: ['trade-operations-verification'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', 100),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => backend.entities.VerificationTask.update(id, data),
    onSuccess: () => {
      // Prefix match invalidates every statusFilter/priorityFilter variant.
      queryClient.invalidateQueries({ queryKey: ['verification-tasks-all'] });
      queryClient.invalidateQueries({ queryKey: ['verification-tasks-pending-count'] });
      queryClient.invalidateQueries({ queryKey: ['verification-tasks-recent'] });
    },
  });

  // status/priority já vêm filtrados do servidor (query acima) — só busca
  // por símbolo e ordenação continuam client-side.
  const filtered = useMemo(() => {
    let list = search
      ? tasks.filter(t => t.symbol?.toLowerCase().includes(search.toLowerCase()))
      : tasks;
    if (sortBy === 'score') {
      list = [...list].sort((a, b) => (b.score || 0) - (a.score || 0));
    }
    return list;
  }, [tasks, search, sortBy]);

  const pendingCount = pendingTasks.length;

  const setStatus = (task, status) => updateMutation.mutate({
    id: task.id,
    data: { status, reviewed_at: new Date().toISOString() },
  });

  const resend = async (task) => {
    setResendingId(task.id);
    try {
      const signal = { symbol: task.symbol, timeframe: task.timeframe, signal_type: task.signal_type, source: task.source, reason: task.reason, context: task.signal_context };
      const asset = assets.find(a => a.id === task.asset_id);
      const delivered = await notifyVerificationTask(signal, asset);
      // Só grava "enviado" quando send() de fato confirmou 2xx do Telegram —
      // antes gravava incondicionalmente, mesmo quando o filtro de
      // evento/score/timeframe descartava o envio ou a chamada falhava
      // (Codex review, PR #159 follow-up).
      if (delivered) {
        await updateMutation.mutateAsync({ id: task.id, data: { telegram_notified: true, telegram_notified_at: new Date().toISOString() } });
      }
    } finally {
      setResendingId(null);
    }
  };

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      <div>
        <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Revisão de Sinais</p>
        <div className="flex items-center gap-2">
          <ClipboardCheck className="w-6 h-6" style={{ color: '#ffd166' }} />
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Verificação</h1>
          {pendingCount > 0 && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(255,209,102,0.1)', border: '1px solid rgba(255,209,102,0.25)', color: '#ffd166' }}>
              {pendingCount} pendente{pendingCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Tarefas criadas automaticamente para todo sinal de alta prioridade — inclusive pelo scan agendado, sem precisar do navegador aberto.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Buscar símbolo..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-7 pr-3 py-1.5 rounded-lg text-[10px] font-mono outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.75)' }}
          />
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {STATUS_FILTERS.map(f => (
            <button key={f.id} onClick={() => setStatusFilter(f.id)}
              className="text-[9px] font-mono px-2 py-1 rounded-md transition-all"
              style={statusFilter === f.id
                ? { background: 'rgba(0,229,255,0.15)', border: '1px solid rgba(0,229,255,0.4)', color: '#00e5ff' }
                : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)' }}>
              {f.label}
            </button>
          ))}
          <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(255,255,255,0.08)' }} />
          {PRIORITY_FILTERS.map(f => (
            <button key={f.id} onClick={() => setPriorityFilter(f.id)}
              className="text-[9px] font-mono px-2 py-1 rounded-md transition-all"
              style={priorityFilter === f.id
                ? { background: 'rgba(255,159,67,0.15)', border: '1px solid rgba(255,159,67,0.4)', color: '#ff9f43' }
                : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)' }}>
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <ArrowUpDown className="w-3 h-3 text-muted-foreground shrink-0" />
          {[{ id: 'date', label: 'Data' }, { id: 'score', label: 'Score ↓' }].map(s => (
            <button key={s.id} onClick={() => setSortBy(s.id)}
              className="text-[9px] font-mono px-2 py-1 rounded-md transition-all"
              style={sortBy === s.id
                ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(0,229,255,0.9)' }
                : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)' }}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="glass-card rounded-xl h-28 shimmer" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-card rounded-xl p-12 text-center">
          <ClipboardCheck className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
          <p className="text-muted-foreground text-sm">Nenhuma tarefa de verificação encontrada.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(task => {
            const badge = STATUS_BADGE[task.status] || STATUS_BADGE.pending;
            const asset = assets.find(a => a.id === task.asset_id);
            const reconstructedSignal = { signal_type: task.signal_type, context: task.signal_context };
            return (
              <div key={task.id} className="glass-card rounded-xl p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-foreground">{task.symbol?.replace('USDT', '/USDT')}</span>
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }}>
                        {task.timeframe?.toUpperCase()}
                      </span>
                      <span className="text-[10px] font-mono font-bold" style={{ color: task.signal_type === 'BUY' ? '#00ff80' : '#ff1478' }}>
                        {task.signal_type === 'BUY' ? '↑ BUY' : '↓ SELL'}
                      </span>
                      {Number.isFinite(task.score) && (
                        <span className="text-[10px] font-mono" style={{ color: task.score >= 85 ? '#ffd166' : 'rgba(255,255,255,0.4)' }}>
                          🔥 Score {task.score}/100
                        </span>
                      )}
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full" style={{ background: badge.bg, border: `1px solid ${badge.border}`, color: badge.color }}>
                        {badge.label}
                      </span>
                      <span className="text-[9px] font-mono" style={{ color: task.status === 'pending' ? ageColor(task.created_date) : 'rgba(255,255,255,0.35)' }}>
                        {moment(task.created_date).fromNow()}
                      </span>
                    </div>

                    {task.reason && <p className="text-[11px] text-muted-foreground">{task.reason}</p>}

                    <ContextGrid ctx={task.signal_context} />

                    <NotesField task={task} onSave={(notes) => updateMutation.mutate({ id: task.id, data: { notes } })} />

                    {asset && (
                      <SignalChecklist asset={asset} signal={reconstructedSignal} tradeOps={tradeOps} />
                    )}
                  </div>

                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => setStatus(task, 'reviewed')}
                        title="Marcar como revisado (OK)"
                        className="p-1.5 rounded-md hover:bg-white/[0.08] transition-colors"
                        style={{ background: task.status === 'reviewed' ? 'rgba(0,255,128,0.1)' : 'transparent' }}>
                        <Check className="w-4 h-4" style={{ color: '#00ff80' }} />
                      </button>
                      <button onClick={() => setStatus(task, 'skipped')}
                        title="Pular"
                        className="p-1.5 rounded-md hover:bg-white/[0.08] transition-colors"
                        style={{ background: task.status === 'skipped' ? 'rgba(255,255,255,0.08)' : 'transparent' }}>
                        <XIcon className="w-4 h-4 text-muted-foreground" />
                      </button>
                    </div>
                    <button onClick={() => resend(task)}
                      disabled={resendingId === task.id || !isTelegramConfigured()}
                      title={isTelegramConfigured() ? 'Reenviar notificação Telegram' : 'Configure o Telegram em Ajustes primeiro'}
                      className="flex items-center gap-1 text-[9px] font-mono px-2 py-1 rounded-md transition-all disabled:opacity-40"
                      style={{ background: 'rgba(0,229,255,0.06)', border: '1px solid rgba(0,229,255,0.15)', color: '#00e5ff' }}>
                      {resendingId === task.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                      Reenviar
                    </button>
                    {task.telegram_notified_at && (
                      <span className="text-[8px] font-mono text-muted-foreground">
                        Enviado {moment(task.telegram_notified_at).fromNow()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
