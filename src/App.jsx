import { useEffect } from 'react'
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { initLogger } from '@/lib/logger'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';

import AppLayout from '@/components/layout/AppLayout';
import Dashboard from '@/pages/Dashboard';
import Assets from '@/pages/Assets';
import Alerts from '@/pages/Alerts';
import Logs from '@/pages/Logs';
import Trades from '@/pages/Trades';
import TradeHistory from '@/pages/TradeHistory';
import PineScript from '@/pages/PineScript';
import StrategyReviewer from '@/pages/StrategyReviewer';
import MonthlyReport from '@/pages/MonthlyReport';

const AuthenticatedApp = () => {
  const { isLoadingAuth } = useAuth();

  if (isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin"></div>
          <span className="text-xs text-muted-foreground font-mono">Carregando CryptoRadar...</span>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/assets" element={<Assets />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/trades" element={<Trades />} />
        <Route path="/history" element={<TradeHistory />} />
        <Route path="/pine" element={<PineScript />} />
        <Route path="/reviewer" element={<StrategyReviewer />} />
        <Route path="/monthly-report" element={<MonthlyReport />} />
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};

function App() {
  useEffect(() => { initLogger(); }, []);
  return (
    <ErrorBoundary fullPage title="O aplicativo encontrou um erro inesperado" message="Seus dados estão seguros no banco de dados — nada foi perdido. Isso foi só um problema ao mostrar a tela.">
      <AuthProvider>
        <QueryClientProvider client={queryClientInstance}>
          <Router>
            <AuthenticatedApp />
          </Router>
          <Toaster />
        </QueryClientProvider>
      </AuthProvider>
    </ErrorBoundary>
  )
}

export default App