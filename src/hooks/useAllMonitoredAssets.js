import { useQuery } from '@tanstack/react-query';
import { backend } from '@/api/entities';

/**
 * Lista de TODOS os ativos monitorados (inclusive inativos) — consulta única,
 * compartilhada por Trades, Verificação e a busca global (item 276).
 *
 * Antes cada tela tinha a sua: `['monitored-assets-verification']`, e a busca
 * global reusava `['monitored-assets']` com `list()` enquanto o Dashboard usa a
 * MESMA chave com `filter({ is_active: true })` — as duas se sobrescreviam no
 * cache. Esta chave é hierárquica (`['monitored-assets', 'all']`), então um
 * `invalidateQueries({ queryKey: ['monitored-assets'] })` também a atualiza.
 * Sem polling: ativo muda raramente.
 */
export const ALL_MONITORED_ASSETS_KEY = ['monitored-assets', 'all'];

export function useAllMonitoredAssets() {
  return useQuery({
    queryKey: ALL_MONITORED_ASSETS_KEY,
    queryFn: () => backend.entities.MonitoredAsset.list(),
    staleTime: 60000,
  });
}
