// docs/known-risks.md item 260 — o adaptador de candles do backtest registra
// os problemas de cada arquivo em vez de engoli-los. Antes: arquivo ausente
// virava série vazia com um console.warn; JSON corrompido estourava a cada
// passo e era engolido pelo try/catch por timeframe do scanAsset.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isola o adaptador do motor (backtestEngine.js importa scanner.js inteiro).
vi.mock('../src/lib/backtestEngine.js', () => ({
  sliceClosedAsOf: (candles) => candles,
  simNow: () => 0,
}));

const { loadSeries, getSeriesIntegrityIssues } = await import('./backtestMarketDataProvider.js');

const H = 60 * 60 * 1000;
function bar(openTime) {
  return { openTime, closeTime: openTime + H - 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 };
}

let dir;
let previousDataDir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-integrity-'));
  previousDataDir = process.env.BACKTEST_DATA_DIR;
  process.env.BACKTEST_DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, 'OKUSDT_1h.json'), JSON.stringify([bar(0), bar(H), bar(2 * H)]));
  fs.writeFileSync(path.join(dir, 'DUPUSDT_1h.json'), JSON.stringify([bar(0), bar(H), bar(H)]));
  fs.writeFileSync(path.join(dir, 'BADJSON_1h.json'), '[{"openTime": 0,');
});
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.BACKTEST_DATA_DIR;
  else process.env.BACKTEST_DATA_DIR = previousDataDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const issuesFor = (symbol) => getSeriesIntegrityIssues().filter((i) => i.symbol === symbol);

describe('backtestMarketDataProvider.loadSeries — integridade (item 260)', () => {
  it('arquivo válido: série devolvida, nenhum problema registrado', () => {
    expect(loadSeries('OKUSDT', '1h')).toHaveLength(3);
    expect(issuesFor('OKUSDT')).toEqual([]);
  });

  it('arquivo ausente: continua devolvendo [] mas registra missing_file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadSeries('NOFILE', '1h')).toEqual([]);
    warn.mockRestore();
    expect(issuesFor('NOFILE').map((i) => `${i.severity}:${i.type}`)).toEqual(['error:missing_file']);
  });

  it('JSON corrompido: não estoura mais a cada passo — devolve [] e registra invalid_json uma vez', () => {
    expect(loadSeries('BADJSON', '1h')).toEqual([]);
    expect(loadSeries('BADJSON', '1h')).toEqual([]); // 2ª chamada vem do cache, sem reparse
    const issues = issuesFor('BADJSON');
    expect(issues.map((i) => `${i.severity}:${i.type}`)).toEqual(['error:invalid_json']);
    expect(issues[0].count).toBe(1);
  });

  it('problema estrutural de série existente (duplicata) é registrado', () => {
    loadSeries('DUPUSDT', '1h');
    expect(issuesFor('DUPUSDT').map((i) => `${i.severity}:${i.type}`)).toEqual(['error:duplicate']);
  });
});
