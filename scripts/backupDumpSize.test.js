// docs/known-risks.md item 288, addendum de 01/11/2026: um dump vazio ou cortado não pode passar como
// "backup do dia". Parte pura (assertDumpSize) + o script de verdade rodando com um `pg_dump` falso
// (sem banco), para provar que o piso está LIGADO no caminho real e não só existe como função solta.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_DUMP_BYTES, assertDumpSize, formatBytes } from './backup-postgres.mjs';

const SCRIPT = join(process.cwd(), 'scripts', 'backup-postgres.mjs');

describe('assertDumpSize / formatBytes (puro)', () => {
  it('o piso fica abaixo do menor dump válido medido (17.085 B, só o schema) e acima de um arquivo vazio', () => {
    expect(MIN_DUMP_BYTES).toBeGreaterThan(1024);
    expect(MIN_DUMP_BYTES).toBeLessThan(17085);
  });

  it('aceita do piso para cima', () => {
    expect(() => assertDumpSize(MIN_DUMP_BYTES)).not.toThrow();
    expect(() => assertDumpSize(17085)).not.toThrow();
    expect(() => assertDumpSize(50 * 1024 * 1024)).not.toThrow();
  });

  it.each([0, 1, 512, MIN_DUMP_BYTES - 1, NaN, undefined, null, -5])('recusa %s', (valor) => {
    expect(() => assertDumpSize(valor, '/tmp/x.dump')).toThrow(/parece vazio ou cortado\. Nada foi publicado/);
  });

  it('a mensagem diz o arquivo e o tamanho observado', () => {
    expect(() => assertDumpSize(10, '/tmp/x.dump')).toThrow('/tmp/x.dump saiu com 10 B');
  });

  it('formatBytes', () => {
    expect(formatBytes(10)).toBe('10 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('backup-postgres.mjs rodando de verdade com pg_dump falso', () => {
  let pasta;
  beforeAll(() => {
    pasta = mkdtempSync(join(tmpdir(), 'fake-pgdump-'));
    // pg_dump falso: grava N bytes no arquivo do --file; N vem de FAKE_DUMP_BYTES. Código de saída em FAKE_DUMP_RC.
    const fake = [
      '#!/usr/bin/env bash',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "--file" ]; then out="$2"; fi',
      '  shift',
      'done',
      'head -c "${FAKE_DUMP_BYTES:-0}" /dev/zero > "$out"',
      'exit "${FAKE_DUMP_RC:-0}"',
      '',
    ].join('\n');
    writeFileSync(join(pasta, 'pg_dump'), fake);
    chmodSync(join(pasta, 'pg_dump'), 0o755);
  });
  afterAll(() => rmSync(pasta, { recursive: true, force: true }));

  function rodar(bytes, rc = 0) {
    const out = join(pasta, `saida-${bytes}-${rc}.dump`);
    const r = spawnSync('node', [SCRIPT, out], {
      env: {
        PATH: `${pasta}:${process.env.PATH}`,
        DATABASE_URL: 'postgresql://u:p@localhost:1/x',
        FAKE_DUMP_BYTES: String(bytes),
        FAKE_DUMP_RC: String(rc),
      },
      encoding: 'utf8',
    });
    return { status: r.status, saida: `${r.stdout}${r.stderr}`, out };
  }

  it('dump de tamanho normal: sucesso e o tamanho aparece no log', () => {
    const r = rodar(20000);
    expect(r.status).toBe(0);
    expect(r.saida).toContain('salvo em');
    expect(r.saida).toContain('19.5 KB');
    expect(statSync(r.out).size).toBe(20000);
  });

  it('dump vazio (pg_dump "terminou bem" mas escreveu 0 bytes): o job FALHA', () => {
    const r = rodar(0);
    expect(r.status).toBe(1);
    expect(r.saida).toContain('parece vazio ou cortado');
    expect(r.saida).not.toContain('salvo em');
  });

  it('dump cortado (abaixo do piso): o job FALHA', () => {
    const r = rodar(MIN_DUMP_BYTES - 1);
    expect(r.status).toBe(1);
    expect(r.saida).toContain('parece vazio ou cortado');
  });

  it('pg_dump com código de saída diferente de 0 continua falhando (comportamento anterior)', () => {
    const r = rodar(20000, 3);
    expect(r.status).toBe(1);
    expect(r.saida).toContain('pg_dump saiu com código 3');
  });

  // Prova de mutação: sem a chamada, o dump vazio voltaria a passar — o estado anterior a este PR.
  it('MUTAÇÃO: sem a conferência de tamanho no main(), o dump vazio passa (o teste acima não é vácuo)', () => {
    const original = readFileSync(SCRIPT, 'utf8');
    const mutado = original.replace('assertDumpSize(bytes, outPath);', '');
    expect(mutado).not.toBe(original);
    // Fica ao lado do original (imports relativos continuam valendo); apagado no fim.
    const arq = join(process.cwd(), 'scripts', '.backup-postgres.mutado.tmp.mjs');
    writeFileSync(arq, mutado);
    try {
      const out = join(pasta, 'saida-mutado.dump');
      const r = spawnSync('node', [arq, out], {
        env: {
          PATH: `${pasta}:${process.env.PATH}`,
          DATABASE_URL: 'postgresql://u:p@localhost:1/x',
          FAKE_DUMP_BYTES: '0',
          FAKE_DUMP_RC: '0',
        },
        encoding: 'utf8',
      });
      // O guard `isMainModule` compara com process.argv[1], que aqui é o arquivo mutado: roda o main().
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(true);
    } finally {
      rmSync(arq, { force: true });
    }
  });
});
