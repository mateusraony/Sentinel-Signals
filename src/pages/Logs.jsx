import React, { useState, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { ScrollText, RefreshCw, AlertTriangle, Info, Bug, AlertCircle, X, Search, Trash2, Copy, Check, CheckCircle2, HelpCircle, Filter } from 'lucide-react';
import { QueryErrorState } from '@/components/QueryErrorState';
import moment from 'moment';
import { dayLabel } from '@/lib/dayLabel';
import { POLL_DIAGNOSTIC_MS } from '@/lib/pollingIntervals';
import { explainLog, healthSummary, hourlyActivity, normalizeMessage, LEVEL_HELP, EXECUTOR_HELP } from '@/lib/logInsights';

// Auditoria do Telegram (2026-09-29), Fase 2 item 2.4 — erro de sistema
// reaproveitava a MESMA cor (#e06a5b, rosa/magenta) usada pra SELL/direção
// em outras telas, sem nenhuma relação entre os dois conceitos. Escopo
// reduzido do item original da auditoria (ver plano): não uma reescrita
// completa de 2 escalas de cor — só este ponto específico de sobreposição
// sem propósito. #ef4444 é um vermelho "puro", visualmente distinto do
// rosa/magenta de SELL/loss.
const LEVEL_CONFIG = {
  info:  { icon: Info,          color: 'rgba(141,180,226,0.8)',   bg: 'rgba(141,180,226,0.08)',   border: 'rgba(141,180,226,0.2)',   label: 'INFO' },
  warn:  { icon: AlertTriangle, color: '#dd9a4a',               bg: 'rgba(221,154,74,0.08)',  border: 'rgba(221,154,74,0.25)', label: 'WARN' },
  error: { icon: AlertCircle,   color: '#ef4444',               bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.25)',  label: 'ERR'  },
  debug: { icon: Bug,           color: 'rgba(255,255,255,0.55)', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.07)',label: 'DBG'  },
};

// Resumo de saúde: cores/ícone por estado (regras em src/lib/logInsights.js — só leitura dos logs, nada toca motor/scan).
const HEALTH_STYLE = {
  ok:        { icon: CheckCircle2,  color: '#5db586', bg: 'rgba(93,181,134,0.07)',  border: 'rgba(93,181,134,0.25)' },
  attention: { icon: AlertTriangle, color: '#dd9a4a', bg: 'rgba(221,154,74,0.07)',  border: 'rgba(221,154,74,0.28)' },
  problem:   { icon: AlertCircle,   color: '#ef4444', bg: 'rgba(239,68,68,0.07)',   border: 'rgba(239,68,68,0.3)' },
  unknown:   { icon: HelpCircle,    color: 'rgba(255,255,255,0.6)', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.1)' },
};
const TONE_COLOR = { normal: 'rgba(255,255,255,0.5)', attention: '#dd9a4a', problem: '#ef4444' };

function sinceText(ms, now) {
  if (ms == null) return null;
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 1) return 'agora há pouco';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `há ${h} h` : `há ${Math.floor(h / 24)} dias`;
}

