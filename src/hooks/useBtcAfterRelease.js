import { useQueries } from '@tanstack/react-query';
import { fetchBtcAfterRelease } from '@/lib/btcAfterReleaseSource';
import { afterRelease } from '@/lib/btcAfterRelease';

const MIN = 60 * 1000;
const MAX_EVENTS = 10;
const YOUNG_MS = 2 * 60 * MIN;

/**
 * "O BTC depois da divulgação" para as divulgações que já saíram (Agenda 4d, parte 2). Devolve `Map<id, { moves }>` só para as que já têm pelo menos 5 min
 * de vida E cujas velas vieram. Divulgação com mais de 2 h é passado fechado: busca uma vez e nunca mais (`staleTime` infinito); a recente reconsulta a cada
 * minuto até as velas de 1 h fecharem. Sem retentativa e sem erro na tela: falhou = a linha não aparece.
 * @param {{ id: string, startMs: number }[]} events @param {number} nowMs
 */
export function useBtcAfterRelease(events, nowMs) {
  const list = (events ?? []).filter((e) => Number.isFinite(e?.startMs) && e.startMs + 5 * MIN <= nowMs).slice(0, MAX_EVENTS);
  const results = useQueries({
    queries: list.map((e) => {
      const young = nowMs - e.startMs < YOUNG_MS;
      return {
        queryKey: ['btc-after-release', e.id, e.startMs],
        queryFn: () => fetchBtcAfterRelease(e.startMs),
        staleTime: young ? 60 * 1000 : Infinity,
        refetchInterval: young ? 60 * 1000 : false,
        refetchOnWindowFocus: false,
        retry: false,
      };
    }),
  });
  const out = new Map();
  list.forEach((e, i) => {
    const candles = results[i]?.data;
    const r = candles ? afterRelease(candles, e.startMs, nowMs) : null;
    if (r) out.set(e.id, r);
  });
  return out;
}
