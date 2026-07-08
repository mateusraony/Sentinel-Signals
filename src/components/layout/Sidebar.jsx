import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Coins, Bell, ScrollText, Zap, Target, BookOpen, Code2, Bot, FileText, Trash2, FilterX, Loader2, ArrowLeftRight } from 'lucide-react';
import { backend } from '@/api/entities';

const NAV_ITEMS = [
  { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/trades', icon: Target, label: 'Trades' },
  { path: '/history', icon: BookOpen, label: 'Histórico' },
  { path: '/assets', icon: Coins, label: 'Ativos' },
  { path: '/alerts', icon: Bell, label: 'Alertas' },
  { path: '/logs', icon: ScrollText, label: 'Logs' },
  { path: '/pine', icon: Code2, label: 'Pine Script' },
  { path: '/reviewer', icon: Bot, label: 'Revisor' },
  { path: '/monthly-report', icon: FileText, label: 'Relatório' },
];

// Desktop sidebar (icon-only, left)
function DesktopSidebar() {
  const location = useLocation();
  const [hovered, setHovered] = useState(null);

  return (
    <aside
      className="hidden md:flex fixed left-0 top-0 h-full w-14 flex-col items-center z-40"
      style={{
        background: 'rgba(6, 8, 15, 0.75)',
        backdropFilter: 'blur(20px)',
        borderRight: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      {/* Logo */}
      <div className="w-full flex justify-center py-4 mb-2">
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, rgba(0,255,128,0.18), rgba(0,180,255,0.08))',
            border: '1px solid rgba(0,255,128,0.22)',
            boxShadow: '0 0 16px rgba(0,255,128,0.12)',
          }}
        >
          <Zap className="w-3.5 h-3.5" style={{ color: '#00ff80' }} />
        </div>
      </div>

      <div className="w-6 mb-3" style={{ height: 1, background: 'rgba(255,255,255,0.05)' }} />

      <nav className="flex flex-col items-center gap-1 flex-1 w-full px-2">
        {NAV_ITEMS.map(item => {
          const isActive = location.pathname === item.path;
          return (
            <div key={item.path} className="relative w-full group">
              <Link
                to={item.path}
                className="flex items-center justify-center w-full h-10 rounded-lg transition-all duration-200 relative"
                style={{
                  background: isActive ? 'rgba(0,255,128,0.07)' : hovered === item.path ? 'rgba(255,255,255,0.04)' : 'transparent',
                  border: isActive ? '1px solid rgba(0,255,128,0.15)' : '1px solid transparent',
                }}
                onMouseEnter={() => setHovered(item.path)}
                onMouseLeave={() => setHovered(null)}
              >
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r-full"
                    style={{ width: 2, height: 18, background: '#00ff80', boxShadow: '0 0 8px rgba(0,255,128,0.7)' }}
                  />
                )}
                <item.icon
                  className="w-[18px] h-[18px]"
                  style={{
                    color: isActive ? '#00ff80' : hovered === item.path ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.28)',
                    filter: isActive ? 'drop-shadow(0 0 5px rgba(0,255,128,0.55))' : 'none',
                    transition: 'color 0.18s, filter 0.18s',
                  }}
                />
              </Link>
              {/* Tooltip */}
              <span className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-md text-xs font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50"
                style={{ background: 'rgba(10,13,24,0.95)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.75)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}
              >{item.label}</span>
            </div>
          );
        })}
      </nav>

      {/* Quick Actions */}
      <div className="flex flex-col gap-1 w-full px-2 pb-2">
        <div className="w-6 mb-1" style={{ height: 1, background: 'rgba(255,255,255,0.05)' }} />
        <QuickToggleButton />
        <QuickActionButton title="Redefinir Filtros" onClick={() => window.dispatchEvent(new CustomEvent('app-reset-filters'))}>
          <FilterX className="w-[18px] h-[18px]" />
        </QuickActionButton>
        <ClearLogsButton />
      </div>

      {/* Live dot */}
      <div className="pb-4">
        <div className="relative flex items-center justify-center" style={{ width: 6, height: 6 }}>
          <span className="block rounded-full" style={{ width: 6, height: 6, background: '#00ff80', boxShadow: '0 0 6px #00ff80' }} />
          <span className="absolute inset-0 rounded-full" style={{ background: 'rgba(0,255,128,0.3)', animation: 'ping 1.8s ease-in-out infinite' }} />
        </div>
      </div>
    </aside>
  );
}

