// Item 299 (modo de observação sem banco), fase O0 — trava das regras do Realtime Database.
// O retrato do modo de observação guarda ENTRADA, STOP e ALVOS das operações. As regras atuais (`database.rules.json`) liberam leitura e escrita para
// `auth != null`, e a autenticação do painel é ANÔNIMA por decisão do usuário (qualquer visitante "está logado"). Um nó com essa regra seria legível e
// alterável por qualquer pessoa que abra o painel. No RTDB um nó SEM regra é NEGADO por padrão (só o Admin SDK, que ignora as regras, acessa) — é isso que
// o retrato precisa. Esta trava garante que ninguém abra o nó sem querer: nem nele, nem na raiz, nem por um curinga `$qualquer` que o alcance.
// Cada regra tem variantes PLANTADAS que precisam ser acusadas (guard nunca testado contra o próprio alvo é suposição — .claude/rules/testing.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ARQUIVO = join(process.cwd(), 'database.rules.json');
/** Raiz do nó do retrato e do livro de avisos (item 299). Fica FORA de toda regra: negado por padrão. */
export const NO_OBSERVACAO = 'observation';

/** `.read`/`.write` só é "fechado" se for exatamente `false`; qualquer outra expressão (true, "auth != null", "true"…) abre. */
const fechado = (v) => v === undefined || v === false;

/**
 * Percorre `no` e TODOS os descendentes (inclusive curingas `$x` mais fundo) e acusa cada `.read`/`.write` que não seja exatamente `false`.
 * Achado do Codex (PR #567): olhar só o nó e os filhos imediatos deixava passar `observation/snapshot/operations` aberto.
 * @param {unknown} no regra do nó (objeto)
 * @param {string} caminho nome do nó para a mensagem
 * @param {string} rotulo prefixo legível do problema
 * @returns {string[]}
 */
function regrasAbertasAbaixo(no, caminho, rotulo) {
  const p = [];
  if (!no || typeof no !== 'object') return p;
  for (const campo of ['.read', '.write']) {
    if (!fechado(no[campo])) p.push(`${rotulo}: "${caminho}" com "${campo}" aberto`);
  }
  for (const [k, filho] of Object.entries(no)) {
    if (k.startsWith('.') || !filho || typeof filho !== 'object') continue;
    p.push(...regrasAbertasAbaixo(filho, `${caminho}/${k}`, rotulo));
  }
  return p;
}

/**
 * Problemas nas regras do RTDB que expõem (ou poderiam expor) o nó do retrato.
 * @param {string} texto conteúdo de `database.rules.json`
 * @returns {string[]}
 */
export function problemasDasRegrasDoRtdb(texto) {
  let regras;
  try {
    regras = JSON.parse(texto)?.rules;
  } catch {
    return ['database.rules.json não é um JSON válido'];
  }
  if (!regras || typeof regras !== 'object') return ['database.rules.json sem o objeto "rules"'];
  const p = [];
  // 1) As regras CASCATEIAM: um `.read`/`.write` na raiz vale para todos os filhos, inclusive o retrato.
  if (!fechado(regras['.read'])) p.push('raiz com ".read" aberto: vale para todos os nós, inclusive o do retrato');
  if (!fechado(regras['.write'])) p.push('raiz com ".write" aberto: vale para todos os nós, inclusive o do retrato');
  // 2) Curinga no 1º nível (`$qualquer`) casa com "observation": qualquer regra aberta em QUALQUER profundidade sob ele pode alcançar o retrato.
  for (const [chave, no] of Object.entries(regras)) {
    if (chave.startsWith('$')) p.push(...regrasAbertasAbaixo(no, chave, `curinga "${chave}" alcança "${NO_OBSERVACAO}"`));
  }
  // 3) O próprio nó: não precisa existir (negado por padrão); se existir, tudo abaixo dele (em qualquer profundidade) só pode ser explicitamente fechado.
  const noObs = regras[NO_OBSERVACAO];
  if (noObs !== undefined) {
    if (!noObs || typeof noObs !== 'object') p.push(`o nó "${NO_OBSERVACAO}" tem regra que não é um objeto`);
    else p.push(...regrasAbertasAbaixo(noObs, NO_OBSERVACAO, `"${NO_OBSERVACAO}"`));
  }
  return p;
}

const real = () => readFileSync(ARQUIVO, 'utf8');
const comRegras = (mudar) => {
  const obj = JSON.parse(real());
  mudar(obj.rules);
  return JSON.stringify(obj);
};

