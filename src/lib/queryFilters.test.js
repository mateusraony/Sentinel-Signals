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
      .toEqual({ kind: 'range', operator: '>=', operand: '2026-01-01' });
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

  it('mais de um operador lança', () => {
    expect(() => classifyFilter('created_date', { gte: 'a', gt: 'b' }))
      .toThrow(/exatamente 1 operador, recebeu 2/);
  });

  it('objeto vazio lança em vez de virar filtro que não filtra nada', () => {
    expect(() => classifyFilter('created_date', {}))
      .toThrow(/exatamente 1 operador, recebeu 0/);
  });

  it('operador com operando undefined lança', () => {
    expect(() => classifyFilter('created_date', { gte: undefined }))
      .toThrow(/recebeu undefined/);
  });

  it('só `gte` é suportado hoje — este teste falha de propósito ao adicionar outro, forçando revisão dos 3 backends', () => {
    expect(Object.keys(RANGE_OPERATORS)).toEqual(['gte']);
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
