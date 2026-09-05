// Tripwire estrutural do item 162 (docs/known-risks.md).
//
// O bug não foi um `if` errado: foi um DETECTOR frágil duplicado em dois
// arquivos, classificando "cota esgotada" por `/RESOURCE_EXHAUSTED/i` numa
// mensagem que o próprio código montava com essa palavra dentro. Corrigir só
// os dois `if` deixaria a armadilha de pé para o próximo arquivo que
// precisasse classificar uma falha. Estes testes travam a forma:
//
//   1. ninguém volta a classificar cota por conta própria;
//   2. a mensagem de timeout nunca volta a carregar a assinatura de cota.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (arquivo) => readFileSync(join(AQUI, arquivo), 'utf8');

const PONTOS_DE_ENTRADA = ['run-scan.mjs', 'run-backfill-check.mjs'];

describe('classificação de falha centralizada', () => {
  it.each(PONTOS_DE_ENTRADA)('%s não classifica cota por conta própria', (arquivo) => {
    const src = ler(arquivo);
    // Nenhum detector local: nem a regex crua, nem uma cópia da função.
    expect(src).not.toMatch(/\/[^\n]*RESOURCE_EXHAUSTED[^\n]*\/[gimsuy]*\.test/);
    expect(src).not.toMatch(/function\s+isFirestoreQuotaExhausted/);
    // E usa o módulo compartilhado, que é onde a regra vive.
    expect(src).toMatch(/from '\.\/failureClassification\.mjs'/);
  });
});

describe('mensagem de timeout', () => {
  it('scanTimeout.mjs não coloca a assinatura de cota dentro do erro que monta', () => {
    const codigo = ler('scanTimeout.mjs')
      .split('\n')
      .filter((linha) => !linha.trim().startsWith('//'))
      .join('\n');
    // Em comentário, explicar a causa provável é útil. Dentro da mensagem, é
    // o que fazia todo travamento virar alerta de cota esgotada.
    expect(codigo).not.toContain('RESOURCE_EXHAUSTED');
  });
});
