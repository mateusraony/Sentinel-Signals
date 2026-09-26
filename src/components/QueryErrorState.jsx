import React from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';

/**
 * Estado de erro para quando a query principal de uma página falha (rede,
 * backend fora do ar) — sem isto, o valor default (`[]`) da query fazia a
 * tela cair no mesmo "Nenhum X encontrado" que mostraria se não houvesse
 * dado de verdade, escondendo justamente a falha (achado C-3 do Raio-X de
 * UI/UX, docs/claude/ui-audit-criticos.md). Mesmo visual (ícone + texto
 * muted) já usado em CorrelationWidget.jsx/RFHistoryChart.jsx para o
 * mesmo tipo de estado.
 */
export function QueryErrorState({ message = undefined, onRetry = undefined }) {
  return (
    <div className="text-center py-8 px-4">
      <WifiOff className="w-5 h-5 mx-auto mb-2 text-muted-foreground opacity-40" />
      <div className="text-xs font-mono text-muted-foreground">
        {message || 'Não foi possível carregar os dados agora. Pode ser uma instabilidade de rede ou do servidor.'}
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-11px font-mono rounded-lg border border-white/10 hover:bg-white/5 transition-colors text-muted-foreground"
        >
          <RefreshCw className="w-3 h-3" />
          Tentar de novo
        </button>
      )}
    </div>
  );
}

export default QueryErrorState;
