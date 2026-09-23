import React from 'react';
import { Radar, RefreshCw, Copy, Check, AlertTriangle } from 'lucide-react';

/**
 * Visual "sinal perdido" compartilhado entre ErrorBoundary.jsx (erro de
 * render) e o estado de erro de autenticação em App.jsx — mesmo motivo
 * visual, dois gatilhos diferentes. Extraído de ErrorBoundary.jsx sem
 * mudança de markup/estilo.
 */
export function ErrorFallback({
  fullPage = false,
  title = undefined,
  message = undefined,
  diagnosticText = undefined,
  diagnosticLabel = undefined,
  onReload,
  reloadLabel = undefined,
  onCopy = undefined,
  copied = false,
}) {
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

          {diagnosticText != null && (
            <div className="text-left rounded-lg border border-white/10 bg-black/30 p-3 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                <AlertTriangle className="w-3 h-3" style={{ color: '#ff1478' }} />
                {diagnosticLabel || 'Diagnóstico'}
              </div>
              <p className="text-[11px] font-mono text-muted-foreground/90 break-words line-clamp-3">
                {diagnosticText}
              </p>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            <button
              onClick={onReload}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {reloadLabel || `Recarregar ${fullPage ? 'aplicativo' : 'página'}`}
            </button>
            {onCopy && (
              <button
                onClick={onCopy}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg border border-white/10 hover:bg-white/5 transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5" style={{ color: '#00ff80' }} /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copiado!' : 'Copiar diagnóstico'}
              </button>
            )}
          </div>

          {onCopy && (
            <p className="text-[10px] text-muted-foreground/70">
              Cole o diagnóstico numa conversa com o Claude Code pra pedir a correção.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default ErrorFallback;
