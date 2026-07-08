import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Plus, Trash2, Loader2, CheckCircle2, XCircle, Settings2, Coins, Clock, Activity, Search, ChevronDown, ChevronUp, TrendingUp, Crosshair } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import AddAssetForm from '@/components/assets/AddAssetForm';
import AssetConfigPanel from '@/components/assets/AssetConfigPanel';
import AssetDetailPanel from '@/components/assets/AssetDetailPanel';
import { calcProximity } from '@/components/dashboard/ProximityBar';
import moment from 'moment';

export default function Assets() {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [configAsset, setConfigAsset] = useState(null);
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

  const { data: assets = [], isLoading } = useQuery({
    queryKey: ['all-assets'],
    queryFn: () => backend.entities.MonitoredAsset.list('-created_date'),
    refetchInterval: 30000,
  });

  const { data: states = [] } = useQuery({
    queryKey: ['asset-states'],
    queryFn: () => backend.entities.AssetState.list(),
    refetchInterval: 20000,
  });

  const { data: recentSignals = [] } = useQuery({
    queryKey: ['recent-signals'],
    queryFn: () => backend.entities.SignalEvent.list('-created_date', 100),
    refetchInterval: 20000,
  });

  const { data: tradeOps = [] } = useQuery({
    queryKey: ['trade-operations-assets'],
    queryFn: () => backend.entities.TradeOperation.list('-created_date', 100),
    refetchInterval: 20000,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_active }) => backend.entities.MonitoredAsset.update(id, { is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['all-assets'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => backend.entities.MonitoredAsset.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['all-assets'] }),
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

  const assetsNearEntry = useMemo(() => {
    const nearSet = new Set();
    for (const a of assets) {
      if (!a.is_active) continue;
      const aStates = states.filter(s => s.asset_id === a.id);
      for (const s of aStates) {
        if (calcProximity(s)) { nearSet.add(a.id); break; }
      }
    }
    return nearSet;
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
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Configuração</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Ativos</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
            <div className="live-dot" style={{ width: 5, height: 5 }} />
            <span>{active.length} ativos monitorados</span>
          </div>
          <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
            <DialogTrigger asChild>
              <Button size="sm" className="font-mono text-xs h-8 px-4"
                style={{ background: 'linear-gradient(135deg,rgba(0,255,128,0.15),rgba(0,200,255,0.1))', border: '1px solid rgba(0,255,128,0.35)', color: '#00ff80', boxShadow: '0 0 16px rgba(0,255,128,0.1)' }}>
                <Plus className="w-3.5 h-3.5 mr-2" />Adicionar
              </Button>
            </DialogTrigger>
            <DialogContent style={{ background: 'rgba(14,17,28,0.97)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(24px)' }}>
              <DialogHeader><DialogTitle className="font-mono">Adicionar Ativo</DialogTitle></DialogHeader>
              <AddAssetForm onSuccess={() => { setShowAddDialog(false); queryClient.invalidateQueries({ queryKey: ['all-assets'] }); }} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total', value: assets.length, color: '#00e5ff', icon: Coins },
          { label: 'Ativos', value: active.length, color: '#00ff80', icon: Activity },
          { label: 'Inativos', value: inactive.length, color: '#64748b', icon: XCircle },
          { label: 'Erros', value: assets.filter(a => a.scan_status === 'error').length, color: '#ff1478', icon: XCircle },
        ].map(({ label, value, color, icon: Icon }) => (
          <div key={label} className="rounded-xl px-4 py-3 flex items-center gap-3"
            style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Icon className="w-4 h-4 shrink-0" style={{ color }} />
            <div>
              <div className="text-[9px] font-mono text-muted-foreground">{label}</div>
              <div className="text-xl font-bold font-mono" style={{ color }}>{value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Search + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
          <input type="text" placeholder="Buscar ativo..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-7 pr-3 py-1.5 rounded-lg text-[10px] font-mono outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.75)' }} />
        </div>
        {[{ id: 'all', label: 'Todos' }, { id: 'active', label: '● Ativos' }, { id: 'inactive', label: '○ Inativos' },
          { id: 'signals', label: '⚡ Sinais' },
          { id: 'proximity', label: '🎯 Próximos' },
        ].map(f => (
          <button key={f.id} onClick={() => setFilterStatus(f.id)}
            className="text-[9px] font-mono px-2 py-1.5 rounded-lg transition-all flex items-center gap-1"
            style={filterStatus === f.id
              ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }
              : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
            {f.id === 'signals' && <TrendingUp className="w-3 h-3" />}
            {f.id === 'proximity' && <Crosshair className="w-3 h-3" />}
            {f.label}
          </button>
        ))}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl p-12 text-center" style={{ background: 'rgba(10,13,22,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <Coins className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
          <p className="text-muted-foreground text-sm mb-4">{assets.length === 0 ? 'Nenhum ativo cadastrado.' : 'Nenhum ativo encontrado.'}</p>
          {assets.length === 0 && (
            <Button size="sm" onClick={() => setShowAddDialog(true)}
              style={{ background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }}>
              <Plus className="w-3.5 h-3.5 mr-2" />Adicionar primeiro ativo
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(asset => {
            const assetStates = states.filter(s => s.asset_id === asset.id);
            const lastScanMs = asset.last_scan_at ? Date.now() - new Date(asset.last_scan_at).getTime() : null;
            const isStale = lastScanMs && lastScanMs > 2 * 60 * 60 * 1000;
            const liveColor = isStale ? '#ff9f43' : asset.is_active ? '#00ff80' : '#64748b';
            const liveLabel = isStale ? 'STALE' : asset.is_active ? 'LIVE' : 'OFF';

            return (
              <div key={asset.id}
                className="rounded-xl px-4 py-3.5 transition-all duration-300 group hover:scale-[1.005]"
                style={{ background: 'rgba(10,13,22,0.82)', backdropFilter: 'blur(20px)', border: asset.is_active ? '1px solid rgba(0,255,128,0.1)' : '1px solid rgba(255,255,255,0.05)' }}>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-4 min-w-0 flex-1">
                    <Switch checked={asset.is_active} onCheckedChange={(checked) => toggleMutation.mutate({ id: asset.id, is_active: checked })} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-foreground">{asset.display_name}</span>
                        <span className="text-[9px] font-mono text-muted-foreground">{asset.symbol}</span>
                        <span className="text-[8px] font-mono px-1.5 py-0.5 rounded uppercase tracking-widest"
                          style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.15)', color: 'rgba(0,229,255,0.7)' }}>
                          {asset.exchange || 'binance'}
                        </span>
                        <span className="flex items-center gap-0.5">
                          <span style={{ width: 5, height: 5, borderRadius: '50%', display: 'inline-block', background: liveColor, boxShadow: asset.is_active && !isStale ? `0 0 5px ${liveColor}` : 'none' }} />
                          <span className="text-[8px] font-mono" style={{ color: liveColor }}>{liveLabel}</span>
                        </span>
                        {asset.scan_status === 'error' && <XCircle className="w-3 h-3 text-rose-400" />}
                        {asset.scan_status === 'success' && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                      </div>

                      {/* TF pills + scan time */}
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {['1h', '4h', '1d'].map(tf => {
                          const tfState = assetStates.find(s => s.timeframe === tf);
                          const enabled = asset.timeframes_enabled?.[tf] !== false;
                          const rfDir = tfState?.rf_direction;
                          const dirColor = rfDir === 1 ? '#00ff80' : rfDir === -1 ? '#ff1478' : null;
                          return (
                            <span key={tf} className="text-[8px] font-mono px-1.5 py-0.5 rounded flex items-center gap-0.5"
                              style={enabled
                                ? { background: 'rgba(0,255,128,0.06)', border: '1px solid rgba(0,255,128,0.18)', color: 'rgba(0,255,128,0.7)' }
                                : { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.18)' }}>
                              {tf}
                              {dirColor && <span style={{ color: dirColor }}>{rfDir === 1 ? '▲' : '▼'}</span>}
                            </span>
                          );
                        })}
                        {asset.last_scan_at && (
                          <span className="text-[8px] font-mono text-muted-foreground flex items-center gap-0.5">
                            <Clock className="w-2 h-2" />{moment(asset.last_scan_at).fromNow()}
                          </span>
                        )}
                        {asset.scan_error && (
                          <span className="text-[8px] font-mono truncate max-w-xs" style={{ color: '#ff9f43' }}>⚠ {asset.scan_error}</span>
                        )}
                      </div>

                      {/* Per-TF indicators mini row */}
                      {assetStates.length > 0 && (
                        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                          {assetStates.map(s => (
                            <div key={s.timeframe} className="flex items-center gap-1 text-[7px] font-mono">
                              <span style={{ color: 'rgba(255,255,255,0.25)' }}>{s.timeframe?.toUpperCase()}</span>
                              {s.rsi_value && <span style={{ color: s.rsi_zone === 'overbought' ? '#ff1478' : s.rsi_zone === 'oversold' ? '#00ff80' : '#64748b' }}>RSI {s.rsi_value.toFixed(0)}</span>}
                              {s.macd_histogram !== undefined && <span style={{ color: s.macd_histogram > 0 ? '#00ff80' : '#ff1478' }}>MACD{s.macd_histogram > 0 ? '▲' : '▼'}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      className="flex items-center gap-1 px-2.5 py-2 rounded-lg text-[10px] font-mono font-semibold transition-all hover:opacity-80"
                      style={expandedId === asset.id
                        ? { background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }
                        : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}
                      onClick={() => setExpandedId(expandedId === asset.id ? null : asset.id)}>
                      {expandedId === asset.id ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      className="flex items-center gap-1 px-3 py-2 rounded-lg text-[10px] font-mono font-semibold transition-all hover:opacity-80"
                      style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}
                      onClick={() => setConfigAsset(asset)}>
                      <Settings2 className="w-3.5 h-3.5" /><span className="hidden sm:inline">Config</span>
                    </button>
                    <button
                      className="flex items-center gap-1 px-3 py-2 rounded-lg text-[10px] font-mono font-semibold transition-all hover:opacity-80"
                      style={{ background: 'rgba(255,20,120,0.08)', border: '1px solid rgba(255,20,120,0.2)', color: '#ff1478' }}
                      onClick={() => { if (confirm(`Remover ${asset.display_name}?`)) deleteMutation.mutate(asset.id); }}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {/* Expandable detail panel */}
                <AssetDetailPanel
                  asset={asset}
                  states={assetStates}
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
        <DialogContent style={{ background: 'rgba(14,17,28,0.97)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(24px)' }} className="max-w-lg">
          <DialogHeader><DialogTitle className="font-mono">Config — {configAsset?.display_name}</DialogTitle></DialogHeader>
          {configAsset && <AssetConfigPanel asset={configAsset} onSave={() => { setConfigAsset(null); queryClient.invalidateQueries({ queryKey: ['all-assets'] }); }} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}