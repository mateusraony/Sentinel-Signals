import { QueryClient } from '@tanstack/react-query';
import { POLL_OPERATIONAL_MS } from '@/lib/pollingIntervals';

/**
 * Defaults do TanStack Query (docs/known-risks.md item 155).
 *
 * `refetchOnWindowFocus` estava `false`, herdado do template. Com ele
 * desligado, o `refetchInterval` virava o ÚNICO jeito de a tela se atualizar —
 * e foi o que empurrou os intervalos para 10–15s, estourando a cota de
 * leituras do Firestore (cobrada por documento devolvido).
 *
 * Ligado, o padrão se inverte para o mais barato E o mais responsivo: voltar
 * para a aba atualiza na hora, e enquanto ninguém está olhando o intervalo
 * relaxado basta. `staleTime` limita a rajada de foco — alternar de aba várias
 * vezes em menos de um minuto não redispara as queries.
 */
export const queryClientInstance = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: POLL_OPERATIONAL_MS,
      retry: 1,
    },
  },
});
