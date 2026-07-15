import React from 'react';
import { logError } from '@/lib/logger';

/**
 * Catches render-time errors so a broken component shows a reassuring
 * fallback instead of a blank white screen. Must be a class component —
 * React has no hook equivalent for getDerivedStateFromError/componentDidCatch.
 * Logged via the same logger.js queue everything else in the app uses, so a
 * crash shows up in the Debug Log button like any other event.
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    logError('errorBoundary', `Erro de renderização: ${error?.message || error}`, {
      stack: error?.stack?.slice(0, 500),
      componentStack: info?.componentStack?.slice(0, 500),
    });
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const { fullPage, title, message } = this.props;
      return (
        <div className={fullPage ? 'fixed inset-0 flex items-center justify-center bg-background p-6' : 'flex items-center justify-center p-10'}>
          <div className="max-w-sm text-center space-y-3">
            <div className="text-3xl">😕</div>
            <h2 className="text-sm font-medium">{title || 'Algo deu errado nesta tela'}</h2>
            <p className="text-xs text-muted-foreground">
              {message || 'Não se preocupe — nenhum dado foi perdido. Seus ativos monitorados, operações e histórico continuam salvos normalmente.'}
            </p>
            <button
              onClick={this.handleReload}
              className="mt-2 px-4 py-2 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90"
            >
              Recarregar {fullPage ? 'aplicativo' : 'página'}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
