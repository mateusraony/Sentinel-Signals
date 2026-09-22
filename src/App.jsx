import { useEffect, Suspense } from 'react'
import { Toaster } from "@/components/ui/toaster"
import { TooltipProvider } from "@/components/ui/tooltip"
import { QueryClientProvider } from '@tanstack/react-query'
import { initLogger } from '@/lib/logger'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { lazyWithReload } from '@/lib/lazyWithReload';

import AppLayout from '@/components/layout/AppLayout';
// docs/roadmap.md Bloco 5 (bundle >500kB) — cada página vira seu próprio
// chunk, baixado só quando a rota é visitada, em vez de tudo cair no chunk
// principal. AppLayout fica estático (é o shell, sempre necessário). O
// fallback do Suspense reusa o mesmo spinner de tela cheia que já existia
// para o carregamento de auth, abaixo — nenhuma UI nova.
//
// lazyWithReload (não React.lazy puro) — docs/known-risks.md item 184
// addendum: uma aba aberta desde antes de um deploy novo tenta buscar um
// chunk cujo nome de arquivo já não existe mais no servidor ("Failed to
// fetch dynamically imported module") e fica presa nesse erro para sempre,
// já que a aba não recarrega sozinha. Recarrega uma vez automaticamente
// nesse caso específico; qualquer outra falha continua propagando pro
// ErrorBoundary normalmente.
const Dashboard = lazyWithReload(() => import('@/pages/Dashboard'));
const Assets = lazyWithReload(() => import('@/pages/Assets'));
const Alerts = lazyWithReload(() => import('@/pages/Alerts'));
const Logs = lazyWithReload(() => import('@/pages/Logs'));
const Trades = lazyWithReload(() => import('@/pages/Trades'));
const TradeHistory = lazyWithReload(() => import('@/pages/TradeHistory'));
const PineScript = lazyWithReload(() => import('@/pages/PineScript'));
const StrategyReviewer = lazyWithReload(() => import('@/pages/StrategyReviewer'));
const MonthlyReport = lazyWithReload(() => import('@/pages/MonthlyReport'));
const Settings = lazyWithReload(() => import('@/pages/Settings'));
const Backtest = lazyWithReload(() => import('@/pages/Backtest'));
const Verification = lazyWithReload(() => import('@/pages/Verification'));

const PageLoadingFallback = () => (
  <div className="fixed inset-0 flex items-center justify-center bg-background">
    <div className="flex flex-col items-center gap-3">
      <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin"></div>
      <span className="text-xs text-muted-foreground font-mono">Carregando CryptoRadar...</span>
    </div>
  </div>
);

const AuthenticatedApp = () => {
  const { isLoadingAuth } = useAuth();

  if (isLoadingAuth) {
    return <PageLoadingFallback />;
  }

  return (
    <Suspense fallback={<PageLoadingFallback />}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/assets" element={<Assets />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/trades" element={<Trades />} />
          <Route path="/history" element={<TradeHistory />} />
          <Route path="/verification" element={<Verification />} />
          <Route path="/pine" element={<PineScript />} />
          <Route path="/reviewer" element={<StrategyReviewer />} />
          <Route path="/monthly-report" element={<MonthlyReport />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/backtest" element={<Backtest />} />
        </Route>
        <Route path="*" element={<PageNotFound />} />
      </Routes>
    </Suspense>
  );
};

function App() {
  useEffect(() => { initLogger(); }, []);
  return (
    <ErrorBoundary fullPage title="O aplicativo encontrou um erro inesperado" message="Seus dados estão seguros no banco de dados — nada foi perdido. Isso foi só um problema ao mostrar a tela.">
      <AuthProvider>
        <QueryClientProvider client={queryClientInstance}>
          <TooltipProvider>
            <Router>
              <AuthenticatedApp />
            </Router>
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </AuthProvider>
    </ErrorBoundary>
  )
}

export default App