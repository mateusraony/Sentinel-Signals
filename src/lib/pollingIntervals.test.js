import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCAN_CADENCE_MS, POLL_OPERATIONAL_MS, POLL_DIAGNOSTIC_MS,
} from './pollingIntervals';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('pollingIntervals', () => {
  it('mantém os níveis ordenados e abaixo da cadência real do scan', () => {
    expect(POLL_OPERATIONAL_MS).toBeLessThan(POLL_DIAGNOSTIC_MS);
    expect(POLL_DIAGNOSTIC_MS).toBeLessThanOrEqual(SCAN_CADENCE_MS);
  });
});

// Tripwire do item 155: o estouro de cota veio de intervalos literais
// espalhados pelas telas (10s, 15s, 20s). Um número solto novo passa
// despercebido em review; este teste não deixa.
describe('tripwire — nenhum poller de banco volta a usar intervalo literal', () => {
  const PISO_MS = POLL_OPERATIONAL_MS;

  function jsxFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return jsxFiles(full);
      return /\.jsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [full] : [];
    });
  }

  it('todo refetchInterval de leitura de banco vem das constantes, e nunca abaixo do piso', () => {
    const offenders = [];
    for (const file of jsxFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      // useLivePrice bate na Binance, não no banco — fora de cota, fora daqui.
      if (file.endsWith(path.join('hooks', 'useLivePrice.js'))) continue;
      for (const match of source.matchAll(/refetchInterval:\s*(\d[\d_]*)/g)) {
        const ms = Number(match[1].replace(/_/g, ''));
        if (ms < PISO_MS) offenders.push(`${path.relative(SRC, file)} → ${ms}ms`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
