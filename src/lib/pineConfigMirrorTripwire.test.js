// Tripwire POSITIVO (item 143, achado do conselho de 6 agentes de
// 2026-09-02): src/lib/pineParser.js (browser) e scripts/adminPineConfig.js
// (cron) mantêm um par DEFAULTS/SYNCED_STRATEGY_KEYS espelhado À MÃO — sem
// módulo compartilhado (o arquivo do browser usa localStorage, o do cron usa
// firebase-admin). Até agora só existiam tripwires NEGATIVOS (ex.:
// rf1hCondTripwire.test.js — confirma que uma chave específica NUNCA
// aparece nos dois) — nenhum teste comparava o par inteiro chave a chave.
// Isso já causou um bug real: item 27 (emaFastLen/emaSlowLen existiam em
// DEFAULTS desde o início mas nunca foram adicionados a
// SYNCED_STRATEGY_KEYS — scanner.js no cron usava um fallback hardcoded
// diferente do Pine real por MESES, sem qualquer teste acusando a
// divergência, porque nenhum teste comparava os dois arquivos entre si.
//
// Lê o texto-fonte em vez de importar os módulos — mesma técnica de
// rf1hCondTripwire.test.js/adminEntitiesShadowTripwire.test.js: mais simples
// e não depende de nenhuma engenharia de mock, e os dois objetos aqui são
// literais de objeto/array PLANOS (sem aninhamento), então uma extração por
// linha é robusta o bastante.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function extractBlock(source, startMarker) {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`marcador "${startMarker}" não encontrado no arquivo`);
  }
  const bodyStart = startIdx + startMarker.length;
  const endIdx = source.indexOf('\n};', bodyStart);
  const endIdxBracket = source.indexOf('\n];', bodyStart);
  const closing = endIdx === -1 ? endIdxBracket : (endIdxBracket === -1 ? endIdx : Math.min(endIdx, endIdxBracket));
  if (closing === -1) {
    throw new Error(`fechamento do bloco iniciado em "${startMarker}" não encontrado`);
  }
  return source.slice(bodyStart, closing);
}

// Chaves de objeto: `  nomeDaChave: valor,` — ignora linhas de comentário
// (`//...`) para não confundir prosa explicativa ("ex.: chave: valor" dentro
// de um comentário) com uma entrada real do objeto.
function objectKeys(block) {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .map((line) => line.match(/^(\w+)\s*:/))
    .filter(Boolean)
    .map((m) => m[1]);
}

// Strings de array: `'nomeDaChave',` — mesma filtragem de comentário.
function arrayStrings(block) {
  const codeOnly = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .join('\n');
  return [...codeOnly.matchAll(/'(\w+)'/g)].map((m) => m[1]);
}

function readSource(relativePath) {
  return readFileSync(resolve(__dirname, relativePath), 'utf-8');
}

describe('pineParser.js × adminPineConfig.js — DEFAULTS/SYNCED_STRATEGY_KEYS espelhados (item 143)', () => {
  const browserSource = readSource('./pineParser.js');
  const cronSource = readSource('../../scripts/adminPineConfig.js');

  const browserDefaultsKeys = objectKeys(extractBlock(browserSource, 'export const DEFAULTS = {'));
  const cronDefaultsKeys = objectKeys(extractBlock(cronSource, 'const DEFAULTS = {'));

  const browserSyncedKeys = arrayStrings(extractBlock(browserSource, 'export const SYNCED_STRATEGY_KEYS = ['));
  const cronSyncedKeys = arrayStrings(extractBlock(cronSource, 'const SYNCED_STRATEGY_KEYS = ['));

  it('a extração encontrou chaves reais nos dois arquivos (confirma que o parser não está silenciosamente vazio)', () => {
    expect(browserDefaultsKeys.length).toBeGreaterThan(30);
    expect(cronDefaultsKeys.length).toBeGreaterThan(30);
    expect(browserSyncedKeys.length).toBeGreaterThan(20);
    expect(cronSyncedKeys.length).toBeGreaterThan(20);
  });

  it('DEFAULTS tem exatamente as mesmas chaves nos dois arquivos, sem duplicata em nenhum dos dois', () => {
    expect(new Set(browserDefaultsKeys).size).toBe(browserDefaultsKeys.length);
    expect(new Set(cronDefaultsKeys).size).toBe(cronDefaultsKeys.length);
    const missingInCron = browserDefaultsKeys.filter((k) => !cronDefaultsKeys.includes(k));
    const missingInBrowser = cronDefaultsKeys.filter((k) => !browserDefaultsKeys.includes(k));
    expect({ missingInCron, missingInBrowser }).toEqual({ missingInCron: [], missingInBrowser: [] });
  });

  it('SYNCED_STRATEGY_KEYS lista exatamente as mesmas chaves nos dois arquivos, sem duplicata em nenhum dos dois', () => {
    expect(new Set(browserSyncedKeys).size).toBe(browserSyncedKeys.length);
    expect(new Set(cronSyncedKeys).size).toBe(cronSyncedKeys.length);
    const missingInCron = browserSyncedKeys.filter((k) => !cronSyncedKeys.includes(k));
    const missingInBrowser = cronSyncedKeys.filter((k) => !browserSyncedKeys.includes(k));
    expect({ missingInCron, missingInBrowser }).toEqual({ missingInCron: [], missingInBrowser: [] });
  });

  it('toda chave de SYNCED_STRATEGY_KEYS existe em DEFAULTS nos dois arquivos (senão o valor sincronizado nunca teria um default para cair de volta)', () => {
    for (const key of browserSyncedKeys) expect(browserDefaultsKeys).toContain(key);
    for (const key of cronSyncedKeys) expect(cronDefaultsKeys).toContain(key);
  });

  it('regressão nomeada do item 27: emaFastLen/emaSlowLen estão sincronizados nos dois arquivos hoje', () => {
    for (const key of ['emaFastLen', 'emaSlowLen']) {
      expect(browserDefaultsKeys).toContain(key);
      expect(cronDefaultsKeys).toContain(key);
      expect(browserSyncedKeys).toContain(key);
      expect(cronSyncedKeys).toContain(key);
    }
  });
});
