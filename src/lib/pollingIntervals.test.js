import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as intervals from './pollingIntervals';
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

// Tripwire do item 155: o estouro de cota veio de intervalos espalhados pelas
// telas (10s, 15s, 20s). Um valor novo passa despercebido em review; este
// teste não deixa.
//
// É uma ALLOWLIST, não uma busca por números "ruins": um regex não avalia
// expressão, então `10 * 1000` ou uma constante nova `FAST_POLL_MS` escapariam
// de qualquer blocklist (achado de review no PR #304). Aqui o valor precisa
// ser o NOME de um export deste módulo que esteja no piso ou acima — qualquer
// outra coisa (literal, aritmética, identificador desconhecido) falha.
const ALLOWED_INTERVAL_IDENTIFIERS = new Set(
  Object.entries(intervals)
    .filter(([, value]) => typeof value === 'number' && value >= POLL_OPERATIONAL_MS)
    .map(([name]) => name),
);

// O escopo é definido pelo que a query LÊ, não por onde ela mora: só entra
// no tripwire o `useQuery` que bate no banco (`backend.entities` ou
// `rtdbEntities`). Cotação da Binance (`fetch24hStats`, `fetchCurrentPrice`)
// não consome cota de Firestore/RTDB e fica de fora — exemption por nome de
// arquivo seria frágil e já tinha me escapado um caso.
const DB_READ = /\b(backend\.entities|rtdbEntities)\b/;

export function findPollingOffenders(sources) {
  const offenders = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const block of source.matchAll(/useQuery\(\{([\s\S]*?)\n\s*\}\)/g)) {
      const body = block[1];
      if (!DB_READ.test(body)) continue;
      const interval = body.match(/refetchInterval:\s*([^,\n}]+)/);
      if (!interval) continue;
      const expression = interval[1].trim();
      if (!ALLOWED_INTERVAL_IDENTIFIERS.has(expression)) offenders.push(`${file} → ${expression}`);
    }
  }
  return offenders;
}

describe('tripwire — nenhum poller de banco volta a usar intervalo solto', () => {
  function jsxFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return jsxFiles(full);
      return /\.jsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [full] : [];
    });
  }

  const dbQuery = (interval) => `useQuery({
    queryKey: ['x'],
    queryFn: () => backend.entities.SignalEvent.list('-created_date', 50),
    refetchInterval: ${interval},
  })`;

  it('pega literal, aritmética e constante desconhecida — não só número cru', () => {
    expect(findPollingOffenders({ 'a.jsx': dbQuery('10000') })).toHaveLength(1);
    // Os dois casos que a versão anterior deste tripwire deixava passar:
    expect(findPollingOffenders({ 'b.jsx': dbQuery('10 * 1000') })).toHaveLength(1);
    expect(findPollingOffenders({ 'c.jsx': dbQuery('FAST_POLL_MS') })).toHaveLength(1);
  });

  it('aceita as constantes do módulo, e só elas', () => {
    expect(findPollingOffenders({ 'd.jsx': dbQuery('POLL_OPERATIONAL_MS') })).toEqual([]);
    expect(findPollingOffenders({ 'e.jsx': dbQuery('POLL_DIAGNOSTIC_MS') })).toEqual([]);
    expect(ALLOWED_INTERVAL_IDENTIFIERS.has('SCAN_CADENCE_MS')).toBe(true);
  });

  it('ignora cotação da Binance — não consome cota de banco', () => {
    const binance = `useQuery({
      queryKey: ['24h-stats', asset.symbol],
      queryFn: () => fetch24hStats(asset.symbol),
      refetchInterval: 60000,
    })`;
    expect(findPollingOffenders({ 'f.jsx': binance })).toEqual([]);
  });

  it('uma constante nova abaixo do piso não entraria na allowlist', () => {
    const abaixoDoPiso = Object.entries(intervals)
      .filter(([, v]) => typeof v === 'number' && v < POLL_OPERATIONAL_MS)
      .map(([name]) => name);
    for (const name of abaixoDoPiso) expect(ALLOWED_INTERVAL_IDENTIFIERS.has(name)).toBe(false);
  });

  it('todo refetchInterval de leitura de banco no código real usa as constantes', () => {
    const sources = Object.fromEntries(
      jsxFiles(SRC).map((file) => [path.relative(SRC, file), fs.readFileSync(file, 'utf8')]),
    );
    expect(findPollingOffenders(sources)).toEqual([]);
  });
});
