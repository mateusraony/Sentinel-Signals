import TokenIcon from '@/components/TokenIcon';
import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Plus, Trash2, Loader2, CheckCircle2, XCircle, MinusCircle, History, Settings2, Coins, Clock, Search, ChevronDown, ChevronUp } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import AddAssetForm from '@/components/assets/AddAssetForm';
import AssetConfigPanel from '@/components/assets/AssetConfigPanel';
import AssetDetailPanel from '@/components/assets/AssetDetailPanel';
import { calcProximity } from '@/components/dashboard/ProximityBar';
import { QueryErrorState } from '@/components/QueryErrorState';
import { assetDataQuality, qualityBadge } from '@/lib/assetDataQuality';
import { useNow } from '@/hooks/useNow';
import moment from 'moment';
import { POLL_OPERATIONAL_MS } from '@/lib/pollingIntervals';

// Item 276: além da lista desta página (`['all-assets']`), invalida o prefixo
// `['monitored-assets']` — Dashboard, Trades, Verificação e a busca global usam
// o ativo para decidir se um aviso ainda pode virar operação (smc_enabled,
// is_active, timeframes ligados) e não podem ficar com o valor antigo.
function invalidateAssetLists(queryClient) {
  queryClient.invalidateQueries({ queryKey: ['all-assets'] });
  queryClient.invalidateQueries({ queryKey: ['monitored-assets'] });
}

// Achado A-9 do Raio-X de UI/UX — frescor pela mesma função pura do cartão e
// do drawer. Item 277: cálculo E texto agora vêm de `assetDataQuality`/
// `qualityBadge` (📡), em vez de um mapa LIVE/STALE/ERRO local.