function SectionTitle({ children, hint }) {
  return (
    <div className="flex items-center gap-2 px-1 mb-2">
      <span aria-hidden="true" style={{ width: 3, height: 16, borderRadius: 2, background: '#8db4e2', display: 'inline-block' }} />
      <h2 className="text-sm font-semibold text-foreground/80">{children}</h2>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

export default function Logs() {
  const [filterLevel, setFilterLevel] = useState('all');
  const [filterModule, setFilterModule] = useState('all');
  const [search, setSearch] = useState('');
  const [filterGroup, setFilterGroup] = useState(null); // grupo de "o que mais se repete" (módulo + mensagem normalizada)
  const [showAllGroups, setShowAllGroups] = useState(false);

  const { data: logs = [], isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['system-logs'],
    queryFn: () => backend.entities.SystemLog.list('-created_date', 200),
    refetchInterval: POLL_DIAGNOSTIC_MS,
  });

  const clearLogsMutation = useMutation({
    mutationFn: async () => {
      const old = logs.filter(l => moment().diff(moment(l.created_date), 'hours') > 24);
      await Promise.all(old.map(l => backend.entities.SystemLog.delete(l.id)));
    },
    onSuccess: () => refetch(),
  });

  const filtered = logs.filter(log => {
    if (filterLevel !== 'all' && log.level !== filterLevel) return false;
    if (filterModule !== 'all' && log.module !== filterModule) return false;
    if (filterGroup && `${log.module ?? '?'} · ${normalizeMessage(log.message)}` !== filterGroup.key) return false;
    if (search) {
      // Também casa scan_id/error_class (item 253) — colar um scan_id aqui
      // mostra todos os logs daquela passada.
      const q = search.toLowerCase();
      const hit = [log.message, log.symbol, log.details?.scan_id, log.details?.error_class]
        .some(v => typeof v === 'string' && v.toLowerCase().includes(q));
      if (!hit) return false;
    }
    return true;
  });

  const modules = [...new Set(logs.map(l => l.module).filter(Boolean))];
  const errorCount = logs.filter(l => l.level === 'error').length;
  const warnCount  = logs.filter(l => l.level === 'warn').length;

  const hasActiveFilters = filterLevel !== 'all' || filterModule !== 'all' || search || filterGroup;

  // Enquanto carrega, ou se a carga falhou sem dado nenhum, as contagens NÃO sabem o número: mostram "—" em vez de afirmar "0".
  const countsUnknown = isLoading || (isError && logs.length === 0);
  const showCount = (n) => (countsUnknown ? '—' : n);
  // A consulta traz no máximo os 200 registros mais recentes — as contagens são DESSES, e a tela diz isso quando bate no teto.
  const hitLimit = logs.length >= 200;

  // Leitura dos logs em português simples (últimas 24 h entre os registros carregados). Sem leitura (carregando/falha): "unknown", nunca "tudo normal".
  const now = Date.now();
  const health = useMemo(() => healthSummary(logs, { now, known: !countsUnknown }), [logs, countsUnknown]); // eslint-disable-line react-hooks/exhaustive-deps
  const hours = useMemo(() => hourlyActivity(logs, { now }), [logs]); // eslint-disable-line react-hooks/exhaustive-deps
  const hourMax = Math.max(1, ...hours.map(h => h.error + h.warn + h.info + h.debug));
  const hStyle = HEALTH_STYLE[health.status];
  const HealthIcon = hStyle.icon;
  const problemGroups = health.groups ?? [];
  const shownGroups = showAllGroups ? problemGroups : problemGroups.slice(0, 5);

  // Agrupa por dia (Map, na ordem em que cada dia aparece): a hora sozinha (HH:mm:ss) não diz de que dia é o registro.
  const dayGroups = new Map();
  for (const log of filtered) {
    const day = moment(log.created_date);
    const key = day.format('YYYY-MM-DD');
    if (!dayGroups.has(key)) dayGroups.set(key, { key, day, items: [] });
    dayGroups.get(key).items.push(log);
  }
  const groups = [...dayGroups.values()];

  const clearFilters = () => { setSearch(''); setFilterLevel('all'); setFilterModule('all'); setFilterGroup(null); };

  const [copied, setCopied] = useState(false);
  // Texto plano, não JSON — pensado para colar direto numa conversa (o
  // pedido original era "não consigo copiar o que está na tela pra você
  // ler"). Respeita os filtros ativos (nível/módulo/busca), não os 200
  // logs inteiros — o que está na tela é o que o usuário quer copiar.
  const handleCopy = async () => {
    const text = filtered.map(log => {
      const time = moment(log.created_date).format('YYYY-MM-DD HH:mm:ss');
      const tags = [log.module, log.symbol, log.timeframe, log.executor].filter(Boolean).join(' ');
      const details = log.details ? `\n  ${JSON.stringify(log.details)}` : '';
      return `[${time}] ${log.level?.toUpperCase() || 'INFO'} ${tags ? `(${tags}) ` : ''}${log.message}${details}`;
    }).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API pode falhar (permissão negada, contexto não-seguro);
      // sem fallback silencioso — o botão só reage se realmente copiou.
    }
  };

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-muted-foreground mb-1">Observabilidade</p>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Logs do Sistema</h1>
          <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground mt-1">
            <div className="live-dot" style={{ width: 5, height: 5 }} />
            <span>Auto-atualiza a cada {POLL_DIAGNOSTIC_MS / 60000}min</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => refetch()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-11px font-mono transition-all"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)' }}>
            <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} />Atualizar
          </button>
          <button onClick={handleCopy} disabled={filtered.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-11px font-mono transition-all disabled:opacity-40"
            style={copied
              ? { background: 'rgba(93,181,134,0.08)', border: '1px solid rgba(93,181,134,0.25)', color: '#5db586' }
              : { background: 'rgba(141,180,226,0.06)', border: '1px solid rgba(141,180,226,0.15)', color: '#8db4e2' }}>
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copiado!' : `Copiar (${filtered.length})`}
          </button>
          <button onClick={() => clearLogsMutation.mutate()} disabled={clearLogsMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-11px font-mono transition-all hover:opacity-80"
            style={{ background: 'rgba(221,154,74,0.06)', border: '1px solid rgba(221,154,74,0.15)', color: '#dd9a4a' }}>
            <Trash2 className="w-3 h-3" />Limpar antigos
          </button>
        </div>
      </div>

      {/* Resumo de saúde: a resposta em uma frase ("está tudo bem?") antes de qualquer linha crua. */}
      <div role="status" aria-label="Resumo de saúde dos logs" className="rounded-md px-4 py-3 flex items-start gap-3" style={{ background: hStyle.bg, border: `1px solid ${hStyle.border}` }}>
        <HealthIcon className="w-5 h-5 shrink-0 mt-0.5" style={{ color: hStyle.color }} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold" style={{ color: hStyle.color }}>{isLoading ? 'Lendo os logs…' : health.headline}</p>
          {health.status === 'unknown' ? (
            <p className="text-xs text-muted-foreground mt-0.5">{isLoading ? 'Aguarde um instante.' : 'Não foi possível carregar os logs; por isso não dá para dizer se está tudo bem. Tente Atualizar.'}</p>
          ) : (
            <>
              {health.reasons.length > 0 ? (
                <ul className="text-xs text-foreground/75 mt-1 space-y-0.5 list-disc pl-4">
                  {health.reasons.map(r => <li key={r}>{r}</li>)}
                </ul>
              ) : (
                <p className="text-xs text-foreground/75 mt-0.5">Nenhum erro nem aviso nas últimas 24 horas.</p>
              )}
              <p className="text-11px text-muted-foreground mt-1.5">
                Baseado nos {logs.length} registros carregados · último registro {health.lastLogAt ? `${moment(health.lastLogAt).format('DD/MM HH:mm')} (${sinceText(health.lastLogAt, now)})` : '—'}
              </p>
            </>
          )}
        </div>
      </div>

      {/* Contagens: uma linha só (eram 4 cartões com ícone). */}
      <div className="rounded-md px-4 py-2.5 flex flex-wrap items-center gap-x-8 gap-y-1.5" style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.07)' }}>
        {[
          { label: 'Total', value: showCount(logs.length), color: '#8db4e2' },
          { label: 'Erros', value: showCount(errorCount), color: '#ef4444' },
          { label: 'Warnings', value: showCount(warnCount), color: '#dd9a4a' },
          { label: 'Info', value: showCount(logs.filter(l => l.level === 'info').length), color: 'rgba(141,180,226,0.8)' },
        ].map(({ label, value, color }) => (
          <div key={label} className="flex items-baseline gap-2">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-lg font-mono font-medium tabular-nums" style={{ color }}>{value}</span>
          </div>
        ))}
        {hitLimit && <span className="text-xs text-muted-foreground ml-auto">os 200 registros mais recentes</span>}
      </div>

      {/* O que mais se repete + atividade por hora (últimas 24 h) */}
      <div className="grid gap-5 lg:grid-cols-5">
        <section className="lg:col-span-3" aria-label="O que mais se repete">
          <SectionTitle hint="erros e avisos das últimas 24 h, agrupados">O que mais se repete</SectionTitle>
          <div className="rounded-md overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            {countsUnknown ? (
              <p className="px-4 py-4 text-xs text-muted-foreground" style={{ background: 'rgba(24,23,21,0.7)' }}>—</p>
            ) : problemGroups.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted-foreground flex items-center gap-2" style={{ background: 'rgba(24,23,21,0.7)' }}>
                <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: '#5db586' }} aria-hidden="true" />Nenhum erro ou aviso nas últimas 24 horas.
              </p>
            ) : (
              <>
                {shownGroups.map((g, i) => {
                  const cfg = LEVEL_CONFIG[g.level];
                  const ex = explainLog(g.example);
                  const active = filterGroup?.key === g.key;
                  return (
                    <div key={g.key} className="px-4 py-2.5" style={{ background: i % 2 === 0 ? 'rgba(24,23,21,0.85)' : 'rgba(18,17,16,0.7)', borderTop: i > 0 ? '1px solid rgba(255,255,255,0.03)' : 'none' }}>
                      <div className="flex items-start gap-3">
                        <span className="text-11px px-1.5 py-0.5 rounded font-semibold shrink-0 mt-0.5" style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color }}>{cfg.label}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-foreground/90 leading-relaxed break-words">{g.assets.length > 1 ? normalizeMessage(g.example.message).replace(/<ativo>/g, 'ativo') : g.example.message}</p>
                          <p className="text-11px text-muted-foreground mt-0.5">
                            {g.total}× · módulo {g.module}
                            {g.assets.length > 0 && ` · ${g.assets.length} ${g.assets.length === 1 ? 'ativo' : 'ativos'} (${g.assets.slice(0, 3).join(', ')}${g.assets.length > 3 ? '…' : ''})`}
                            {g.last && ` · último ${sinceText(g.last, now)}`}
                          </p>
                          {g.onlyBrowser && (
                            <p className="text-11px mt-1" style={{ color: '#5db586' }}>Só do navegador — o scan agendado não foi afetado.</p>
                          )}
                          {ex && <p className="text-11px mt-1 text-foreground/65">{ex.meaning} <span style={{ color: TONE_COLOR[ex.tone] }}>{ex.action}</span></p>}
                        </div>
                        <button onClick={() => setFilterGroup(active ? null : g)} aria-pressed={active}
                          className="shrink-0 text-11px px-2 py-1 rounded-md flex items-center gap-1 transition-all"
                          style={active
                            ? { background: 'rgba(141,180,226,0.15)', border: '1px solid rgba(141,180,226,0.3)', color: '#8db4e2' }
                            : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.65)' }}>
                          <Filter className="w-3 h-3" aria-hidden="true" />{active ? 'Filtrando' : 'Ver registros'}
                        </button>
                      </div>
                    </div>
                  );
                })}
                {problemGroups.length > 5 && (
                  <button onClick={() => setShowAllGroups(v => !v)} className="w-full text-11px py-2 text-muted-foreground hover:text-foreground transition-colors" style={{ background: 'rgba(18,17,16,0.7)', borderTop: '1px solid rgba(255,255,255,0.03)' }}>
                    {showAllGroups ? 'Mostrar só os 5 principais' : `Mostrar todos os ${problemGroups.length} tipos`}
                  </button>
                )}
              </>
            )}
          </div>
        </section>

        <section className="lg:col-span-2" aria-label="Atividade nas últimas 24 horas">
          <SectionTitle hint="registros por hora">Últimas 24 horas</SectionTitle>
          <div className="rounded-md px-4 py-3" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
            {countsUnknown ? (
              <p className="text-xs text-muted-foreground py-6 text-center">—</p>
            ) : (
              <>
                <div className="flex items-end gap-[3px] h-16" role="img" aria-label="Registros por hora nas últimas 24 horas">
                  {hours.map(h => {
                    const total = h.error + h.warn + h.info + h.debug;
                    const pct = total === 0 ? 0 : Math.max(8, Math.round((total / hourMax) * 100));
                    const seg = (n, color) => n > 0 && <div style={{ flexGrow: n, background: color, minHeight: 2 }} />;
                    return (
                      <div key={h.start} className="flex-1 flex flex-col justify-end h-full"
                        title={`${moment(h.start).format('HH')}h — ${h.error} erros, ${h.warn} avisos, ${h.info + h.debug} informativos`}>
                        {total === 0
                          ? <div style={{ height: 2, background: 'rgba(255,255,255,0.08)' }} />
                          : <div className="flex flex-col rounded-sm overflow-hidden" style={{ height: `${pct}%` }}>
                              {seg(h.error, '#ef4444')}{seg(h.warn, '#dd9a4a')}{seg(h.info + h.debug, 'rgba(141,180,226,0.55)')}
                            </div>}
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-11px text-muted-foreground mt-1.5">
                  <span>24 h atrás</span><span>agora</span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-11px text-muted-foreground">
                  <span className="flex items-center gap-1.5"><i style={{ width: 8, height: 8, background: '#ef4444', display: 'inline-block', borderRadius: 2 }} />erros</span>
                  <span className="flex items-center gap-1.5"><i style={{ width: 8, height: 8, background: '#dd9a4a', display: 'inline-block', borderRadius: 2 }} />avisos</span>
                  <span className="flex items-center gap-1.5"><i style={{ width: 8, height: 8, background: 'rgba(141,180,226,0.55)', display: 'inline-block', borderRadius: 2 }} />informativos</span>
                </div>
              </>
            )}
          </div>
        </section>
      </div>

      {/* Como ler esta tela — recolhido por padrão */}
      <details className="rounded-md group" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <summary className="px-4 py-2.5 text-xs cursor-pointer select-none text-foreground/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-md">Como ler esta tela</summary>
        <div className="px-4 pb-3 grid gap-4 sm:grid-cols-2 text-xs text-foreground/75">
          <div>
            <p className="text-foreground/90 font-medium mb-1">Nível do registro</p>
            <ul className="space-y-0.5">
              {LEVEL_HELP.map(l => <li key={l.label}><span className="font-mono text-foreground/90">{l.label}</span> — {l.text}</li>)}
            </ul>
          </div>
          <div>
            <p className="text-foreground/90 font-medium mb-1">Quem registrou</p>
            <ul className="space-y-0.5">
              {Object.entries(EXECUTOR_HELP).map(([k, v]) => <li key={k}><span className="font-mono text-foreground/90">{k}</span> — {v}</li>)}
            </ul>
          </div>
          <p className="sm:col-span-2 text-11px text-muted-foreground">
            A tela mostra os 200 registros mais recentes. “Limpar antigos” apaga os com mais de 24 horas. Erro que só o navegador teve não significa falha do sistema: quem opera é o scan agendado.
            As explicações em cada linha só existem para mensagens que o sistema realmente grava; as demais aparecem sem explicação.
          </p>
        </div>
      </details>

      {/* Filters: busca + atalho + Nível em abas ligadas + Módulo */}
      <div className="rounded-md p-3 space-y-3" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[11rem] sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            <input type="text" placeholder="Buscar na mensagem..." title="Também busca por ativo, scan_id e classe do erro" value={search} onChange={e => setSearch(e.target.value)}
              className="w-full pl-7 pr-3 py-1.5 rounded-md text-11px font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }} />
          </div>
          {/* Atalho pro item 192 (docs/known-risks.md) — achar rápido as
              ocorrências de "Failed to fetch" (cron vs navegador, item 57
              addendum) sem digitar/selecionar os 3 filtros na mão toda vez. */}
          <button onClick={() => { setSearch('Failed to fetch'); setFilterLevel('error'); setFilterModule('scanner'); }}
            className="text-11px font-mono px-2.5 py-1.5 rounded-md transition-all"
            style={{ background: 'rgba(224,106,91,0.06)', border: '1px solid rgba(224,106,91,0.2)', color: '#e06a5b' }}>
            📡 Falhas de rede (Failed to fetch)
          </button>
          {filterGroup && (
            <span className="text-11px px-2 py-1.5 rounded-md flex items-center gap-1.5 max-w-full" style={{ background: 'rgba(141,180,226,0.1)', border: '1px solid rgba(141,180,226,0.25)', color: '#8db4e2' }}>
              <Filter className="w-3 h-3 shrink-0" aria-hidden="true" /><span className="truncate">Só este tipo: {normalizeMessage(filterGroup.example.message).replace(/<ativo>/g, 'ativo')}</span>
            </span>
          )}
          {hasActiveFilters && (
            <button onClick={clearFilters}
              className="ml-auto text-11px font-mono px-2.5 py-1.5 rounded-md flex items-center gap-1 transition-all"
              style={{ background: 'rgba(224,106,91,0.08)', border: '1px solid rgba(224,106,91,0.2)', color: '#e06a5b' }}>
              <X className="w-3 h-3" />Limpar
            </button>
          )}
        </div>

        <div className="flex items-center gap-x-5 gap-y-2 flex-wrap">
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">Nível</span>
            <div className="flex items-center rounded-md overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              {['all', 'error', 'warn', 'info', 'debug'].map((level, i) => {
                const cfg = LEVEL_CONFIG[level];
                const active = filterLevel === level;
                return (
                  <button key={level} onClick={() => setFilterLevel(level)}
                    className="text-11px font-mono px-3 py-1.5 transition-all whitespace-nowrap"
                    style={{
                      borderLeft: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.08)',
                      ...(active
                        ? { background: cfg ? cfg.bg : 'rgba(141,180,226,0.15)', color: cfg ? cfg.color : '#8db4e2' }
                        : { background: 'rgba(255,255,255,0.02)', color: 'rgba(255,255,255,0.55)' }),
                    }}>
                    {level === 'all' ? 'Todos' : cfg?.label || level.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">Módulo</span>
            <select value={filterModule} onChange={e => setFilterModule(e.target.value)}
              className="px-2 py-1.5 rounded-md text-11px font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)' }}>
              <option value="all">Todos módulos</option>
              {modules.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          <span className="text-xs font-mono text-muted-foreground sm:ml-auto shrink-0">{countsUnknown ? '—' : filtered.length} registros</span>
        </div>
      </div>

      {/* Log Feed */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : isError && logs.length === 0 ? (
        <div className="rounded-md p-8" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <QueryErrorState message="Não foi possível carregar os logs agora." onRetry={refetch} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md px-5 py-6 flex flex-wrap items-center gap-x-4 gap-y-3" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <ScrollText className="w-5 h-5 shrink-0 text-muted-foreground opacity-40" />
          <p className="text-muted-foreground text-sm">Nenhum log encontrado.</p>
          {hasActiveFilters && (
            <button onClick={clearFilters}
              className="ml-auto text-11px font-mono px-2.5 py-1.5 rounded-md flex items-center gap-1 transition-all"
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
                <span className="text-xs font-mono text-muted-foreground">{group.day.format('DD/MM')} · {group.items.length} {group.items.length === 1 ? 'registro' : 'registros'}</span>
              </div>
              <div className="rounded-md overflow-hidden font-mono" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                {group.items.map((log, i) => {
                  const cfg = LEVEL_CONFIG[log.level] || LEVEL_CONFIG.info;
                  return (
                    <div key={log.id}
                      className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.012]"
                      style={{ background: i % 2 === 0 ? 'rgba(24,23,21,0.85)' : 'rgba(18,17,16,0.7)', borderTop: i > 0 ? '1px solid rgba(255,255,255,0.03)' : 'none' }}>

                      {/* Hora e nível juntos, à esquerda (convenção de log: quando e quão grave vêm antes do texto) */}
                      <div className="flex flex-col items-start gap-1 shrink-0 w-[4.75rem] pt-0.5">
                        <span className="text-xs tabular-nums" style={{ color: 'rgba(255,255,255,0.62)' }}>
                          {moment(log.created_date).format('HH:mm:ss')}
                        </span>
                        <span className="text-11px px-1.5 py-0.5 rounded font-semibold"
                          style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color }}>
                          {cfg.label}
                        </span>
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-11px px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.62)' }}>
                            {log.module}
                          </span>
                          {log.symbol && <span className="text-11px" style={{ color: 'rgba(141,180,226,0.8)' }}>{log.symbol}</span>}
                          {log.timeframe && <span className="text-11px" style={{ color: 'rgba(255,255,255,0.55)' }}>{log.timeframe}</span>}
                          {log.duration_ms && <span className="text-11px" style={{ color: 'rgba(255,255,255,0.45)' }}>{log.duration_ms}ms</span>}
                          {/* item 197 addendum — o PR #393 passou a gravar executor
                              ('cron'/'browser') em todo SystemLog de erro do scanner,
                              mas o campo é de 1º nível (fora de `details`) e nunca
                              aparecia na tela — a peça que faltava pra decidir cron×
                              navegador sem inferência indireta. */}
                          {log.executor && <span className="text-11px px-1 rounded" style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.55)' }}>{log.executor}</span>}
                          {/* item 253 — classe do erro e id da passada (details). O
                              scan_id aparece abreviado; o valor inteiro está no
                              title e na busca acima. Contraste >= 4.5:1 (mesma
                              exigência do achado do PR #439). */}
                          {log.details?.error_class && <span className="text-11px px-1 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)' }}>{log.details.error_class}</span>}
                          {log.details?.scan_id && <span className="text-11px font-mono" title={log.details.scan_id} style={{ color: 'rgba(255,255,255,0.55)' }}>#{String(log.details.scan_id).slice(-6)}</span>}
                        </div>
                        <p className="text-xs text-foreground/85 mt-0.5 leading-relaxed">{log.message}</p>
                        {(() => {
                          const ex = explainLog(log);
                          if (!ex) return null;
                          return (
                            <p className="text-11px mt-1 leading-relaxed font-sans" style={{ color: 'rgba(255,255,255,0.62)' }}>
                              <span aria-hidden="true" style={{ color: TONE_COLOR[ex.tone] }}>● </span>
                              <span className="text-foreground/80">O que significa:</span> {ex.meaning} <span className="text-foreground/80">O que fazer:</span> <span style={{ color: TONE_COLOR[ex.tone] }}>{ex.action}</span>
                            </p>
                          );
                        })()}
                        {/* Achado do Codex review no PR #439 (aplicado aqui pela
                            mesma causa raiz, mesmo padrão original desta linha):
                            0.25 dava ~2.3:1 de contraste, abaixo do 4.5:1 exigido
                            pra texto pequeno — único controle visível pra revelar
                            o payload. */}
                        {log.details && (
                          <details className="mt-1">
                            <summary className="text-11px cursor-pointer select-none rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" style={{ color: 'rgba(255,255,255,0.62)' }}>ver detalhes →</summary>
                            <pre className="mt-1 text-11px overflow-x-auto py-1 rounded" style={{ color: 'rgba(93,181,134,0.75)', background: 'rgba(0,0,0,0.3)', padding: '4px 8px' }}>
                              {JSON.stringify(log.details, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
