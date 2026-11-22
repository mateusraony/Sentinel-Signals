import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyzePineInputs, DESTINATION_LABEL } from './pineInputs';
import { parsePineScript, DEFAULTS } from './pineParser';

// pineParser puxa o cliente do backend (e este o Firebase) na importação; aqui só importam as funções puras.
vi.mock('@/api/entities', () => ({ backend: {} }));

// O Pine padrão (NE RF v13.2) vive como texto na própria página.
const SRC = readFileSync(new URL('../pages/PineScript.jsx', import.meta.url), 'utf8');
const DEFAULT_PINE = SRC.slice(SRC.indexOf('const DEFAULT_PINE = `') + 'const DEFAULT_PINE = `'.length, SRC.indexOf('\n`;', SRC.indexOf('const DEFAULT_PINE')));

describe('analyzePineInputs — espelha o parsePineScript', () => {
  it('PARIDADE: todo valor "lido" é exatamente o que o parser real extrai do mesmo código', () => {
    expect(DEFAULT_PINE.length).toBeGreaterThan(1000);
    const parsed = parsePineScript(DEFAULT_PINE);
    const { read } = analyzePineInputs(DEFAULT_PINE);
    expect(read.length).toBeGreaterThan(20);
    for (const r of read) expect(parsed[r.name], r.name).toBe(r.value);
  });

  it('PARIDADE: todo input que o parser mudou em relação ao padrão aparece como lido', () => {
    const code = DEFAULT_PINE.replace('rng_per = input.int(20,', 'rng_per = input.int(33,').replace('minScore          = input.int(75,', 'minScore          = input.int(82,');
    const parsed = parsePineScript(code);
    const { read } = analyzePineInputs(code);
    const names = read.map((r) => r.name);
    for (const k of Object.keys(parsed)) {
      if (k.startsWith('_') || k === 'pineVersion' || k === 'strategyTitle') continue;
      if (parsed[k] !== DEFAULTS[k]) expect(names, k).toContain(k);
    }
    expect(read.find((r) => r.name === 'rng_per')).toMatchObject({ value: 33, isDefault: false });
    expect(read.find((r) => r.name === 'minScore')).toMatchObject({ value: 82, isDefault: false });
  });

  it('o Pine padrão: sem alteração nenhuma (changed = 0) e com muita coisa que o Sentinel não lê', () => {
    const r = analyzePineInputs(DEFAULT_PINE);
    expect(r.changed).toBe(0);
    expect(r.ignored.length).toBeGreaterThan(15);
  });
});

describe('analyzePineInputs — o que é lido e o que não é', () => {
  const CODE = `
groupRF = "01. Range Filter"
groupBot = "10. Bot"
rng_per = input.int(20, "Swing Period", group = groupRF, minval = 1)
rng_qty = input.float(3.5, "Swing Multiplier", group = groupRF)
minScore = input.int(75, "Score mínimo", group = groupRF)
exitMode = input.string("Híbrido RF + ATR", "Modo de saída do runner", options = ["A","B"], group = groupRF)
buyColor = input.color(#00b36b, "Cor BUY", group = groupBot)
startDate = input.time(timestamp("01 Jan 2024 00:00 +0000"), "Data inicial", group = groupBot)
webhookSecret = input.string("MEU_SECRET_AQUI", "Webhook Secret", group = groupBot)
`;
  const r = analyzePineInputs(CODE);

  it('lê só o que o parser lê (nome em DEFAULTS + int/float/bool/string)', () => {
    expect(r.read.map((x) => x.name)).toEqual(['rng_per', 'rng_qty', 'minScore']);
  });
  it('o resto vai para "só vale no TradingView" — inclusive cor, data (com parênteses) e o segredo do webhook', () => {
    expect(r.ignored.map((x) => x.name)).toEqual(['exitMode', 'buyColor', 'startDate', 'webhookSecret']);
  });
  it('usa o rótulo e o grupo que o próprio Pine dá', () => {
    expect(r.read[0]).toMatchObject({ title: 'Swing Period', group: '01. Range Filter' });
    expect(r.ignored.find((x) => x.name === 'startDate')).toMatchObject({ title: 'Data inicial', group: '10. Bot' });
  });
  it('o destino: RF vai para os ativos; o resto sincronizado vai para scan e painel', () => {
    expect(r.read.find((x) => x.name === 'rng_per').destination).toBe('ativos');
    expect(r.read.find((x) => x.name === 'minScore').destination).toBe('scan');
    expect(Object.keys(DESTINATION_LABEL)).toEqual(['ativos', 'scan', 'local']);
  });
  it('código vazio: nada lido, nada quebrado', () => {
    expect(analyzePineInputs('')).toEqual({ items: [], read: [], ignored: [], changed: 0 });
    expect(analyzePineInputs(undefined).read).toEqual([]);
  });
  it('input mal formado (sem fechar o parêntese) é ignorado sem travar', () => {
    expect(() => analyzePineInputs('rng_per = input.int(20, "x"')).not.toThrow();
  });
});
