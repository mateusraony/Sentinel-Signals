import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchCurrentPrice } from '@/lib/marketDataProvider';
import { usablePrice, formatQuoteAge } from '@/lib/priceProximity';
import { logWarn } from '@/lib/logger';

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
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery({
    queryKey: ['live-price', symbol],
    queryFn: () => fetchCurrentPrice(symbol),
    enabled: Boolean(symbol),
    refetchInterval: REFETCH_MS,
    staleTime: REFETCH_MS / 2,
  });

  const price = usablePrice(data);
  const ageMs = price !== null && dataUpdatedAt ? Math.max(0, Date.now() - dataUpdatedAt) : null;
  const isStale = price !== null && (isError || (ageMs !== null && ageMs > QUOTE_STALE_MS));

  // Achado real (2026-09-18): "Sem cotação" (price === null, nunca houve
  // leitura bem-sucedida) não deixava NENHUM rastro — nem console, nem
  // SystemLog — tornando a causa HTTP exata (rate limit? CORS? timeout?)
  // impossível de diagnosticar remotamente depois do fato. Só instrumenta;
  // não muda retry nem nenhum outro comportamento. Não loga o caso
  // "Desatualizado" (price !== null, isStale) — esse já é visível na UI e
  // não é a falha investigada aqui. Dedupado por símbolo+mensagem via ref
  // para não repetir o mesmo log a cada ciclo de refetch (30s) enquanto o
  // mesmo erro persistir.
  const loggedErrorRef = useRef(null);
  useEffect(() => {
    if (!isError || price !== null || !symbol) return;
    const key = `${symbol}:${error?.message ?? ''}`;
    if (loggedErrorRef.current === key) return;
    loggedErrorRef.current = key;
    logWarn('useLivePrice', `Sem cotação ao vivo para ${symbol}`, { message: error?.message ?? null });
  }, [isError, price, symbol, error]);

  return { price, isLoading, isError, isStale, ageMs, ageLabel: formatQuoteAge(ageMs) };
}

export default useLivePrice;