describe('tripwire: regras do RTDB não podem expor o retrato do modo de observação (item 299, O0)', () => {
  it('as regras reais não abrem o nó do retrato', () => {
    expect(problemasDasRegrasDoRtdb(real())).toEqual([]);
  });

  it('não-vacuidade: as regras reais SÃO abertas para `auth != null` nos outros nós (por isso o retrato precisa ficar fora delas)', () => {
    const regras = JSON.parse(real()).rules;
    expect(regras.assetStates['.read']).toBe('auth != null');
    expect(regras.tradeOperations['.write']).toBe('auth != null');
    expect(regras[NO_OBSERVACAO]).toBeUndefined();
  });

  const VARIANTES = [
    ['raiz com .read "auth != null"', () => comRegras((r) => { r['.read'] = 'auth != null'; })],
    ['raiz com .write true', () => comRegras((r) => { r['.write'] = true; })],
    ['raiz com .read "true" (texto)', () => comRegras((r) => { r['.read'] = 'true'; })],
    ['curinga $qualquer com leitura aberta', () => comRegras((r) => { r.$qualquer = { '.read': 'auth != null' }; })],
    ['curinga $outro com escrita aberta', () => comRegras((r) => { r.$outro = { '.write': true }; })],
    ['nó observation com .read "auth != null"', () => comRegras((r) => { r[NO_OBSERVACAO] = { '.read': 'auth != null' }; })],
    ['nó observation com .write true', () => comRegras((r) => { r[NO_OBSERVACAO] = { '.write': true }; })],
    ['filho observation/snapshot aberto', () => comRegras((r) => { r[NO_OBSERVACAO] = { snapshot: { '.read': 'auth != null' } }; })],
    ['filho observation/alerts aberto', () => comRegras((r) => { r[NO_OBSERVACAO] = { alerts: { '.write': 'auth != null' } }; })],
    ['regra do nó que não é objeto', () => comRegras((r) => { r[NO_OBSERVACAO] = 'auth != null'; })],
    // Achado do Codex (PR #567, P2): a regra aberta mais FUNDO na árvore também expõe o retrato.
    ['neto aberto: observation/snapshot/operations', () => comRegras((r) => { r[NO_OBSERVACAO] = { snapshot: { operations: { '.read': 'auth != null', '.write': true } } }; })],
    ['bisneto aberto bem fundo em observation', () => comRegras((r) => { r[NO_OBSERVACAO] = { a: { b: { c: { '.write': 'auth != null' } } } }; })],
    ['curinga de 1º nível com filho aberto ($node/snapshot)', () => comRegras((r) => { r.$node = { snapshot: { '.read': 'auth != null' } }; })],
    ['curinga com neto aberto ($node/a/b)', () => comRegras((r) => { r.$node = { a: { b: { '.write': true } } }; })],
    ['curinga DENTRO de observation aberto', () => comRegras((r) => { r[NO_OBSERVACAO] = { $id: { '.read': 'auth != null' } }; })],
    ['JSON quebrado', () => '{ "rules": '],
    ['sem o objeto rules', () => '{}'],
  ];

  it.each(VARIANTES)('variante plantada é acusada: %s', (_nome, montar) => {
    expect(problemasDasRegrasDoRtdb(montar()).length).toBeGreaterThan(0);
  });

  it('o nó observation explicitamente FECHADO (`false`) é aceito, e a ausência também', () => {
    expect(problemasDasRegrasDoRtdb(comRegras((r) => { r[NO_OBSERVACAO] = { '.read': false, '.write': false }; }))).toEqual([]);
    expect(problemasDasRegrasDoRtdb(comRegras((r) => { r[NO_OBSERVACAO] = { snapshot: { '.read': false } }; }))).toEqual([]);
  });

  it('fechado em profundidade (`false` em todos os níveis, também sob curinga) é aceito', () => {
    expect(problemasDasRegrasDoRtdb(comRegras((r) => { r[NO_OBSERVACAO] = { snapshot: { operations: { '.read': false, '.write': false } } }; }))).toEqual([]);
    expect(problemasDasRegrasDoRtdb(comRegras((r) => { r.$node = { snapshot: { '.read': false } }; }))).toEqual([]);
  });

  it('abrir OUTRO nó (regra normal do projeto) não é acusado: a trava é só sobre o retrato', () => {
    expect(problemasDasRegrasDoRtdb(comRegras((r) => { r.novoNoQualquer = { '.read': 'auth != null', '.write': 'auth != null' }; }))).toEqual([]);
  });
});
