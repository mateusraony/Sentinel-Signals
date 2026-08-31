// Isolamento do wrapper de cache do backfill (docs/known-risks.md item 137
// addendum, 2026-08-31): scripts/adminEntitiesBackfillCache.js SÓ pode
// interceptar AssetState/MonitoredAsset — toda outra coleção (em especial
// TradeOperation/SignalEvent/SystemLog/assetActiveOps/scannerLocks) precisa
// continuar batendo direto no backend real de scripts/adminEntities.js, sem
// nenhuma reimplementação: uma operação retroativa tem que nascer pelo MESMO
// caminho transacional (createTradeOpIfNoneActive) que uma ao vivo — nunca
// um 3º caminho de mutação (.claude/rules/trading-engine.md). E dentro de
// AssetState/MonitoredAsset, os métodos de ESCRITA nunca podem chamar o
// método real correspondente — senão o próprio incidente que este arquivo
// existe pra evitar (o replay travando 11+min e sobrescrevendo o snapshot ao
// vivo) volta a acontecer.
//
// Lê o texto-fonte em vez de importar o módulo: adminEntitiesBackfillCache.js
// importa adminEntities.js, que inicializa firebase-admin no top-level
// (precisa de FIREBASE_SERVICE_ACCOUNT_JSON, ausente no ambiente de teste) —
// mesmo motivo de adminEntitiesShadowTripwire.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, './adminEntitiesBackfillCache.js'), 'utf-8');

function extractFunctionBody(fnName) {
  const match = source.match(new RegExp(`function ${fnName}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}\\n`));
  expect(match, `função ${fnName} não encontrada no arquivo`).not.toBeNull();
  return match[0];
}

describe('adminEntitiesBackfillCache.js — tripwire de isolamento', () => {
  it('exporta o backend real por spread — toda coleção fora de AssetState/MonitoredAsset é passthrough, nunca reimplementada', () => {
    expect(source).toContain('...realBackend,');
    expect(source).toContain('...realBackend.entities,');
    // Só estas duas chaves podem sobrescrever o que o spread acima já trouxe.
    const overrideBlock = source.match(/entities:\s*\{[\s\S]*?\},\n\};/)[0];
    const overrideKeys = [...overrideBlock.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
    expect(overrideKeys).toEqual(['AssetState', 'MonitoredAsset']);
  });

  it('AssetState.create/update nunca chamam o método real correspondente (cache em memória, nunca Firestore)', () => {
    const body = extractFunctionBody('createAssetStateCache');
    const createMethod = body.match(/async create\(data\)\s*\{[\s\S]*?\n {4}\},/)[0];
    const updateMethod = body.match(/async update\(id, data\)\s*\{[\s\S]*?\n {4}\},/)[0];
    expect(createMethod).not.toMatch(/real\.create\(/);
    expect(updateMethod).not.toMatch(/real\.update\(/);
    // filter/list/delete/bulkCreate/deleteMany DEVEM continuar reais —
    // só create/update de AssetState (as duas escritas do hot path) são
    // interceptadas.
    expect(body).toMatch(/async filter\(filters = \{\}, sort, limitCount\)/);
    expect(body).toContain('real.list(...args)');
    expect(body).toContain('real.delete(id)');
    expect(body).toContain('real.bulkCreate(items)');
    expect(body).toContain('real.deleteMany(filters)');
  });

  it('MonitoredAsset.update nunca chama o método real — resto do objeto continua o real por spread', () => {
    const body = extractFunctionBody('createMonitoredAssetBackfillEntity');
    expect(body).toContain('...real,');
    const updateMethod = body.match(/async update\(id, data\)\s*\{[\s\S]*?\},/)[0];
    expect(updateMethod).not.toMatch(/real\.update\(/);
  });

  it('a query hot-path só intercepta o formato exato {asset_id, timeframe} sem sort/limit', () => {
    expect(source).toContain('function isAssetStateHotPathQuery(filters, sort, limitCount)');
    expect(source).toContain('if (sort || limitCount || !filters) return false;');
  });
});
