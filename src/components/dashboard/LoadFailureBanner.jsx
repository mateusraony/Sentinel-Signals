import React from 'react';
import { KeyRound, ServerCrash, RefreshCw } from 'lucide-react';

/**
 * Aviso no topo do Dashboard quando os dados do servidor não carregam, com a CAUSA em português simples e o que fazer
 * (docs/known-risks.md item 6, correção de 08/11/2026). Só aparece quando `loadFailureCause` sabe dizer a causa.
 * Causa de chave (`needsKey`): botão "Colar a chave" (abre o mesmo diálogo do ícone de chave do topo). Outras: "Tentar de novo".
 */
export default function LoadFailureBanner({ cause, onPasteKey, onRetry }) {
  if (!cause) return null;
  const Icon = cause.needsKey ? KeyRound : ServerCrash;
  return (
    <div role="alert" className="rounded-md px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      style={{ background: 'rgba(221,154,74,0.08)', border: '1px solid rgba(221,154,74,0.3)' }}>
      <div className="flex items-start gap-3 min-w-0">
        <Icon className="w-4 h-4 mt-0.5 shrink-0" style={{ color: '#dd9a4a' }} aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-bold text-foreground leading-snug">{cause.title}</p>
          <p className="text-11px font-mono text-muted-foreground leading-relaxed">{cause.hint}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {cause.needsKey && (
          <button type="button" onClick={onPasteKey}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-11px font-mono font-bold rounded-lg transition-opacity hover:opacity-80"
            style={{ background: 'rgba(221,154,74,0.15)', border: '1px solid rgba(221,154,74,0.4)', color: '#e3b45a' }}>
            <KeyRound className="w-3 h-3" aria-hidden="true" />
            Colar a chave
          </button>
        )}
        <button type="button" onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-11px font-mono rounded-lg border border-white/10 hover:bg-white/5 transition-colors text-muted-foreground">
          <RefreshCw className="w-3 h-3" aria-hidden="true" />
          Tentar de novo
        </button>
      </div>
    </div>
  );
}
