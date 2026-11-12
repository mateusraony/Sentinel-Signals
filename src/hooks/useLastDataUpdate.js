import { useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** Instante (ms) da atualização mais recente de qualquer consulta da tela; 0 se nenhuma carregou ainda. */
function latestUpdate(cache) {
  let max = 0;
  for (const q of cache.getAll()) {
    const t = q.state.dataUpdatedAt;
    if (t > max) max = t;
  }
  return max;
}

/**
 * "Quando a tela atualizou pela última vez" (docs/known-risks.md item 301): o maior `dataUpdatedAt` do cache do React Query. Devolve um número, então o
 * componente só re-renderiza quando o valor muda (e não a cada evento do cache).
 */
export function useLastDataUpdate() {
  const cache = useQueryClient().getQueryCache();
  return useSyncExternalStore((aviso) => cache.subscribe(aviso), () => latestUpdate(cache), () => 0);
}
