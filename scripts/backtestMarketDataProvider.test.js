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

// Validador real por padrão; um teste troca a implementação para provar que
// erro do VALIDADOR não é relatado como JSON inválido (revisão do pacote 1).
const realIntegrity = await vi.importActual('./backtestDataIntegrity.js');
const validateSpy = vi.fn(realIntegrity.validateCandleSeries);
vi.mock('./backtestDataIntegrity.js', async (importOriginal) => ({
  ...(await importOriginal()),
  validateCandleSeries: (...args) => validateSpy(...args),
}));

const { loadSeries, getSeriesIntegrityIssues, getLoadedSeries } = await import('./backtestMarketDataProvider.js');

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
  fs.writeFileSync(path.join(dir, 'VALIDBUG_1h.json'), JSON.stringify([bar(0)]));
  // Parada da exchange (item 281): a vela de 1h e a de 15m em andamento
  // fecham no MESMO instante (H + 50 min), e há buraco depois.
  const HALT_AT = H + 50 * 60 * 1000;
  const M15 = 15 * 60 * 1000;
  const bar15 = (t) => ({ ...bar(t), closeTime: t + M15 - 1 });
  fs.writeFileSync(path.join(dir, 'HALTUSDT_1h.json'), JSON.stringify([bar(0), { ...bar(H), closeTime: HALT_AT }, bar(4 * H)]));
  fs.writeFileSync(path.join(dir, 'HALTUSDT_15m.json'), JSON.stringify([bar15(H + M15), bar15(H + 2 * M15), { ...bar15(H + 3 * M15), closeTime: HALT_AT }, bar15(4 * H)]));
  // 29/09/2021: o 4h foi cortado às 07:00 (3 h) e o 1h só tem buraco — a prova é o conteúdo.
  const hourlyBar = (i) => ({ openTime: i * H, closeTime: i * H + H - 1, open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 10 });
  const bar4h = (openTime) => ({ ...bar(openTime), closeTime: openTime + 4 * H - 1 });
  const cut4h = { openTime: 4 * H, closeTime: 7 * H - 1, open: 104, high: 108, low: 102, close: 107, volume: 30 }; // = 1h de 4, 5 e 6
  fs.writeFileSync(path.join(dir, 'CUT4H_4h.json'), JSON.stringify([bar4h(0), cut4h, bar4h(8 * H)]));
  fs.writeFileSync(path.join(dir, 'CUT4H_1h.json'), JSON.stringify([4, 5, 6, 8].map(hourlyBar)));
  // Mesmo 4h cortado, mas o conteúdo NÃO bate com o 1h: é dado suspeito, continua erro.
  fs.writeFileSync(path.join(dir, 'BAD4H_4h.json'), JSON.stringify([bar4h(0), { ...cut4h, high: 150 }, bar4h(8 * H)]));
  fs.writeFileSync(path.join(dir, 'BAD4H_1h.json'), JSON.stringify([4, 5, 6, 8].map(hourlyBar)));
  // 4h cortado às 07:00, mas o 1h das 07:00 EXISTE: o 4h omitiria negociação real (review do Codex, PR #510).
  fs.writeFileSync(path.join(dir, 'LATE4H_4h.json'), JSON.stringify([bar4h(0), cut4h, bar4h(8 * H)]));
  fs.writeFileSync(path.join(dir, 'LATE4H_1h.json'), JSON.stringify([4, 5, 6, 7, 8].map(hourlyBar)));
  // Vela parcial isolada SEM o 15m confirmando o mesmo instante: não é parada.
  fs.writeFileSync(path.join(dir, 'LONEUSDT_1h.json'), JSON.stringify([bar(0), { ...bar(H), closeTime: HALT_AT }, bar(2 * H)]));
  fs.writeFileSync(path.join(dir, 'LONEUSDT_15m.json'), JSON.stringify([bar15(H), bar15(H + M15), bar15(H + 2 * M15)]));
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

  it('defeito do validador NÃO vira "JSON inválido" — estoura, em vez de mandar baixar de novo um arquivo certo', () => {
    validateSpy.mockImplementationOnce(() => { throw new Error('bug no validador'); });
    expect(() => loadSeries('VALIDBUG', '1h')).toThrow('bug no validador');
    expect(issuesFor('VALIDBUG')).toEqual([]);
  });

  it('parada da exchange confirmada pelo 15m: 1h e 15m carregam consertadas, só com AVISO (item 281)', () => {
    expect(loadSeries('HALTUSDT', '1h')[1].closeTime).toBe(2 * H - 1);
    expect(loadSeries('HALTUSDT', '15m')[2].closeTime).toBe(2 * H - 1);
    const kinds = (tf) => issuesFor('HALTUSDT').filter((i) => i.timeframe === tf).map((i) => `${i.severity}:${i.type}`);
    expect(kinds('1h')).toEqual(['warning:close_time_truncated_repaired', 'warning:gap']);
    expect(kinds('15m')).toEqual(['warning:close_time_truncated_repaired', 'warning:gap']);
  });

  it('4h cortado às 07:00 com 1h só com buraco: conteúdo = agregado do 1h, carrega consertado (item 281, 2ª execução)', () => {
    expect(loadSeries('CUT4H', '4h')[1].closeTime).toBe(8 * H - 1);
    const issues = issuesFor('CUT4H').filter((i) => i.timeframe === '4h');
    expect(issues.map((i) => `${i.severity}:${i.type}`)).toEqual(['warning:close_time_truncated_repaired']);
    expect(issues[0].samples[0].via).toContain('agregado de 1h');
  });

  it('4h cortado cujo conteúdo NÃO bate com o 1h continua ERRO, com o diagnóstico no aviso', () => {
    expect(loadSeries('BAD4H', '4h')[1].closeTime).toBe(7 * H - 1);
    const kinds = issuesFor('BAD4H').filter((i) => i.timeframe === '4h').map((i) => `${i.severity}:${i.type}`);
    expect(kinds).toEqual(['warning:close_time_truncated_unverified', 'error:close_time_mismatch']);
    expect(issuesFor('BAD4H')[0].samples[0].detail).toContain('high 150');
  });

  it('4h cortado com o 1h das 07:00 existindo continua ERRO — não estende para completo (review do Codex, PR #510)', () => {
    expect(loadSeries('LATE4H', '4h')[1].closeTime).toBe(7 * H - 1);
    const kinds = issuesFor('LATE4H').filter((i) => i.timeframe === '4h').map((i) => `${i.severity}:${i.type}`);
    expect(kinds).toEqual(['warning:close_time_truncated_unverified', 'error:close_time_mismatch']);
  });

  it('vela curta SEM outro timeframe parando no mesmo instante continua ERRO (review do Codex, PR #509)', () => {
    expect(loadSeries('LONEUSDT', '1h')[1].closeTime).toBe(H + 50 * 60 * 1000);
    // O erro continua; o aviso de diagnóstico (item 281) só explica por que a prova falhou.
    expect(issuesFor('LONEUSDT').map((i) => `${i.severity}:${i.type}`)).toEqual(['warning:close_time_truncated_unverified', 'error:close_time_mismatch']);
  });

  it('getLoadedSeries devolve toda série lida, para a checagem de cobertura pós-replay', () => {
    loadSeries('OKUSDT', '1h');
    const loaded = getLoadedSeries().find((e) => e.symbol === 'OKUSDT' && e.timeframe === '1h');
    expect(loaded.series).toHaveLength(3);
  });
});