function QuickToggleButton() {
  const location = useLocation();
  const navigate = useNavigate();
  const isDashboard = location.pathname === '/';
  const target = isDashboard ? '/trades' : '/';
  const label = isDashboard ? 'Trades' : 'Dashboard';
  return (
    <div className="relative w-full group">
      <button
        onClick={() => navigate(target)}
        className="flex items-center justify-center w-full h-10 rounded-lg transition-all duration-200"
        style={{ background: 'rgba(0,229,255,0.06)', border: '1px solid rgba(0,229,255,0.12)' }}
      >
        <ArrowLeftRight className="w-[18px] h-[18px]" style={{ color: '#00e5ff' }} />
      </button>
      <span className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-md text-xs font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50"
        style={{ background: 'rgba(10,13,24,0.95)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.75)' }}>
        Ir para {label}
      </span>
    </div>
  );
}

function QuickActionButton({ title, onClick, children }) {
  return (
    <div className="relative w-full group">
      <button
        onClick={onClick}
        className="flex items-center justify-center w-full h-10 rounded-lg transition-all duration-200"
        style={{ background: 'transparent', border: '1px solid transparent' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.border = '1px solid rgba(255,255,255,0.06)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.border = '1px solid transparent'; }}
      >
        <span style={{ color: 'rgba(255,255,255,0.28)' }}>{children}</span>
      </button>
      <span className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-md text-xs font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50"
        style={{ background: 'rgba(10,13,24,0.95)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.75)' }}>
        {title}
      </span>
    </div>
  );
}

function ClearLogsButton() {
  const [clearing, setClearing] = useState(false);
  const handleClear = async () => {
    if (!window.confirm('Limpar TODOS os logs do sistema?')) return;
    setClearing(true);
    try {
      await backend.entities.SystemLog.deleteMany({});
    } catch (e) {
      console.error('Clear logs error:', e);
    } finally {
      setClearing(false);
    }
  };
  return (
    <div className="relative w-full group">
      <button
        onClick={handleClear}
        disabled={clearing}
        className="flex items-center justify-center w-full h-10 rounded-lg transition-all duration-200"
        style={{ background: 'transparent', border: '1px solid transparent' }}
        onMouseEnter={(e) => { if (!clearing) { e.currentTarget.style.background = 'rgba(255,159,67,0.06)'; e.currentTarget.style.border = '1px solid rgba(255,159,67,0.12)'; } }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.border = '1px solid transparent'; }}
      >
        {clearing
          ? <Loader2 className="w-[18px] h-[18px] animate-spin" style={{ color: '#ff9f43' }} />
          : <Trash2 className="w-[18px] h-[18px]" style={{ color: 'rgba(255,255,255,0.28)' }} />}
      </button>
      <span className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-md text-xs font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50"
        style={{ background: 'rgba(10,13,24,0.95)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.75)' }}>
        Limpar Logs
      </span>
    </div>
  );
}

// Mobile bottom nav
function MobileBottomNav() {
  const location = useLocation();

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around h-16"
      style={{
        background: 'rgba(6, 8, 15, 0.92)',
        backdropFilter: 'blur(24px)',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {NAV_ITEMS.map(item => {
        const isActive = location.pathname === item.path;
        return (
          <Link
            key={item.path}
            to={item.path}
            className="flex flex-col items-center justify-center gap-1 flex-1 h-full transition-all duration-200 relative"
          >
            {isActive && (
              <span
                className="absolute top-0 left-1/2 -translate-x-1/2 rounded-b-full"
                style={{ width: 24, height: 2, background: '#00ff80', boxShadow: '0 0 8px rgba(0,255,128,0.8)' }}
              />
            )}
            <item.icon
              className="w-5 h-5"
              style={{
                color: isActive ? '#00ff80' : 'rgba(255,255,255,0.25)',
                filter: isActive ? 'drop-shadow(0 0 5px rgba(0,255,128,0.6))' : 'none',
                transition: 'color 0.18s, filter 0.18s',
              }}
            />
            <span
              className="text-[10px] font-mono"
              style={{ color: isActive ? 'rgba(0,255,128,0.85)' : 'rgba(255,255,255,0.22)' }}
            >{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export default function Sidebar() {
  return (
    <>
      <DesktopSidebar />
      <MobileBottomNav />
    </>
  );
}