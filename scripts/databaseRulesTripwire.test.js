// Item 299 (modo de observação sem banco), fase O0 — trava das regras do Realtime Database. A análise mora em scripts/observationRules.mjs (a mesma que o
// armazenamento usa, em tempo de execução, nas regras PUBLICADAS); aqui se confere o arquivo do repositório e se provam as variantes.
// O retrato do modo de observação guarda ENTRADA, STOP e ALVOS das operações. As regras atuais (`database.rules.json`) liberam leitura e escrita para
// `auth != null`, e a autenticação do painel é ANÔNIMA por decisão do usuário (qualquer visitante "está logado"). Um nó com essa regra seria legível e
// alterável por qualquer pessoa que abra o painel. No RTDB um nó SEM regra é NEGADO por padrão (só o Admin SDK, que ignora as regras, acessa) — é isso que
// o retrato precisa. Esta trava garante que ninguém abra o nó sem querer: nem nele, nem na raiz, nem por um curinga `$qualquer` que o alcance.
// Cada regra tem variantes PLANTADAS que precisam ser acusadas (guard nunca testado contra o próprio alvo é suposição — .claude/rules/testing.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_OBSERVACAO, problemasDasRegrasDoRtdb } from './observationRules.mjs';

const ARQUIVO = join(process.cwd(), 'database.rules.json');

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

  it('a MESMA análise aceita o objeto já lido (é o que o armazenamento recebe das regras publicadas) e dá o mesmo resultado que o texto', () => {
    expect(problemasDasRegrasDoRtdb(JSON.parse(real()))).toEqual([]);
    for (const [, montar] of VARIANTES) {
      const texto = montar();
      let objeto;
      try { objeto = JSON.parse(texto); } catch { continue; }
      expect(problemasDasRegrasDoRtdb(objeto), texto.slice(0, 60)).toEqual(problemasDasRegrasDoRtdb(texto));
    }
    expect(problemasDasRegrasDoRtdb(undefined).length).toBeGreaterThan(0);
    expect(problemasDasRegrasDoRtdb({}).length).toBeGreaterThan(0);
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
