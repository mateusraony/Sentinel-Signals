import React, { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Bell, Coins, TrendingUp, TrendingDown, Target, Clock, Search, ArrowUpDown, Swords } from 'lucide-react';
import AssetCard from '@/components/dashboard/AssetCard';
import RecentAlertsList from '@/components/dashboard/RecentAlertsList';
import StatsCard from '@/components/dashboard/StatsCard';
import PerformanceBar from '@/components/dashboard/PerformanceBar';
import AssetDrawer from '@/components/dashboard/AssetDrawer';
import SignalToast from '@/components/dashboard/SignalToast';
import SignalAlertBanner from '@/components/dashboard/SignalAlertBanner';
import PerformanceOverview from '@/components/dashboard/PerformanceOverview';
import ComparePanel from '@/components/dashboard/ComparePanel';
import TelegramStatusBanner from '@/components/dashboard/TelegramStatusBanner';
import PerformanceMetricsBar from '@/components/dashboard/PerformanceMetricsBar';
import { useBrowserNotifications } from '@/hooks/useBrowserNotifications';

const ACTIVE_STATUSES = ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'];

export default function Dashboard() {
  const [filterSignal, setFilterSignal] = useState('all');
  const [filterTf, setFilterTf] = useState('all');
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('default'); // 'default' | 'score' | 'priority'
  const [compareMode, setCompareMode] = useState(false);
  const [compareAId, setCompareAId] = useState(null);
  const [compareBId, setCompareBId] = useState(null);

  // Reset filters on global event
  useEffect(() => {
    const handler = () => { setSearch(''); setFilterSignal('all'); setFilterTf('all'); setSortBy('default'); };
    window.addEventListener('app-reset-filters', handler);
    return () => window.removeEventListener('app-reset-filters', handler);
  }, []);

  const { data: assets = [], isLoading: loadingAssets } = useQuery({
    queryKey: ['monitored-assets'],
    queryFn: () => base44.entities.MonitoredAsset.filter({ is_active: true }),
    refetchInterval: 20000,
  });

  const { data: states = [] } = useQuery({
    queryKey: ['asset-states'],
    queryFn: () => base44.entities.AssetState.list(),
    refetchInterval: 15000,
  });

  const { data: recentSignals = [] } = useQuery({
    queryKey: ['recent-signals'],
    queryFn: () => base44.entities.SignalEvent.list('-created_date', 50),
    refetchInterval: 10000,
  });

  const { data: tradeOps = [] } = useQuery({
    queryKey: ['trade-operations-dashboard'],
    queryFn: () => base44.entities.TradeOperation.list('-created_date', 100),
    refetchInterval: 10000,
  });

  // Browser + in-app notifications
  useBrowserNotifications(recentSignals);

  // Alta prioridade: sinais RF com prioridade high OU operações ativas com score >= 85
  const highPriorityCount = new Set([
    ...recentSignals.filter(s => s.priority === 'high' && s.source === 'range_filter').map(s => s.asset_id),
    ...tradeOps.filter(o => o.score >= 85 && ACTIVE_STATUSES.includes(o.status)).map(o => o.asset_id),
  ]).size;
  const buySignals = recentSignals.filter(s => s.signal_type === 'BUY' && s.source === 'range_filter').length;
  const sellSignals = recentSignals.filter(s => s.signal_type === 'SELL' && s.source === 'range_filter').length;
  const activeOpsCount = tradeOps.filter(o => ACTIVE_STATUSES.includes(o.status)).length;
  const assetsWithSignal = new Set(recentSignals.filter(s => s.source === 'range_filter').map(s => s.asset_id));
  const assetsWithActiveTrade = new Set(tradeOps.filter(o => ACTIVE_STATUSES.includes(o.status)).map(o => o.asset_id));
  const waitingCount = [...assetsWithSignal].filter(id => !assetsWithActiveTrade.has(id)).length;

  // Build filtered + sorted assets
  const displayAssets = useMemo(() => {
    let list = assets.filter(asset => {
      // Search filter
      if (search) {
        const q = search.toLowerCase();
        const name = (asset.display_name || asset.symbol || '').toLowerCase();
        if (!name.includes(q)) return false;
      }
      // Timeframe filter
      if (filterTf !== 'all') {
        const hasState = states.some(s => s.asset_id === asset.id && s.timeframe === filterTf);
        if (!hasState) return false;
      }
      // Signal filter
      if (filterSignal !== 'all') {
        const sig = recentSignals.find(s => s.asset_id === asset.id && s.source === 'range_filter');
        const op = tradeOps.find(o => o.asset_id === asset.id && ACTIVE_STATUSES.includes(o.status));
        if (filterSignal === 'high') return sig?.priority === 'high' || (op?.score >= 85);
        const side = op?.side || sig?.signal_type;
        return side === filterSignal;
      }
      return true;
    });

    // Sort
    if (sortBy === 'score') {
      list = [...list].sort((a, b) => {
        const scoreA = tradeOps.find(o => o.asset_id === a.id)?.score
          || recentSignals.find(s => s.asset_id === a.id)?.context?.score || 0;
        const scoreB = tradeOps.find(o => o.asset_id === b.id)?.score
          || recentSignals.find(s => s.asset_id === b.id)?.context?.score || 0;
        return scoreB - scoreA;
      });
    } else if (sortBy === 'priority') {
      const P = { high: 0, medium: 1, low: 2, undefined: 3 };
      list = [...list].sort((a, b) => {
        const pa = recentSignals.find(s => s.asset_id === a.id)?.priority;
        const pb = recentSignals.find(s => s.asset_id === b.id)?.priority;
        return (P[pa] ?? 3) - (P[pb] ?? 3);
      });
    }

    return list;
  }, [assets, recentSignals, tradeOps, states, filterSignal, filterTf, search, sortBy]);

  const compareA = assets.find(a => a.id === compareAId);
  const compareB = assets.find(a => a.id === compareBId);

  const SORT_OPTS = [
    { id: 'default', label: 'Padrão' },
    { id: 'score', label: 'Score ↓' },
    { id: 'priority', label: 'Prioridade ↓' },
  ];

  return (
    <>
      <SignalToast signals={recentSignals} />

      {selectedAsset && (
        <AssetDrawer
          asset={selectedAsset}
          signals={recentSignals}
          tradeOps={tradeOps}
          onClose={() => setSelectedAsset(null)}
        />
      )}

      <div className="space-y-5 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between">
          <div>
            <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Sistema de Monitoramento</p>
            <h1 className="text-3xl font-bold text-foreground tracking-tight">Dashboard</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
              <div className="live-dot" style={{ width: 6, height: 6 }} />
              <span>Dados em tempo real</span>
            </div>
            <button onClick={() => {
              if (!compareMode && assets.length >= 2) {
                setCompareAId(assets[0].id);
                setCompareBId(assets[1].id);
              }
              setCompareMode(!compareMode);
            }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono transition-all hover:opacity-80"
              style={compareMode
                ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }
                : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
              <Swords className="w-3 h-3" />
              {compareMode ? 'Sair' : 'Comparar'}
            </button>
          </div>
        </div>

        {/* Signal alert banner */}
        <SignalAlertBanner signals={recentSignals} />

        {/* Telegram status */}
        <TelegramStatusBanner />

        {/* Compare mode */}
        {compareMode && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <select value={compareAId || ''} onChange={e => setCompareAId(e.target.value)}
                className="px-3 py-2 rounded-lg text-[11px] font-mono outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(0,229,255,0.2)', color: 'rgba(255,255,255,0.8)' }}>
                <option value="">Selecione Ativo A...</option>
                {assets.map(a => <option key={a.id} value={a.id}>{a.display_name}</option>)}
              </select>
              <span className="text-muted-foreground text-xs font-mono">vs</span>
              <select value={compareBId || ''} onChange={e => setCompareBId(e.target.value)}
                className="px-3 py-2 rounded-lg text-[11px] font-mono outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(0,229,255,0.2)', color: 'rgba(255,255,255,0.8)' }}>
                <option value="">Selecione Ativo B...</option>
                {assets.map(a => <option key={a.id} value={a.id}>{a.display_name}</option>)}
              </select>
            </div>
            {compareA && compareB && (
              <ComparePanel
                assetA={compareA}
                assetB={compareB}
                statesA={states.filter(s => s.asset_id === compareA.id)}
                statesB={states.filter(s => s.asset_id === compareB.id)}
                signalA={recentSignals.find(s => s.asset_id === compareA.id && s.source === 'range_filter')}
                signalB={recentSignals.find(s => s.asset_id === compareB.id && s.source === 'range_filter')}
                opA={tradeOps.find(o => o.asset_id === compareA.id && ACTIVE_STATUSES.includes(o.status))}
                opB={tradeOps.find(o => o.asset_id === compareB.id && ACTIVE_STATUSES.includes(o.status))}
              />
            )}
          </div>
        )}

        {/* Real performance metrics */}
        <PerformanceMetricsBar tradeOps={tradeOps} />

        {/* Performance bar */}
        <PerformanceBar assets={assets} tradeOps={tradeOps} recentSignals={recentSignals} />

        {/* Consolidated performance chart — appears only when there's history */}
        <PerformanceOverview tradeOps={tradeOps} />

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <StatsCard icon={Coins} label="Monitorados" value={assets.length} color="#00e5ff" glowColor="rgba(0,229,255,0.1)" />
          <StatsCard icon={Bell} label="Alta Prioridade" value={highPriorityCount} color="#ff1478" glowColor="rgba(255,20,120,0.1)" />
          <StatsCard icon={Target} label="Operações Ativas" value={activeOpsCount} color="#00ff80" glowColor="rgba(0,255,128,0.1)" />
          <StatsCard icon={Clock} label="Aguardando" value={waitingCount} color="#ffd166" glowColor="rgba(255,209,102,0.1)" />
          <StatsCard icon={TrendingUp} label="Sinais BUY" value={buySignals} color="#00ff80" glowColor="rgba(0,255,128,0.1)" />
          <StatsCard icon={TrendingDown} label="Sinais SELL" value={sellSignals} color="#ff1478" glowColor="rgba(255,20,120,0.1)" />
        </div>

        {/* Assets */}
        <div>
          {/* Search + filters + sort */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
            {/* Search */}
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                placeholder="Buscar ativo..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-7 pr-3 py-1.5 rounded-lg text-[10px] font-mono outline-none transition-all"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'rgba(255,255,255,0.75)',
                }}
              />
            </div>

            {/* Signal filters */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {[
                { id: 'all', label: 'Todos', color: '#00e5ff' },
                { id: 'BUY', label: '↑ BUY', color: '#00ff80' },
                { id: 'SELL', label: '↓ SELL', color: '#ff1478' },
                { id: 'high', label: '★ Alta Prio', color: '#ffd166' },
              ].map(f => (
                <button key={f.id} onClick={() => setFilterSignal(f.id)}
                  className="text-[9px] font-mono px-2 py-1 rounded-md transition-all"
                  style={filterSignal === f.id
                    ? { background: `${f.color}18`, border: `1px solid ${f.color}50`, color: f.color }
                    : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)' }}>
                  {f.label}
                </button>
              ))}

              {/* Timeframe filter */}
              <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(255,255,255,0.08)' }} />
              {['all', '1h', '4h', '1d'].map(tf => (
                <button key={tf} onClick={() => setFilterTf(tf)}
                  className="text-[9px] font-mono px-2 py-1 rounded-md transition-all"
                  style={filterTf === tf
                    ? { background: 'rgba(0,229,255,0.15)', border: '1px solid rgba(0,229,255,0.4)', color: '#00e5ff' }
                    : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)' }}>
                  {tf === 'all' ? 'TF All' : tf.toUpperCase()}
                </button>
              ))}
            </div>

            {/* Sort */}
            <div className="flex items-center gap-1 ml-auto">
              <ArrowUpDown className="w-3 h-3 text-muted-foreground shrink-0" />
              <div className="flex items-center gap-1">
                {SORT_OPTS.map(s => (
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
          </div>

          {/* Count label */}
          <div className="flex items-center gap-2 mb-2">
            <Coins className="w-3.5 h-3.5" style={{ color: '#00e5ff' }} />
            <h2 className="text-sm font-bold text-foreground tracking-tight">Ativos</h2>
            <span className="text-[9px] font-mono text-muted-foreground">({displayAssets.length})</span>
          </div>

          {loadingAssets ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {[1,2,3].map(i => <div key={i} className="glass-card rounded-xl h-52 shimmer" />)}
            </div>
          ) : assets.length === 0 ? (
            <div className="glass-card rounded-xl p-12 text-center">
              <Coins className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-20" />
              <p className="text-muted-foreground text-sm">Nenhum ativo monitorado.</p>
              <p className="text-xs text-muted-foreground mt-1">Vá em "Ativos" para adicionar pares.</p>
            </div>
          ) : displayAssets.length === 0 ? (
            <div className="glass-card rounded-xl p-8 text-center">
              <p className="text-muted-foreground text-sm">Nenhum ativo encontrado.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {displayAssets.map(asset => {
                const assetStates = states.filter(s => s.asset_id === asset.id);
                const latestSignal = recentSignals.find(s => s.asset_id === asset.id && s.source === 'range_filter');
                const activeOp = tradeOps.find(o => o.asset_id === asset.id && ACTIVE_STATUSES.includes(o.status));
                return (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    states={assetStates}
                    latestSignal={latestSignal}
                    tradeOp={activeOp}
                    onClick={() => setSelectedAsset(asset)}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Alerts */}
        <RecentAlertsList signals={recentSignals} />
      </div>
    </>
  );
}