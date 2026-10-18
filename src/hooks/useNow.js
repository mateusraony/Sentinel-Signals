import { useEffect, useState } from 'react';

/**
 * Relógio que re-renderiza a cada `intervalMs` (padrão 30 s). Texto que depende
 * da hora ("há 3 min", "atrasado") congelaria enquanto os dados não mudam —
 * mesmo problema já corrigido no drawer (Codex, PR #461). Item 277.
 */
export function useNow(intervalMs = 30 * 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
