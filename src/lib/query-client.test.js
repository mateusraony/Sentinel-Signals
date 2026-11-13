import { describe, it, expect } from 'vitest';
import { shouldRetryQuery, queryClientInstance } from './query-client.js';
import { STALE_TIME_MS } from './pollingIntervals.js';

describe('shouldRetryQuery', () => {
  it('mantém 1 tentativa extra para erro comum (comportamento de antes: retry 1)', () => {
    expect(shouldRetryQuery(0, new Error('Failed to fetch'))).toBe(true);
    expect(shouldRetryQuery(1, new Error('Failed to fetch'))).toBe(false);
  });

  it('banco sem cota (db_quota) não é retentado — a recusa se repete até o mês renovar', () => {
    expect(shouldRetryQuery(0, Object.assign(new Error('Banco de dados sem cota.'), { status: 503, code: 'db_quota' }))).toBe(false);
  });
});

// Item 301: as telas agora atualizam sozinhas só a cada 30 min; quem volta para a aba ou troca de página vê dado fresco porque o dado vale 1 min. Se o
// staleTime virasse 30 min (herdando o intervalo) voltar para a aba não atualizaria nada.
describe('queryClientInstance — validade do dado', () => {
  it('staleTime é o STALE_TIME_MS (1 min), não o intervalo de 30 min', () => {
    expect(queryClientInstance.getDefaultOptions().queries.staleTime).toBe(STALE_TIME_MS);
    expect(STALE_TIME_MS).toBe(60_000);
  });
  it('voltar para a aba atualiza o que está velho (refetchOnWindowFocus ligado)', () => {
    expect(queryClientInstance.getDefaultOptions().queries.refetchOnWindowFocus).toBe(true);
  });
});
