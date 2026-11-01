import { useQuery } from '@tanstack/react-query';
import { fetchMarketContext } from '@/lib/marketContextSource';

// O coletor roda ≥ 3x/dia e o raw.githubusercontent.com guarda ~5 min em cache: reler a cada 10 min é de sobra.
const REFETCH_MS = 10 * 60_000;

/**
 * Agenda de eventos (CPI, Payroll, PPI, PCE, FOMC) da branch pública `context-data` — só exibição. `scanner.js` e o
 * motor nunca importam este hook (travado por `scripts/contextIsolationTripwire.test.js`). Falha em silêncio: sem
 * dado, `events` fica null e a faixa mostra "indisponível". Sem log de propósito (`logWarn` grava no banco, e
 * "a branch ainda não existe" é esperado antes da 1ª coleta).
 */
export function useMarketContext({ enabled = true } = {}) {
  const { data, isLoading } = useQuery({
    queryKey: ['market-context'],
    queryFn: () => fetchMarketContext(),
    enabled,
    retry: false,
    refetchInterval: REFETCH_MS,
    staleTime: REFETCH_MS / 2,
  });
  return { events: data?.events ?? null, checkedAtMs: data?.checkedAtMs ?? null, isLoading: enabled && isLoading };
}
