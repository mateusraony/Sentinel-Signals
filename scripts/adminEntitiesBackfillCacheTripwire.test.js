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
  it('exporta o backend real por spread — só AssetState/MonitoredAsset (entities) e upsert (assetStates) sobrescrevem', () => {
    expect(source).toContain('...realBackend,');
    expect(source).toContain('...realBackend.entities,');
    expect(source).toContain('...realBackend.assetStates,');

    const entitiesBlock = source.match(/entities:\s*\{[\s\S]*?\n {2}\},/)[0];
    const entitiesKeys = [...entitiesBlock.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
    expect(entitiesKeys).toEqual(['AssetState', 'MonitoredAsset']);

    // Item 179: assetStates é a 2ª chave de override, fora de `entities` —
    // sem isto, backend.assetStates.upsert bateria direto no Postgres real
    // via o spread `...realBackend` (mesmo incidente do item 137 addendum).
    const assetStatesBlock = source.match(/assetStates:\s*\{[\s\S]*?\n {2}\},/)[0];
    const assetStatesKeys = [...assetStatesBlock.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
    expect(assetStatesKeys).toEqual(['upsert']);
  });

  it('AssetState.create/update/upsert nunca chamam o método real correspondente (cache em memória, nunca Postgres)', () => {
    const body = extractFunctionBody('createAssetStateCache');
    const createMethod = body.match(/async create\(data\)\s*\{[\s\S]*?\n {4}\},/)[0];
    const updateMethod = body.match(/async update\(id, data\)\s*\{[\s\S]*?\n {4}\},/)[0];
    const upsertFn = body.match(/async function upsert\([^)]*\)\s*\{[\s\S]*?\n {2}\}/)[0];
    expect(createMethod).not.toMatch(/real\.create\(/);
    expect(updateMethod).not.toMatch(/real\.update\(/);
    expect(upsertFn).not.toMatch(/real\./);
    expect(upsertFn).toContain('cacheByKey.set(');
    // filter/list/delete/bulkCreate/deleteMany DEVEM continuar reais —
    // só create/update/upsert de AssetState (as escritas do hot path) são
    // interceptadas.
    expect(body).toMatch(/async filter\(filters = \{\}, sort, limitCount\)/);
    expect(body).toContain('real.list(...args)');
    expect(body).toContain('real.delete(id)');
    expect(body).toContain('real.bulkCreate(items)');
    expect(body).toContain('real.deleteMany(filters)');
  });

  it('entity.filter e upsert compartilham o mesmo cacheByKey — uma leitura logo após uma escrita no mesmo tick vê o valor novo', () => {
    const body = extractFunctionBody('createAssetStateCache');
    // Só 1 `new Map()` no corpo inteiro da função — se um 2º Map aparecesse
    // para o upsert, filter() e upsert() poderiam divergir silenciosamente.
    const mapDeclarations = body.match(/new Map\(\)/g) || [];
    expect(mapDeclarations).toHaveLength(1);
  });

  it('MonitoredAsset.update só intercepta o formato exato da escrita per-tick do scanner.js — qualquer outro formato (ex.: backfill_check_status) chama o real', () => {
    const body = extractFunctionBody('createMonitoredAssetBackfillEntity');
    expect(body).toContain('...real,');
    const updateMethod = body.match(/async update\(id, data\)\s*\{[\s\S]*?\n {4}\},/)[0];
    // docs/known-risks.md item 176 addendum 5 — a versão anterior deste
    // guard interceptava o MÉTODO inteiro, sem olhar o `data`, e por isso
    // também engolia a escrita real de backfill_check_status do próprio
    // run-backfill-check.mjs (mesmo `backend`, mesmo objeto). A garantia
    // agora é: existe um caminho que CHAMA real.update (para formato fora
    // do bookkeeping do scanner), e um guard de formato que decide isso —
    // não mais "nunca chama".
    expect(updateMethod).toMatch(/real\.update\(/);
    expect(updateMethod).toMatch(/isScanBookkeepingUpdate\(data\)/);
    expect(source).toContain("const SCAN_BOOKKEEPING_KEYS = new Set(['last_scan_at', 'scan_status', 'scan_error', 'scan_error_since']);");
  });

  it('a query hot-path só intercepta o formato exato {asset_id, timeframe} sem sort/limit', () => {
    expect(source).toContain('function isAssetStateHotPathQuery(filters, sort, limitCount)');
    expect(source).toContain('if (sort || limitCount || !filters) return false;');
  });
});
