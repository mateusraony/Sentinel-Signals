import { useSyncExternalStore } from 'react';
import { getLastDbRead, subscribeDbRead } from '@/lib/dbReadClock';

/** Instante (ms) da última leitura do banco que deu certo; 0 se nenhuma ainda. Só re-renderiza quando o valor muda. */
export function useLastDbRead() {
  return useSyncExternalStore(subscribeDbRead, getLastDbRead, () => 0);
}
