// Espelho admin do tripwire em src/api/entitiesRtdbTripwire.test.js — mesmo
// incidente evitado, mesma técnica (docs/known-risks.md item 152): o mirror
// Firestore→RTDB nunca pode participar da mutação de TradeOperation, e
// clearActiveOp nunca é espelhado. Lê o texto-fonte em vez de importar o
// módulo: adminEntities.js inicializa firebase-admin no top-level (precisa de
// FIREBASE_SERVICE_ACCOUNT_JSON, ausente no ambiente de teste) — mesmo motivo
// de adminEntitiesShadowTripwire.test.js/adminEntitiesBackfillCacheTripwire.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, './adminEntities.js'), 'utf-8');

function extractFunctionBody(fnName) {
  const match = source.match(new RegExp(`function ${fnName}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}\\n`));
  expect(match, `função ${fnName} não encontrada no arquivo`).not.toBeNull();
  return match[0];
}

describe('adminEntities.js — tripwire de isolamento do mirror RTDB', () => {
  it.each(['createTradeOpIfNoneActive', 'transitionTradeOp', 'clearActiveOp'])(
    '%s nunca referencia RTDB no próprio corpo (mirror só acontece FORA da transação, no wrapper)',
    (fnName) => {
      const body = extractFunctionBody(fnName);
      expect(body).not.toMatch(/mirrorSet|mirrorUpdate|mirrorRemove|firebase-admin\/database|rtdb\.ref/);
    },
  );

  it('clearActiveOp nunca é passado a um wrapper de mirror no export final', () => {
    const exportBlock = source.slice(source.indexOf('export const backend'));
    expect(exportBlock).toMatch(/clearActiveOp,/);
    expect(exportBlock).not.toMatch(/withCreateOpMirror\(clearActiveOp\)/);
    expect(exportBlock).not.toMatch(/withTransitionOpMirror\(clearActiveOp\)/);
  });

  it('createTradeOpIfNoneActive/transitionTradeOp SÃO envolvidos pelos wrappers de mirror no export final', () => {
    const exportBlock = source.slice(source.indexOf('export const backend'));
    expect(exportBlock).toMatch(/withCreateOpMirror\(createTradeOpIfNoneActive\)/);
    expect(exportBlock).toMatch(/withTransitionOpMirror\(transitionTradeOp\)/);
  });

  it('só AssetState/TradeOperation são envolvidas por withRtdbMirror no export final — escopo travado', () => {
    const exportBlock = source.slice(source.indexOf('entities: {'), source.indexOf('export const backend') + source.slice(source.indexOf('export const backend')).indexOf('locks:'));
    const wrapped = [...exportBlock.matchAll(/withRtdbMirror\('(\w+)'/g)].map((m) => m[1]);
    expect(wrapped.sort()).toEqual(['AssetState', 'TradeOperation']);
  });

  it('databaseURL ausente deixa rtdb null (guard explícito, mesmo espírito do lado browser)', () => {
    expect(source).toContain('const rtdb = databaseURL ? getDatabase() : null;');
  });

  it('as 3 primitivas de I/O (mirrorSet/mirrorUpdate/mirrorRemove) sempre fazem guard rtdb ?? no-op e nunca lançam (têm .catch próprio)', () => {
    ['mirrorSet', 'mirrorUpdate', 'mirrorRemove'].forEach((fnName) => {
      const body = extractFunctionBody(fnName);
      expect(body).toMatch(/if \(!rtdb\) return;/);
      expect(body).toMatch(/\.catch\(/);
    });
  });
});
