import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Search, Coins, Bell } from 'lucide-react';

export default function GlobalSearch() {
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const navigate = useNavigate();
  const containerRef = useRef(null);

  const { data: allAssets = [] } = useQuery({
    queryKey: ['monitored-assets'],
    queryFn: () => base44.entities.MonitoredAsset.list(),
    staleTime: 60000,
  });

  const { data: allSignals = [] } = useQuery({
    queryKey: ['recent-signals'],
    queryFn: () => base44.entities.SignalEvent.list('-created_date', 50),
    staleTime: 15000,
  });

  const results = useMemo(() => {
    if (!search.trim()) return { assets: [], alerts: [] };
    const q = search.trim().toLowerCase();
    return {
      assets: allAssets.filter(a =>
        a.display_name?.toLowerCase().includes(q) || a.symbol?.toLowerCase().includes(q)
      ).slice(0, 5),
      alerts: allSignals.filter(s =>
        s.symbol?.toLowerCase().includes(q) ||
        s.reason?.toLowerCase().includes(q) ||
        s.signal_type?.toLowerCase().includes(q)
      ).slice(0, 5),
    };
  }, [search, allAssets, allSignals]);

  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelectAsset = (asset) => {
    navigate(`/assets?search=${asset.symbol}`);
    setSearch(''); setShowSearch(false); setShowDropdown(false);
  };

  const handleSelectAlert = () => {
    navigate('/alerts');
    setSearch(''); setShowSearch(false); setShowDropdown(false);
  };

  const hasResults = results.assets.length > 0 || results.alerts.length > 0;

  return (
    <div ref={containerRef} className="relative hidden sm:flex items-center">
      {showSearch ? (
        <>
          <input
            autoFocus
            value={search}
            onChange={e => { setSearch(e.target.value); setShowDropdown(true); }}
            onFocus={() => setShowDropdown(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && search.trim()) {
                if (results.assets.length > 0) handleSelectAsset(results.assets[0]);
                else if (results.alerts.length > 0) handleSelectAlert();
                else { navigate(`/assets?search=${search.trim().toUpperCase()}`); setSearch(''); setShowSearch(false); setShowDropdown(false); }
              }
              if (e.key === 'Escape') { setSearch(''); setShowSearch(false); setShowDropdown(false); }
            }}
            onBlur={() => { if (!search) setShowSearch(false); }}
            placeholder="Buscar ativo ou alerta..."
            className="h-8 w-52 font-mono text-xs rounded-lg px-3 outline-none"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(255,255,255,0.8)' }}
          />
          {showDropdown && search.trim() && hasResults && (
            <div className="absolute top-full mt-1.5 left-0 w-72 rounded-xl overflow-hidden z-50"
              style={{ background: 'rgba(10,13,22,0.98)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
              {results.assets.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 flex items-center gap-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <Coins className="w-3 h-3 text-muted-foreground" />
                    <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">Ativos</span>
                  </div>
                  {results.assets.map(a => (
                    <button key={a.id} onClick={() => handleSelectAsset(a)}
                      className="flex items-center justify-between w-full px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <span className="text-xs font-mono text-foreground">{a.display_name}</span>
                      <span className="text-[9px] font-mono text-muted-foreground">{a.symbol}</span>
                    </button>
                  ))}
                </div>
              )}
              {results.alerts.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 flex items-center gap-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <Bell className="w-3 h-3 text-muted-foreground" />
                    <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">Alertas</span>
                  </div>
                  {results.alerts.map(s => (
                    <button key={s.id} onClick={handleSelectAlert}
                      className="flex items-center justify-between w-full px-3 py-2 text-left transition-colors hover:bg-white/[0.04]">
                      <div className="min-w-0">
                        <span className="text-xs font-mono text-foreground">{s.symbol?.replace('USDT', '/USDT')}</span>
                        <span className="text-[9px] font-mono ml-1.5" style={{ color: s.signal_type === 'BUY' ? '#00ff80' : '#ff1478' }}>{s.signal_type}</span>
                      </div>
                      <span className="text-[9px] font-mono text-muted-foreground truncate ml-2">{s.timeframe?.toUpperCase()}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {showDropdown && search.trim() && !hasResults && (
            <div className="absolute top-full mt-1.5 left-0 w-72 rounded-xl overflow-hidden z-50"
              style={{ background: 'rgba(10,13,22,0.98)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <div className="px-3 py-3 text-center text-[10px] font-mono text-muted-foreground">Nenhum resultado</div>
            </div>
          )}
        </>
      ) : (
        <button onClick={() => setShowSearch(true)}
          className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[11px] font-mono transition-colors"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}>
          <Search className="w-3 h-3" />
          <span className="hidden md:block">Buscar ativo ou alerta...</span>
        </button>
      )}
    </div>
  );
}