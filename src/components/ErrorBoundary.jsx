import React from 'react';
import { Radar, RefreshCw, Copy, Check, AlertTriangle } from 'lucide-react';
import { logError } from '@/lib/logger';

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
        <div className={fullPage ? 'fixed inset-0 z-50 flex items-center justify-center bg-background p-6 overflow-auto' : 'flex items-center justify-center p-6 sm:p-10'}>
          <div className="grid-overlay" />
          <div className="relative w-full max-w-md">
            <div className="glass-card animated-border rounded-2xl p-6 sm:p-8 text-center space-y-5">
              {/* Radar "signal lost" motif — pulsing rings + rotating sweep, sell-glow palette */}
              <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
                <div className="signal-lost-ring" />
                <div className="signal-lost-ring" />
                <div className="signal-lost-ring" />
                <div className="signal-lost-sweep absolute inset-0 flex items-start justify-center">
                  <div className="w-px h-10 bg-gradient-to-b from-[#ff1478] to-transparent opacity-70" />
                </div>
                <Radar className="w-9 h-9 relative z-10" style={{ color: '#ff1478', filter: 'drop-shadow(0 0 8px rgba(255,20,120,0.7))' }} />
              </div>

              <div className="space-y-1.5">
                <h2 className="glitch-title text-base font-mono font-semibold tracking-wide uppercase" style={{ color: '#ff1478' }}>
                  {title || 'Sinal perdido'}
                </h2>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {message || 'Não se preocupe — nenhum dado foi perdido. Seus ativos monitorados, operações e histórico continuam salvos normalmente. Isso foi só um problema ao mostrar a tela.'}
                </p>
              </div>

              {/* Flatlining candle strip — decorative, matches the app's signal/candle visual language */}
              <div className="flex items-end justify-center gap-1 h-8 opacity-60">
                {[0.9, 0.6, 1, 0.4, 0.8, 0.3, 0.7].map((h, i) => (
                  <div
                    key={i}
                    className="candle-flatline-bar w-1.5 rounded-sm"
                    style={{
                      height: `${h * 100}%`,
                      background: i % 3 === 0 ? '#ff1478' : '#00ff80',
                      animationDelay: `${i * 0.15}s`,
                    }}
                  />
                ))}
              </div>

              {/* Diagnostic panel — same info already sent to the Debug Log, surfaced here for a quick copy-paste into Claude Code */}
              <div className="text-left rounded-lg border border-white/10 bg-black/30 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  <AlertTriangle className="w-3 h-3" style={{ color: '#ff1478' }} />
                  Diagnóstico (já registrado no Debug Log)
                </div>
                <p className="text-[11px] font-mono text-muted-foreground/90 break-words line-clamp-3">
                  {error?.message || String(error)}
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  onClick={this.handleReload}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Recarregar {fullPage ? 'aplicativo' : 'página'}
                </button>
                <button
                  onClick={this.handleCopyDiagnostic}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg border border-white/10 hover:bg-white/5 transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5" style={{ color: '#00ff80' }} /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copiado!' : 'Copiar diagnóstico'}
                </button>
              </div>

              <p className="text-[10px] text-muted-foreground/70">
                Cole o diagnóstico numa conversa com o Claude Code pra pedir a correção.
              </p>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
