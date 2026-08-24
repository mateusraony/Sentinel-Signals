import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './writeJsonAtomic.mjs';

let tmpDir;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe('writeJsonAtomic', () => {
  it('escreve JSON válido, legível de volta', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wja-'));
    const outFile = path.join(tmpDir, 'out.json');
    writeJsonAtomic(outFile, [{ a: 1 }, { a: 2 }]);
    expect(JSON.parse(fs.readFileSync(outFile, 'utf-8'))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('não deixa arquivo temporário para trás após sucesso', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wja-'));
    const outFile = path.join(tmpDir, 'out.json');
    writeJsonAtomic(outFile, { x: 1 });
    expect(fs.readdirSync(tmpDir)).toEqual(['out.json']);
  });

  it('sobrescreve um outFile já existente (rename atômico substitui, não anexa)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wja-'));
    const outFile = path.join(tmpDir, 'out.json');
    writeJsonAtomic(outFile, { v: 1 });
    writeJsonAtomic(outFile, { v: 2 });
    expect(JSON.parse(fs.readFileSync(outFile, 'utf-8'))).toEqual({ v: 2 });
    expect(fs.readdirSync(tmpDir)).toEqual(['out.json']);
  });
});
