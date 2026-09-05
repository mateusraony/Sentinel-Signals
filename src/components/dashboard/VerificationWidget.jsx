import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { ClipboardCheck, Check, X as XIcon, ChevronRight } from 'lucide-react';
import moment from 'moment';
import { POLL_DIAGNOSTIC_MS } from '@/lib/pollingIntervals';

// Age thresholds for the visual "don't forget this one" cue — a sinal de
// alta prioridade perde relevância com o tempo (mesmo raciocínio do Time
// Stop do motor de trading, mas aqui é só destaque visual, não gate).
const AGE_WARN_HOURS = 2;
const AGE_STALE_HOURS = 6;

function ageColor(createdDate) {
  const hours = (Date.now() - new Date(createdDate).getTime()) / 3600000;
  if (hours >= AGE_STALE_HOURS) return '#ff1478';
  if (hours >= AGE_WARN_HOURS) return '#ff9f43';
  return 'rgba(255,255,255,0.4)';
}

// Fixed panel shown on the Dashboard's "Visão Geral" tab, right after
// SignalAlertBanner — surfaces VerificationTasks (created automatically by
// scanner.js for every high-priority signal) so a strong signal never goes
// unreviewed just because nobody had the dashboard open when it fired.
export default function VerificationWidget() {
  const queryClient = useQueryClient();

  const { data: tasks = [] } = useQuery({
    queryKey: ['verification-tasks-recent'],
    queryFn: () => backend.entities.VerificationTask.list('-created_date', 50),
    refetchInterval: POLL_DIAGNOSTIC_MS,
  });

  const reviewMutation = useMutation({
    /** @param {{ id: string, status: string }} args */
    mutationFn: ({ id, status }) => backend.entities.VerificationTask.update(id, {
      status,
      reviewed_at: new Date().toISOString(),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['verification-tasks-recent'] }),
  });

  if (tasks.length === 0) return null;

  const pending = tasks.filter(t => t.status === 'pending');
  const doneCount = tasks.length - pending.length;
  const progressPct = Math.round((doneCount / tasks.length) * 100);

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4" style={{ color: '#ffd166' }} />
          <h2 className="text-sm font-bold text-foreground tracking-tight">Verificação de Sinais</h2>
          {pending.length > 0 && (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(255,209,102,0.1)', border: '1px solid rgba(255,209,102,0.25)', color: '#ffd166' }}>
              {pending.length} pendente{pending.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <Link to="/verification" className="flex items-center gap-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors">
          Ver todas <ChevronRight className="w-3 h-3" />
        </Link>
      </div>

      <div className="w-full h-1.5 rounded-full overflow-hidden mb-3" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${progressPct}%`, background: '#00ff80' }} />
      </div>

      {pending.length === 0 ? (
        <p className="text-[11px] text-muted-foreground py-1">Tudo revisado — nenhum sinal de alta prioridade pendente.</p>
      ) : (
        <div className="space-y-1.5">
          {pending.slice(0, 5).map(task => (
            <div key={task.id}
              className="flex items-center gap-2 px-2.5 py-2 rounded-lg"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-foreground">{task.symbol?.replace('USDT', '/USDT')}</span>
                  <span className="text-[9px] font-mono text-muted-foreground">{task.timeframe?.toUpperCase()}</span>
                  <span className="text-[9px] font-mono" style={{ color: task.signal_type === 'BUY' ? '#00ff80' : '#ff1478' }}>
                    {task.signal_type === 'BUY' ? '↑ BUY' : '↓ SELL'}
                  </span>
                  <span className="text-[9px] font-mono" style={{ color: ageColor(task.created_date) }}>
                    {moment(task.created_date).fromNow()}
                  </span>
                </div>
              </div>
              <button onClick={() => reviewMutation.mutate({ id: task.id, status: 'reviewed' })}
                title="Marcar como revisado (OK)"
                className="shrink-0 p-1.5 rounded-md hover:bg-white/[0.08] transition-colors">
                <Check className="w-3.5 h-3.5" style={{ color: '#00ff80' }} />
              </button>
              <button onClick={() => reviewMutation.mutate({ id: task.id, status: 'skipped' })}
                title="Pular"
                className="shrink-0 p-1.5 rounded-md hover:bg-white/[0.08] transition-colors">
                <XIcon className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
