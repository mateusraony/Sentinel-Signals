import React from 'react';
import { logError } from '@/lib/logger';
import { ErrorFallback } from '@/components/ErrorFallback';

/**
 * Catches render-time errors so a broken component shows a reassuring,
 * in-theme fallback instead of a blank white screen. Must be a class
 * component — React has no hook equivalent for
 * getDerivedStateFromError/componentDidCatch. Every catch is logged via the
 * same logger.js queue everything else in the app uses, so it shows up in
 * the Debug Log button like any other event — this fallback additionally
 * surfaces the same diagnostic on-screen with a one-click copy, so it's
 * trivial to paste into a Claude Code session for a fix.
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null, copied: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    logError('errorBoundary', `Erro de renderização: ${error?.message || error}`, {
      stack: error?.stack?.slice(0, 500),
      componentStack: info?.componentStack?.slice(0, 500),
      path: typeof window !== 'undefined' ? window.location.pathname : undefined,
    });
  }

  handleReload = () => {
    window.location.reload();
  };

  buildDiagnosticText() {
    const { error, info } = this.state;
    const lines = [
      '[Sentinel Signals — Diagnóstico de erro]',
      `Data: ${new Date().toISOString()}`,
      `Página: ${typeof window !== 'undefined' ? window.location.pathname : '(desconhecida)'}`,
      `Mensagem: ${error?.message || String(error)}`,
      '',
      'Stack:',
      error?.stack || '(indisponível)',
      '',
      'Component stack:',
      info?.componentStack?.trim() || '(indisponível)',
    ];
    return lines.join('\n');
  }

  handleCopyDiagnostic = async () => {
    try {
      await navigator.clipboard.writeText(this.buildDiagnosticText());
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2500);
    } catch {
      // Clipboard API unavailable/denied — nothing more we can do here.
    }
  };

  render() {
    if (this.state.hasError) {
      const { fullPage, title, message } = this.props;
      const { error, copied } = this.state;

      return (
        <ErrorFallback
          fullPage={fullPage}
          title={title}
          message={message}
          diagnosticText={error?.message || String(error)}
          diagnosticLabel="Diagnóstico (já registrado no Debug Log)"
          onReload={this.handleReload}
          onCopy={this.handleCopyDiagnostic}
          copied={copied}
        />
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
