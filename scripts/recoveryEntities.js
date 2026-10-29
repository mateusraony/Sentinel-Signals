// Replay de recuperação (docs/known-risks.md item 288) — o alvo do redirecionamento
// '@/api/entities' no bundle da recuperação (scripts/build-recovery.mjs). Começa VAZIO e o
// orquestrador (scripts/recoveryDryRun.mjs) preenche com Object.assign na hora certa:
//   - teste a seco → a loja em memória (src/lib/recovery/snapshotBackend.js), nada vai ao banco;
//   - aplicar (PR-R3) → o banco real.
// Mesmo truque que os testes usam (vi.mock + Object.assign). scanner.js e logger.js leem o
// `backend` daqui na hora de cada chamada, então a troca vale para tudo.
export const backend = {};
