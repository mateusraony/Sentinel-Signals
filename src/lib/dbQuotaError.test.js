// docs/known-risks.md item 282 — reconhecer a cota esgotada do Neon sem
// confundir com a do Firestore nem com erros comuns.
import { describe, it, expect } from 'vitest';
import { isDatabaseQuotaExhausted } from './dbQuotaError.js';

describe('isDatabaseQuotaExhausted', () => {
  it.each([
    // O texto real do log do scan de 2026-10-19 (SQLSTATE 53000).
    'error: Your account or project has exceeded the quota. Upgrade your plan to increase limits.',
    'Your account or project has exceeded the quota. Upgrade your plan to increase limits.',
    'Your account or project has exceeded the compute time quota. Upgrade your plan to increase limits.',
    'Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.',
    'ERROR: Your project has exceeded the DATA STORAGE SIZE quota',
  ])('reconhece: %s', (message) => {
    expect(isDatabaseQuotaExhausted(message)).toBe(true);
  });

  it.each([
    '8 RESOURCE_EXHAUSTED: Quota exceeded.',
    "Quota exceeded for quota metric 'Read requests' and limit 'Read requests per day'",
    'Timeout: scanAllAssets não retornou em 200000ms',
    'connect ECONNREFUSED 127.0.0.1:5432',
    'canceling statement due to statement timeout',
    '',
    null,
    undefined,
  ])('não confunde: %s', (message) => {
    expect(isDatabaseQuotaExhausted(message)).toBe(false);
  });
});
