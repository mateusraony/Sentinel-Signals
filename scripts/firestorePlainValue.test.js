import { describe, it, expect } from 'vitest';
import { toPlainValue, canonicalJson } from './firestorePlainValue.mjs';

describe('toPlainValue', () => {
  it('converte um valor duck-typed de Firestore Timestamp para string ISO', () => {
    const seconds = 1_725_000_000; // 2024-08-30T09:20:00.000Z
    const timestamp = {
      seconds,
      nanoseconds: 0,
      toDate: () => new Date(seconds * 1000),
    };
    expect(toPlainValue(timestamp)).toBe(new Date(seconds * 1000).toISOString());
  });

  it('converte um Timestamp aninhado dentro de objeto/array', () => {
    const seconds = 1_725_000_000;
    const timestamp = { seconds, nanoseconds: 0, toDate: () => new Date(seconds * 1000) };
    const input = { role: 'user', meta: { created_at: timestamp }, history: [timestamp] };
    const result = toPlainValue(input);
    expect(result.meta.created_at).toBe(new Date(seconds * 1000).toISOString());
    expect(result.history[0]).toBe(new Date(seconds * 1000).toISOString());
  });

  it('deixa string/number/boolean/null intactos', () => {
    expect(toPlainValue('BTCUSDT')).toBe('BTCUSDT');
    expect(toPlainValue(42)).toBe(42);
    expect(toPlainValue(true)).toBe(true);
    expect(toPlainValue(null)).toBeNull();
  });

  it('não confunde um objeto comum com Timestamp (precisa das 3 propriedades)', () => {
    const notATimestamp = { seconds: 1, nanoseconds: 2 }; // sem toDate()
    expect(toPlainValue(notATimestamp)).toEqual({ seconds: 1, nanoseconds: 2 });
  });

  it('preserva ordem de array e percorre objeto recursivamente sem Timestamp', () => {
    const input = { a: 1, b: { c: [1, 2, { d: 3 }] } };
    expect(toPlainValue(input)).toEqual(input);
  });
});

describe('canonicalJson', () => {
  it('produz a mesma string para o mesmo conteúdo em ordens de chave diferentes', () => {
    const a = { id: '1', status: 'RUNNER_ACTIVE', symbol: 'BTCUSDT' };
    const b = { symbol: 'BTCUSDT', id: '1', status: 'RUNNER_ACTIVE' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('preserva a ORDEM de um array (não ordena elementos)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('ordena chaves recursivamente em objetos aninhados', () => {
    const a = { z: 1, nested: { b: 2, a: 1 } };
    const b = { nested: { a: 1, b: 2 }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('conteúdo diferente produz string diferente', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});
