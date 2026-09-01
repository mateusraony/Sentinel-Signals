// src/lib/queryFilters.js — semântica compartilhada dos filtros pelos TRÊS
// backends (Firestore browser, firebase-admin cron, fake em memória).
// docs/known-risks.md item 133.
import { describe, it, expect } from 'vitest';
import { classifyFilter, matchesFilter, RANGE_OPERATORS } from './queryFilters.js';

describe('classifyFilter — formas suportadas', () => {
  it('undefined vira skip (filtro ausente não restringe nada)', () => {
    expect(classifyFilter('status', undefined)).toEqual({ kind: 'skip' });
  });

  it('array vira `in`', () => {
    expect(classifyFilter('status', ['A', 'B'])).toEqual({ kind: 'in', operand: ['A', 'B'] });
  });

  it('escalar vira igualdade', () => {
    expect(classifyFilter('asset_id', 'x1')).toEqual({ kind: 'eq', operand: 'x1' });
  });

  it('null vira igualdade, não range (null é valor legítimo no Firestore)', () => {
    expect(classifyFilter('closed_at', null)).toEqual({ kind: 'eq', operand: null });
  });

  it('{ gte } vira range com o operador do Firestore', () => {
    expect(classifyFilter('created_date', { gte: '2026-01-01' }))
      .toEqual({ kind: 'range', ranges: [{ operator: '>=', operand: '2026-01-01' }] });
  });

  it('{ gte, lt } vira duas constraints de range no mesmo campo — intervalo [a, b)', () => {
    expect(classifyFilter('created_date', { gte: '2026-01-01', lt: '2026-02-01' }))
      .toEqual({ kind: 'range', ranges: [
        { operator: '>=', operand: '2026-01-01' },
        { operator: '<', operand: '2026-02-01' },
      ] });
  });

  it('Date NÃO é tratada como descritor de range', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(classifyFilter('created_date', d)).toEqual({ kind: 'eq', operand: d });
  });
});

// O ponto que mais importa deste módulo. Um operador não reconhecido que
// fosse ignorado devolveria MAIS documentos que o pedido (perde a economia
// de cota em silêncio); e cair no ramo de igualdade contra um objeto
// devolveria ZERO documentos, quebrando o chamador sem erro nenhum — que é
// como o ramo de expiração do item 47.2 morreria sem ninguém notar.
describe('classifyFilter — falha ALTO, nunca em silêncio', () => {
  it('operador desconhecido lança e nomeia os suportados', () => {
    expect(() => classifyFilter('created_date', { lte: 'x' }))
      .toThrow(/operador de range desconhecido 'lte'.*gte/s);
  });

  it('operador conhecido combinado com desconhecido lança', () => {
    expect(() => classifyFilter('created_date', { gte: 'a', gt: 'b' }))
      .toThrow(/operador de range desconhecido 'gt'.*gte, lt/s);
  });

  it('mais operadores do que os suportados lança (nunca despeja o range inteiro por engano)', () => {
    expect(() => classifyFilter('created_date', { gte: 'a', lt: 'b', gt: 'c' }))
      .toThrow(/precisa de 1 a 2 operador\(es\), recebeu 3/);
  });

  it('objeto vazio lança em vez de virar filtro que não filtra nada', () => {
    expect(() => classifyFilter('created_date', {}))
      .toThrow(/precisa de 1 a 2 operador\(es\), recebeu 0/);
  });

  it('operador com operando undefined lança', () => {
    expect(() => classifyFilter('created_date', { gte: undefined }))
      .toThrow(/recebeu undefined/);
  });

  it('só `gte`/`lt` são suportados hoje — este teste falha de propósito ao adicionar outro, forçando revisão dos 4 backends (entities.js/adminEntities.js/adminEntitiesShadow.js/fakeBackend.js)', () => {
    expect(Object.keys(RANGE_OPERATORS)).toEqual(['gte', 'lt']);
  });
});

describe('matchesFilter — o fake precisa concordar com o operador real', () => {
  it('range aceita igual e maior, rejeita menor', () => {
    const f = { gte: '2026-06-01' };
    expect(matchesFilter('created_date', f, '2026-06-01')).toBe(true);
    expect(matchesFilter('created_date', f, '2026-07-01')).toBe(true);
    expect(matchesFilter('created_date', f, '2026-05-31')).toBe(false);
  });

  it('documento SEM o campo nunca satisfaz um range — igual ao Firestore, que não o indexa', () => {
    expect(matchesFilter('created_date', { gte: '2026-01-01' }, undefined)).toBe(false);
    expect(matchesFilter('created_date', { gte: '2026-01-01' }, null)).toBe(false);
  });

  it('intervalo { gte, lt } exige as DUAS constraints — dentro entra, nas bordas depende do lado', () => {
    const f = { gte: '2026-06-01', lt: '2026-07-01' };
    expect(matchesFilter('created_date', f, '2026-06-15')).toBe(true);
    expect(matchesFilter('created_date', f, '2026-06-01')).toBe(true); // gte inclui o início
    expect(matchesFilter('created_date', f, '2026-07-01')).toBe(false); // lt exclui o fim
    expect(matchesFilter('created_date', f, '2026-05-31')).toBe(false);
  });

  it('igualdade e `in` seguem valendo', () => {
    expect(matchesFilter('status', 'OPEN', 'OPEN')).toBe(true);
    expect(matchesFilter('status', 'OPEN', 'CLOSED')).toBe(false);
    expect(matchesFilter('status', ['A', 'B'], 'B')).toBe(true);
    expect(matchesFilter('status', ['A', 'B'], 'C')).toBe(false);
  });

  it('filtro ausente não restringe', () => {
    expect(matchesFilter('status', undefined, 'qualquer')).toBe(true);
  });
});
