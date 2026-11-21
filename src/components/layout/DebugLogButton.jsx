import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { Bug, X, Trash2 } from 'lucide-react';
import moment from 'moment';
import { POLL_DIAGNOSTIC_MS } from '@/lib/pollingIntervals';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

const LEVEL_CONFIG = {
  error: { color: '#e06a5b', label: 'ERR', bg: 'rgba(224,106,91,0.1)', border: 'rgba(224,106,91,0.25)' },
  warn:  { color: '#dd9a4a', label: 'WRN', bg: 'rgba(221,154,74,0.08)', border: 'rgba(221,154,74,0.2)' },
  info:  { color: 'rgba(141,180,226,0.7)', label: 'INF', bg: 'rgba(141,180,226,0.07)', border: 'rgba(141,180,226,0.15)' },
  debug: { color: 'rgba(255,255,255,0.55)', label: 'DBG', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.07)' },
};

export default function DebugLogButton() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('error'); // default mostra só erros

  const { data: logs = [] } = useQuery({
    queryKey: ['system-logs-debug'],
    queryFn: () => backend.entities.SystemLog.list('-created_date', 50),
    refetchInterval: POLL_DIAGNOSTIC_MS,
    enabled: open,
  });

  const queryClient = useQueryClient();

  const anomalies = logs.filter(l => l.level === 'error' || l.level === 'warn');
  const filtered = filter === 'all' ? logs.slice(0, 30) : logs.filter(l => l.level === filter).slice(0, 30);

  const deleteLog = useMutation({
    mutationFn: (id) => backend.entities.SystemLog.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['system-logs-debug'] }),
  });

  return (
    <>
      {/* Achado pós-M-10 (docs/known-risks.md): a barra mobile ganhou um
          item "Mais" mais largo (~65px) que passou a cobrir por completo
          este botão fixo (antes a barra tinha 12 itens estreitos e a
          colisão era só parcial, na borda). `bottom-20`/`md:bottom-5`
          sobe o botão acima dos 64px da nav em mobile, volta à posição
          original a partir do breakpoint desktop (sem nav inferior),
          mesmo padrão já usado em AppLayout.jsx (`pb-16 md:pb-0`) e no
          Toast do shadcn/ui (posição por breakpoint). */}
      {/* Floating button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setOpen(!open)}
            aria-label="Debug Log"
            className="fixed bottom-20 right-5 md:bottom-5 z-50 w-10 h-10 rounded-full flex items-center justify-center transition-all"
            style={{
              background: anomalies.length > 0 ? 'rgba(224,106,91,0.15)' : 'rgba(24,23,21,0.9)',
              border: anomalies.length > 0 ? '1px solid rgba(224,106,91,0.4)' : '1px solid rgba(255,255,255,0.1)',
              boxShadow: anomalies.length > 0 ? '0 0 16px rgba(224,106,91,0.3)' : '0 4px 20px rgba(0,0,0,0.4)',
            }}>
            <Bug className="w-4 h-4" style={{ color: anomalies.length > 0 ? '#e06a5b' : 'rgba(255,255,255,0.62)' }} />
            {anomalies.length > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-8px font-mono font-bold flex items-center justify-center"
                style={{ background: '#e06a5b', color: '#fff' }}>
                {anomalies.length > 9 ? '9+' : anomalies.length}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
          Debug Log
        </TooltipContent>
      </Tooltip>

      {/* Panel — bottom-32/md:bottom-20 acompanha o botão acima (mesmo
          achado pós-M-10); a classe anterior (`bottom-18`) não existe na
          escala padrão do Tailwind nem foi customizada em
          tailwind.config.js — não gerava nenhum posicionamento vertical. */}
      {open && (
        <div className="fixed bottom-32 right-5 md:bottom-20 z-50 w-96 max-w-[95vw] rounded-lg overflow-hidden"
          style={{ background: 'rgba(20,19,17,0.97)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-2">
              <Bug className="w-3.5 h-3.5" style={{ color: '#e06a5b' }} />
              <span className="text-11px font-mono font-bold text-foreground">Debug Log</span>
              {anomalies.length > 0 && (
                <span className="text-8px font-mono px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(224,106,91,0.12)', color: '#e06a5b', border: '1px solid rgba(224,106,91,0.25)' }}>
                  {anomalies.length} anomalias
                </span>
              )}
            </div>
            <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-white/5">
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>

          {/* Filter tabs */}
          <div className="flex items-center gap-1 px-3 py-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            {['error', 'warn', 'info', 'all'].map(lvl => {
              const cfg = LEVEL_CONFIG[lvl] || { color: '#8db4e2', label: 'ALL' };
              return (
                <button key={lvl} onClick={() => setFilter(lvl)}
                  className="text-8px font-mono px-2 py-1 rounded transition-all"
                  style={filter === lvl
                    ? { background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color }
                    : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.55)' }}>
                  {lvl === 'all' ? 'TODOS' : cfg.label}
                </button>
              );
            })}
          </div>

          {/* Log list */}
          <div className="overflow-y-auto font-mono" style={{ maxHeight: '50vh' }}>
            {filtered.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-10px font-mono text-muted-foreground">Nenhuma anomalia registrada ✓</p>
              </div>
            ) : filtered.map((log, i) => {
              const cfg = LEVEL_CONFIG[log.level] || LEVEL_CONFIG.info;
              return (
                <div key={log.id} className="group flex items-start gap-2 px-3 py-2 hover:bg-white/[0.012] transition-colors"
                  style={{ borderTop: i > 0 ? '1px solid rgba(255,255,255,0.03)' : 'none' }}>
                  <span className="text-8px px-1 py-0.5 rounded shrink-0 mt-0.5"
                    style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color }}>
                    {cfg.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    {log.module && <span className="text-8px text-muted-foreground">[{log.module}] </span>}
                    {log.symbol && <span className="text-8px" style={{ color: 'rgba(141,180,226,0.5)' }}>{log.symbol} </span>}
                    <span className="text-9px text-foreground/70 break-words">{log.message}</span>
                    {log.details && (
                      <details className="mt-1">
                        <summary className="text-8px cursor-pointer" style={{ color: 'rgba(255,255,255,0.2)' }}>detalhes</summary>
                        <pre className="text-8px overflow-x-auto mt-0.5" style={{ color: 'rgba(93,181,134,0.5)' }}>
                          {JSON.stringify(log.details, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-8px" style={{ color: 'rgba(255,255,255,0.2)' }}>
                      {moment(log.created_date).format('HH:mm')}
                    </span>
                    {/* Achado da varredura pós-Raio-X (2026-09-27): ícone só
                        em :hover nunca aparecia em touch (mesma classe do
                        Refinamento #1, nunca aplicada aqui) + sem feedback
                        de isPending durante a mutação. */}
                    <button onClick={() => deleteLog.mutate(log.id)}
                      disabled={deleteLog.isPending}
                      className="opacity-40 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                      <Trash2 className="w-2.5 h-2.5 text-muted-foreground hover:text-rose-400" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {anomalies.length === 0 && (
            <div className="px-4 py-2.5 text-9px font-mono flex items-center gap-1.5"
              style={{ borderTop: '1px solid rgba(255,255,255,0.04)', color: '#5db586' }}>
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
              Sistema operando normalmente
            </div>
          )}
        </div>
      )}
    </>
  );
}