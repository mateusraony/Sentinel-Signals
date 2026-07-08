import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import TickerBar from './TickerBar';
import AuroraBg from './AuroraBg';
import DebugLogButton from './DebugLogButton';
import { useAutoScan } from '@/hooks/useAutoScan';
import { useQueryClient } from '@tanstack/react-query';

function AutoScanRunner() {
  const queryClient = useQueryClient();
  useAutoScan({ queryClient });
  return null;
}

export default function AppLayout() {
  return (
    <div className="min-h-screen bg-background relative">
      <AuroraBg />
      <AutoScanRunner />
      <div className="relative z-10">
        <Sidebar />
        {/* Desktop: left padding for sidebar. Mobile: bottom padding for bottom nav */}
        <div className="md:pl-14 pb-16 md:pb-0">
          <TickerBar />
          <TopBar />
          <main className="p-4 lg:p-6">
            <Outlet />
          </main>
        </div>
      </div>
      <DebugLogButton />
    </div>
  );
}