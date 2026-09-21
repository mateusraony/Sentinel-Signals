import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchMarkPrice } from '@/lib/marketDataProvider';
import { logWarn } from '@/lib/logger';

// Funding rate da Binance só muda a cada 8h — a cadência de 30s do preço ao
// vivo (useLivePrice) seria excesso de chamada para um dado que quase nunca
// muda entre duas leituras.
const REFETCH_MS = 5 * 60_000;

/**
 * Funding rate (Futures) de um símbolo — display-only. `src/lib/scanner.js`
 * nunca importa este hook e nenhuma decisão de entrada/saída depende dele.
 *
 * Usa `fetchMarkPrice` (`src/lib/marketDataProvider.js`), que já bate em
 * `fapi.binance.com` (Futures) e já era buscado por essa função — só que o
 * retorno nunca tinha consumidor antes deste hook.
 *
 * Só existe no navegador: o cron (`scripts/adminMarketDataProvider.js`) usa
 * Binance Spot (Futures dá 451 em datacenter US, ver `docs/known-risks.md`
 * item 4) e não tem equivalente para este dado — puramente informativo,
 * visível só enquanto o painel está aberto.
 */
export function useFundingRate(symbol) {
  const { data, isError, error } = useQuery({
    queryKey: ['funding-rate', symbol],
    queryFn: () => fetchMarkPrice(symbol),
    enabled: Boolean(symbol),
    refetchInterval: REFETCH_MS,
    staleTime: REFETCH_MS / 2,
  });

  // Mesmo padrão de dedup por símbolo+mensagem do useLivePrice (item 153):
  // só loga uma vez por erro persistente, não a cada ciclo de refetch.
  const loggedErrorRef = useRef(null);
  useEffect(() => {
    if (!isError || !symbol) return;
    const key = `${symbol}:${error?.message ?? ''}`;
    if (loggedErrorRef.current === key) return;
    loggedErrorRef.current = key;
    logWarn('useFundingRate', `Sem funding rate para ${symbol}`, { message: error?.message ?? null });
  }, [isError, symbol, error]);

  return {
    fundingRate: Number.isFinite(data?.lastFundingRate) ? data.lastFundingRate : null,
    nextFundingTime: data?.nextFundingTime ?? null,
    isError,
  };
}

export default useFundingRate;
