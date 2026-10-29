// docs/known-risks.md item 288 — trava de inventário. O teste a seco roda o scanner contra
// um RETRATO do banco (snapshotBackend.js). Se o scanner passar a ler uma entidade que o
// retrato não copia, o replay rodaria com dado faltando e o relatório mentiria sem erro.
// Este teste lê o código do scanner e exige que toda entidade usada esteja no retrato
// (e que todo método de tradeOps/assetStates usado exista na loja em memória).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SNAPSHOT_ENTITIES, createSnapshotBackend } from './snapshotBackend.js';

const scannerSrc = fs.readFileSync(path.resolve(__dirname, '../scanner.js'), 'utf8');

describe('inventário do scanner × retrato do teste a seco', () => {
  it('toda entidade que o scanner usa está no retrato', () => {
    const used = new Set([...scannerSrc.matchAll(/backend\.entities\.([A-Za-z]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(3); // não-vacuidade: a regex achou o uso real
    const missing = [...used].filter((name) => !SNAPSHOT_ENTITIES.includes(name));
    expect(missing).toEqual([]);
  });

  it('todo método de tradeOps/assetStates/locks que o scanner chama existe na loja em memória', () => {
    const { backend } = createSnapshotBackend({});
    const calls = [...scannerSrc.matchAll(/backend\.(tradeOps|assetStates|locks)\.([A-Za-z]+)/g)].map((m) => [m[1], m[2]]);
    expect(calls.length).toBeGreaterThan(3);
    const missing = calls.filter(([group, fn]) => typeof backend[group]?.[fn] !== 'function').map((c) => c.join('.'));
    expect(missing).toEqual([]);
  });
});
