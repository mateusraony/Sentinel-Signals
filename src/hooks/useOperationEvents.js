import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchOperationEventsSource } from '@/lib/marketContextSource';
import { buildOperationEventContext } from '@/lib/opEventMarkers';

// O arquivo muda ~3x/dia; o Histórico não precisa mais que isso.
const STALE_MS = 30 * 60_000;

/**
 * Os eventos para o marcador "aberta durante <evento>" do Histórico (Fase 5). Só lê arquivos públicos; falhou = `null` e NENHUM marcador (a tela do
 * Histórico não depende disto). `scanner.js` e o motor nunca importam este hook (travado por `scripts/contextIsolationTripwire.test.js`).
 */
export function useOperationEvents({ enabled = true } = {}) {
  const { data } = useQuery({
    queryKey: ['operation-events'],
    queryFn: () => fetchOperationEventsSource(),
    enabled,
    retry: false,
    staleTime: STALE_MS,
    refetchOnWindowFocus: false,
  });
  return useMemo(() => buildOperationEventContext(data, Date.now()), [data]);
}
