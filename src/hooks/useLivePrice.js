import { useQuery } from '@tanstack/react-query';
import { fetchCurrentPrice } from '@/lib/marketDataProvider';
import { usablePrice, formatQuoteAge } from '@/lib/priceProximity';

// Uma cotação parada por mais de 3 ciclos de refetch não é mais "ao vivo".
const QUOTE_STALE_MS = 90_000;
const REFETCH_MS = 30_000;

/**
 * Preço ao vivo de um símbolo, com honestidade sobre a idade do dado.
 *
 * O TanStack Query mantém o último `data` bem-sucedido quando um refetch
 * falha — sem `isStale`, o card mostraria uma cotação velha rotulada como
 * "ao vivo" durante uma indisponibilidade da Binance (achado de review no
 * PR #301, ver docs/known-risks.md item 153). `isStale` cobre os dois casos:
 * a última tentativa falhou, ou a última tentativa BEM-SUCEDIDA já passou da
 * validade. A idade é recalculada a cada render, e o próprio `refetchInterval`
 * garante um render a cada 30s mesmo em erro contínuo.
 *
 * A `queryKey` por símbolo mantém a dedup do TanStack Query: dois cards do
 * mesmo par compartilham uma única requisição.
 *
 * Somente leitura de mercado — não toca Firestore/RTDB e não dispara
 * nenhuma transição de operação.
 */
export function useLivePrice(symbol) {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ['live-price', symbol],
    queryFn: () => fetchCurrentPrice(symbol),
    enabled: Boolean(symbol),
    refetchInterval: REFETCH_MS,
    staleTime: REFETCH_MS / 2,
  });

  const price = usablePrice(data);
  const ageMs = price !== null && dataUpdatedAt ? Math.max(0, Date.now() - dataUpdatedAt) : null;
  const isStale = price !== null && (isError || (ageMs !== null && ageMs > QUOTE_STALE_MS));

  return { price, isLoading, isError, isStale, ageMs, ageLabel: formatQuoteAge(ageMs) };
}

export default useLivePrice;