export default function Assets() {
  // Item 277: o rótulo 📡 mostra a idade do scan — precisa andar com o relógio.
  const now = useNow();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [configAsset, setConfigAsset] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const queryClient = useQueryClient();

  // Read URL search param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlSearch = params.get('search');
    if (urlSearch) setSearch(urlSearch);
  }, []);

  // Reset filters on global event
  useEffect(() => {
    const handler = () => { setSearch(''); setFilterStatus('all'); setExpandedId(null); };
    window.addEventListener('app-reset-filters', handler);
    return () => window.removeEventListener('app-reset-filters', handler);
  }, []);

  const { data: assets = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['all-assets'],
    queryFn: () => backend.entities.MonitoredAsset.list('-created_date'),
    refetchInterval: POLL_OPERATIONAL_MS,
  });

  const { data: states = [], isError: statesError } = useQuery({
    queryKey: ['asset-states'],
    queryFn: () => backend.entities.AssetState.list(),
    refetchInterval: POLL_OPERATIONAL_MS,
  });

  const { data: recentSignals = [], isError: recentSignalsError } = useQuery({
    queryKey: ['recent-signals'],
    queryFn: () => backend.entities.SignalEvent.list('-created_date', 100),
    refetchInterval: POLL_OPERATIONAL_MS,
  });

  const { data: tradeOps = [], isError: tradeOpsError } = useQuery({
    queryKey: ['trade-operations-assets'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', 100),
    refetchInterval: POLL_OPERATIONAL_MS,
  });

  // Achado da varredura sistemática (item 196) — mesmo critério das outras
  // páginas: só "indisponível" quando não sobrou dado algum em cache.
  const statesUnavailable = statesError && states.length === 0;
  const signalsFilterUnavailable = (recentSignalsError && recentSignals.length === 0)
    || (tradeOpsError && tradeOps.length === 0);

  const toggleMutation = useMutation({
    /** @param {{ id: string, is_active: boolean }} args */
    mutationFn: ({ id, is_active }) => backend.entities.MonitoredAsset.update(id, {
      is_active,
      // docs/known-risks.md item 137 — reativar é, na prática, "adicionar de
      // volta": mesmo pedido do usuário de checagem retroativa que
      // AddAssetForm.jsx já dispara no cadastro. Só na transição
      // false→true — desativar não deve disparar nada.
      ...(is_active ? { backfill_check_status: 'pending' } : {}),
    }),
    onSuccess: () => invalidateAssetLists(queryClient),
  });

  const deleteMutation = useMutation({
    // AssetState (one doc per timeframe) has no lifecycle of its own tied to
    // MonitoredAsset — deleting only the asset left it orphaned forever
    // (confirmed in production: 4 removed assets, 12 stale AssetState docs
    // still being read/written by nothing). SignalEvent/TradeOperation stay
    // untouched — those are the audit trail, not per-asset scan state.
    mutationFn: async (id) => {
      await backend.entities.MonitoredAsset.delete(id);
      await backend.entities.AssetState.deleteMany({ asset_id: id });
    },
    onSuccess: () => {
      invalidateAssetLists(queryClient);
      queryClient.invalidateQueries({ queryKey: ['asset-states'] });
    },
  });

  const active = assets.filter(a => a.is_active);
  const inactive = assets.filter(a => !a.is_active);

  const ACTIVE_STATUSES = ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'];

  const assetsWithSignals = new Set(
    recentSignals.filter(s => s.source === 'range_filter').map(s => s.asset_id)
  );
  const assetsWithActiveTrades = new Set(
    tradeOps.filter(o => ACTIVE_STATUSES.includes(o.status)).map(o => o.asset_id)
  );

  // Mapa id → proximidade mais próxima entre os timeframes do ativo (não só
  // um Set de presença) — usado pelo filtro "📏 Perto da linha do filtro" e
  // pelo contorno neutro da linha (item 277: sem cor de lado nem pulsação —
  // a distância até o filtro não indica sinal próximo).
  const PROXIMITY_RANK = { very_close: 0, close: 1, watching: 2 };
  const assetsNearEntry = useMemo(() => {
    const nearMap = new Map();
    for (const a of assets) {
      if (!a.is_active) continue;
      const aStates = states.filter(s => s.asset_id === a.id);
      let best = null;
      for (const s of aStates) {
        const prox = calcProximity(s);
        if (prox && (!best || PROXIMITY_RANK[prox.level] < PROXIMITY_RANK[best.level])) best = prox;
      }
      if (best) nearMap.set(a.id, best);
    }
    return nearMap;
  }, [assets, states]);

  const filtered = assets.filter(a => {
    if (search && !a.display_name?.toLowerCase().includes(search.toLowerCase()) && !a.symbol?.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterStatus === 'active' && !a.is_active) return false;
    if (filterStatus === 'inactive' && a.is_active) return false;
    if (filterStatus === 'signals' && !assetsWithSignals.has(a.id) && !assetsWithActiveTrades.has(a.id)) return false;
    if (filterStatus === 'proximity' && !assetsNearEntry.has(a.id)) return false;
    return true;
  });

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-muted-foreground mb-1">Configuração</p>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Ativos</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
            <div className="live-dot" style={{ width: 5, height: 5 }} />
            <span>{active.length} ativos monitorados</span>
          </div>
          <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
            <DialogTrigger asChild>
              <Button size="sm" className="font-mono text-xs h-8 px-4"
                style={{ background: 'rgba(93,181,134,0.12)', border: '1px solid rgba(93,181,134,0.35)', color: '#5db586', boxShadow: 'none' }}>
                <Plus className="w-3.5 h-3.5 mr-2" />Adicionar
              </Button>
            </DialogTrigger>
            <DialogContent style={{ background: 'rgba(21,20,18,0.97)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <DialogHeader><DialogTitle className="font-mono">Adicionar Ativo</DialogTitle></DialogHeader>
              <AddAssetForm onSuccess={() => { setShowAddDialog(false); invalidateAssetLists(queryClient); }} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Contagens: uma linha só (eram 4 cartões grandes com ícone, quase sempre com os mesmos números do cabeçalho). */}
      <div className="rounded-md px-4 py-2.5 flex flex-wrap items-center gap-x-8 gap-y-1.5" style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.07)' }}>
        {[
          { label: 'Total', value: assets.length, color: '#8db4e2' },
          { label: 'Ativos', value: active.length, color: '#5db586' },
          { label: 'Inativos', value: inactive.length, color: '#64748b' },
          { label: 'Erros', value: assets.filter(a => a.scan_status === 'error').length, color: '#e06a5b' },
        ].map(({ label, value, color }) => (
          <div key={label} className="flex items-baseline gap-2">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-lg font-mono font-medium tabular-nums" style={{ color }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Search + filters: um painel, filtros em abas ligadas */}
      <div className="rounded-md p-3 flex flex-col sm:flex-row sm:items-center gap-3" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
          <input type="text" placeholder="Buscar ativo..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-7 pr-3 py-1.5 rounded-md text-11px font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.75)' }} />
        </div>
        <div className="flex items-center rounded-md overflow-x-auto" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          {[{ id: 'all', label: 'Todos' }, { id: 'active', label: '● Ativos' }, { id: 'inactive', label: '○ Inativos' },
            { id: 'signals', label: '🔔 Com sinal ou operação' },
            { id: 'proximity', label: '📏 Perto da linha do filtro' },
          ].map((f, i) => (
            <button key={f.id} onClick={() => setFilterStatus(f.id)}
              className="text-11px font-mono px-3 py-1.5 transition-all whitespace-nowrap shrink-0"
              style={{
                borderLeft: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.08)',
                ...(filterStatus === f.id
                  ? { background: 'rgba(141,180,226,0.15)', color: '#8db4e2' }
                  : { background: 'rgba(255,255,255,0.02)', color: 'rgba(255,255,255,0.55)' }),
              }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : isError && assets.length === 0 ? (
        <div className="rounded-md p-8" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <QueryErrorState message="Não foi possível carregar os ativos agora." onRetry={refetch} />
        </div>
      ) : filtered.length === 0 && filterStatus === 'proximity' && statesUnavailable ? (
        <div className="rounded-md p-8" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <QueryErrorState message="Não foi possível carregar os indicadores agora — o filtro 'Perto da linha do filtro' pode estar escondendo ativos incorretamente." />
        </div>
      ) : filtered.length === 0 && filterStatus === 'signals' && signalsFilterUnavailable ? (
        <div className="rounded-md p-8" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <QueryErrorState message="Não foi possível carregar sinais/operações agora — o filtro 'Com sinal ou operação' pode estar escondendo ativos incorretamente." />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md px-5 py-6 flex flex-wrap items-center gap-x-4 gap-y-3" style={{ background: 'rgba(24,23,21,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <Coins className="w-5 h-5 shrink-0 text-muted-foreground opacity-40" />
          <p className="text-muted-foreground text-sm">{assets.length === 0 ? 'Nenhum ativo cadastrado.' : 'Nenhum ativo encontrado.'}</p>
          {assets.length === 0 && (
            <Button size="sm" className="ml-auto" onClick={() => setShowAddDialog(true)}
              style={{ background: 'rgba(93,181,134,0.1)', border: '1px solid rgba(93,181,134,0.3)', color: '#5db586' }}>
              <Plus className="w-3.5 h-3.5 mr-2" />Adicionar primeiro ativo
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {/* Cabeçalho das colunas (só em tela larga): a linha de cada ativo agora é uma tabela de verdade, com as mesmas colunas de cima a baixo. */}
          <div aria-hidden="true" className="hidden lg:grid lg:grid-cols-[minmax(0,1.6fr)_9rem_minmax(0,1.3fr)_minmax(0,1.1fr)_11rem] gap-x-4 px-4 text-xs text-muted-foreground">
            <span>Ativo</span><span>Gráficos</span><span>Indicadores</span><span>Leitura e último scan</span><span />
          </div>
          {filtered.map(asset => {
            const assetStates = states.filter(s => s.asset_id === asset.id);
            const quality = assetDataQuality(asset, now);
            const { label: liveLabel, color: liveColor } = qualityBadge(quality);
            const proximity = assetsNearEntry.get(asset.id);
            const zoneStyle = proximity
              ? {
                background: 'rgba(24,23,21,0.82)',
                border: '1px solid rgba(141,180,226,0.35)',
              }
              : { background: 'rgba(24,23,21,0.82)', border: asset.is_active ? '1px solid rgba(93,181,134,0.1)' : '1px solid rgba(255,255,255,0.05)' };

            return (
              <div key={asset.id}
                className="rounded-md px-4 py-3.5 transition-all duration-300 group"
                style={zoneStyle}>
                <div className="grid grid-cols-2 lg:grid-cols-[minmax(0,1.6fr)_9rem_minmax(0,1.3fr)_minmax(0,1.1fr)_11rem] gap-x-4 gap-y-3 items-center">
                  {/* Ativo */}
                  <div className="col-span-1 lg:col-start-1 lg:row-start-1 flex items-center gap-3 min-w-0">
                    <Switch checked={asset.is_active} disabled={toggleMutation.isPending} onCheckedChange={(checked) => toggleMutation.mutate({ id: asset.id, is_active: checked })} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <TokenIcon symbol={asset.symbol} size={18} />
                        <span className="font-semibold text-sm text-foreground">{asset.display_name}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-11px font-mono text-muted-foreground">{asset.symbol}</span>
                        <span className="text-11px font-mono px-1.5 py-0.5 rounded"
                          style={{ background: 'rgba(141,180,226,0.08)', border: '1px solid rgba(141,180,226,0.15)', color: 'rgba(141,180,226,0.8)' }}>
                          {asset.exchange || 'binance'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Ações */}
                  <div className="col-start-2 row-start-1 justify-self-end lg:col-start-5 flex items-center gap-1.5 shrink-0">
                    <button
                      className="flex items-center gap-1 px-2.5 py-2 rounded-md text-11px font-mono font-semibold transition-all hover:opacity-80"
                      style={expandedId === asset.id
                        ? { background: 'rgba(93,181,134,0.1)', border: '1px solid rgba(93,181,134,0.3)', color: '#5db586' }
                        : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}
                      onClick={() => setExpandedId(expandedId === asset.id ? null : asset.id)}>
                      {expandedId === asset.id ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      className="flex items-center gap-1 px-3 py-2 rounded-md text-11px font-mono font-semibold transition-all hover:opacity-80"
                      style={{ background: 'rgba(141,180,226,0.08)', border: '1px solid rgba(141,180,226,0.2)', color: '#8db4e2' }}
                      onClick={() => setConfigAsset(asset)}>
                      <Settings2 className="w-3.5 h-3.5" /><span className="hidden sm:inline">Config</span>
                    </button>
                    <button
                      className="flex items-center gap-1 px-3 py-2 rounded-md text-11px font-mono font-semibold transition-all hover:opacity-80"
                      style={{ background: 'rgba(224,106,91,0.08)', border: '1px solid rgba(224,106,91,0.2)', color: '#e06a5b' }}
                      disabled={deleteMutation.isPending}
                      onClick={() => setPendingDelete(asset)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Gráficos (1h / 4h / 1d) e direção do Range Filter */}
                  <div className="col-span-2 lg:col-span-1 lg:col-start-2 lg:row-start-1 flex items-center gap-1.5 flex-wrap">
                    {['1h', '4h', '1d'].map(tf => {
                      const tfState = assetStates.find(s => s.timeframe === tf);
                      const enabled = asset.timeframes_enabled?.[tf] !== false;
                      const rfDir = tfState?.rf_direction;
                      const dirColor = rfDir === 1 ? '#5db586' : rfDir === -1 ? '#e06a5b' : null;
                      return (
                        <span key={tf} className="text-11px font-mono px-1.5 py-0.5 rounded flex items-center gap-0.5"
                          style={enabled
                            ? { background: 'rgba(93,181,134,0.06)', border: '1px solid rgba(93,181,134,0.18)', color: 'rgba(93,181,134,0.8)' }
                            : { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.3)' }}>
                          {tf}
                          {dirColor && <span style={{ color: dirColor }}>{rfDir === 1 ? '▲' : '▼'}</span>}
                        </span>
                      );
                    })}
                  </div>

                  {/* Indicadores por gráfico (RSI e MACD) */}
                  <div className="col-span-2 lg:col-span-1 lg:col-start-3 lg:row-start-1 flex items-center gap-x-4 gap-y-1 flex-wrap">
                    {assetStates.length === 0 && <span className="text-11px font-mono text-muted-foreground/60">sem leitura</span>}
                    {assetStates.map(s => (
                      <div key={s.timeframe} className="flex items-center gap-1.5 text-11px font-mono">
                        <span style={{ color: 'rgba(255,255,255,0.55)' }}>{s.timeframe?.toUpperCase()}</span>
                        {s.rsi_value && <span style={{ color: s.rsi_zone === 'overbought' ? '#e06a5b' : s.rsi_zone === 'oversold' ? '#5db586' : '#8a94a6' }}>RSI {s.rsi_value.toFixed(0)}</span>}
                        {s.macd_histogram !== undefined && <span style={{ color: s.macd_histogram > 0 ? '#5db586' : '#e06a5b' }}>MACD{s.macd_histogram > 0 ? '▲' : '▼'}</span>}
                      </div>
                    ))}
                  </div>

                  {/* Leitura e último scan */}
                  <div className="col-span-2 lg:col-span-1 lg:col-start-4 lg:row-start-1 space-y-1 min-w-0">
                    <div className="flex items-start gap-1.5">
                      <span className="shrink-0 mt-[7px]" style={{ width: 5, height: 5, borderRadius: '50%', display: 'inline-block', background: liveColor }} />
                      <span className="text-11px font-mono min-w-0" style={{ color: liveColor }}>{liveLabel}</span>
                      <span className="inline-flex items-center gap-1.5 shrink-0 mt-0.5">
                      {asset.scan_status === 'error' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex cursor-help" tabIndex={0}>
                              <XCircle className="w-3 h-3 text-rose-400" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                            Último scan falhou
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {asset.scan_status === 'success' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex cursor-help" tabIndex={0}>
                              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                            Último scan ok
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {(!asset.scan_status || asset.scan_status === 'idle') && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex cursor-help" tabIndex={0}>
                              <MinusCircle className="w-3 h-3 text-muted-foreground/40" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                            Ainda não escaneado
                          </TooltipContent>
                        </Tooltip>
                      )}
                      </span>
                    </div>
                    <div className="empty:hidden">
                      {asset.backfill_check_status === 'pending' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-0.5 text-11px font-mono px-1.5 py-0.5 rounded cursor-help" tabIndex={0}
                              style={{ background: 'rgba(221,154,74,0.1)', border: '1px solid rgba(221,154,74,0.25)', color: '#dd9a4a' }}>
                              <History className="w-2.5 h-2.5" />backfill pendente
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[260px] text-11px font-mono normal-case tracking-normal leading-relaxed">
                            Verificação retroativa de sinais ainda pendente para este ativo
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    {(asset.last_scan_at || asset.scan_error) && (
                      <div className="flex items-center gap-2 flex-wrap text-11px font-mono text-muted-foreground">
                        {asset.last_scan_at && (
                          <span className="flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{moment(asset.last_scan_at).fromNow()}</span>
                        )}
                        {asset.scan_error && (
                          <span className="break-words min-w-0" style={{ color: '#dd9a4a' }}>⚠ {asset.scan_error}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {/* Expandable detail panel */}
                <AssetDetailPanel
                  asset={asset}
                  states={assetStates}
                  statesUnavailable={statesUnavailable}
                  expanded={expandedId === asset.id}
                  onToggle={() => setExpandedId(expandedId === asset.id ? null : asset.id)}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Config Dialog */}
      <Dialog open={!!configAsset} onOpenChange={(open) => !open && setConfigAsset(null)}>
        <DialogContent style={{ background: 'rgba(21,20,18,0.97)', border: '1px solid rgba(255,255,255,0.08)' }} className="max-w-lg">
          <DialogHeader><DialogTitle className="font-mono">Config — {configAsset?.display_name}</DialogTitle></DialogHeader>
          {configAsset && <AssetConfigPanel asset={configAsset} onSave={() => { setConfigAsset(null); invalidateAssetLists(queryClient); }} />}
        </DialogContent>
      </Dialog>

      {/* Achado da varredura pós-Raio-X, Round 2 (2026-09-27): confirm()
          nativo quebrava o tema escuro — migrado pro AlertDialog já
          existente e nunca usado. Texto agora explica que sinais/operações
          desse ativo são preservados (o próprio deleteMutation acima só
          apaga MonitoredAsset + AssetState). */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover ativo?</AlertDialogTitle>
            <AlertDialogDescription>
              Remover {pendingDelete?.display_name}? Os sinais e operações já registrados para
              este ativo são preservados (histórico) — só o ativo monitorado é apagado, e essa
              ação não pode ser desfeita pela interface.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteMutation.mutate(pendingDelete.id)}>
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}