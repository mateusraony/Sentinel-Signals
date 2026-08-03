// Modo sombra prospectivo (docs/known-risks.md item 56 "Modo sombra") —
// tripwire de isolamento: scripts/adminEntitiesShadow.js precisa escrever
// SÓ em coleções Firestore prefixadas 'experimentalRf1hShadow', nunca nas
// coleções reais de produção. Se um nome de coleção SEM prefixo (a string
// exata que scripts/adminEntities.js usa) algum dia aparecer como argumento
// de createEntity(...) ou db.collection(...) neste arquivo, este teste
// falha alto e cedo, antes de virar um vazamento de escrita em produção.
//
// Lê o texto-fonte em vez de importar o módulo: adminEntitiesShadow.js
// inicializa firebase-admin no top-level do arquivo (precisa de
// FIREBASE_SERVICE_ACCOUNT_JSON, ausente no ambiente de teste) — mesmo
// motivo de rf1hCondTripwire.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, './adminEntitiesShadow.js'), 'utf-8');

// Casa createEntity('name')/db.collection('name') com aspas simples, duplas
// ou crase — os dois pontos de entrada reais por onde um nome de coleção
// literal chega até o Firestore neste arquivo.
function unprefixedCollectionArgOccurrences(name) {
  const re = new RegExp(`(?:createEntity|db\\.collection)\\((['"\`])${name}\\1\\)`, 'g');
  return source.match(re) || [];
}

describe('adminEntitiesShadow.js — tripwire de isolamento de coleção', () => {
  it('NUNCA referencia as coleções reais de produção (sem prefixo) que scanner.js efetivamente muta', () => {
    for (const realCollection of ['tradeOperations', 'signalEvents', 'systemLogs', 'scannerLocks', 'assetActiveOps']) {
      expect(unprefixedCollectionArgOccurrences(realCollection)).toEqual([]);
    }
  });

  it('lê (nunca escreve) a coleção real monitoredAssets — passthrough intencional, único uso do nome sem prefixo', () => {
    expect(unprefixedCollectionArgOccurrences('monitoredAssets')).toHaveLength(1);
    expect(source).toContain("createEntity('monitoredAssets')");
    // O único uso deve estar dentro de createMonitoredAssetShadowEntity, cujos
    // métodos de escrita (create/update/delete/bulkCreate/deleteMany/
    // createUnique) são no-ops explícitos, nunca delegados ao `real` lido
    // acima — é essa combinação (ler de lá, nunca escrever lá) que a linha
    // acima sozinha não prova.
    const fnMatch = source.match(/function createMonitoredAssetShadowEntity\(\)[\s\S]*?\n}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[0];
    expect(fnBody).toContain("createEntity('monitoredAssets')");
    for (const writeMethod of ['create', 'createUnique', 'update', 'delete', 'bulkCreate', 'deleteMany']) {
      // async writeMethod() { ... } — nenhum delega a `real.<writeMethod>`.
      expect(fnBody).not.toMatch(new RegExp(`${writeMethod}:\\s*real\\.${writeMethod}`));
    }
  });

  it('toda coleção de escrita (AssetState/SignalEvent/TradeOperation/SystemLog/locks/assetActiveOps) usa o prefixo SHADOW_PREFIX', () => {
    expect(source).toContain("const SHADOW_PREFIX = 'experimentalRf1hShadow';");
    const prefixedRefs = source.match(/(?:createEntity|db\.collection)\(`\$\{SHADOW_PREFIX\}[A-Za-z]+`\)/g) || [];
    // AssetState, SignalEvent, TradeOperation (x3 — createEntity + os 2 usos
    // diretos em createTradeOpIfNoneActive), PriceAlert, User, ScannerLocks
    // (x2 — acquire/release), AssetActiveOps (x3 — createTradeOpIfNoneActive
    // x2 + clearActiveOp/transitionTradeOp) — piso conservador, só confirma
    // que existe uso real do prefixo em múltiplos pontos, não um número exato
    // frágil a refactor.
    expect(prefixedRefs.length).toBeGreaterThanOrEqual(8);
  });
});
