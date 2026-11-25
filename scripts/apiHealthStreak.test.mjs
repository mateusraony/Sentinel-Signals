import { describe, it, expect } from 'vitest';
import { decideApiAlert, pingStepResult, alertText } from './apiHealthStreak.mjs';

const S = 'success';
const F = 'failure';

describe('decideApiAlert (mais nova primeiro)', () => {
  it('avisa "down" exatamente na 3ª falha seguida e só ali', () => {
    expect(decideApiAlert([F, S, S]).action).toBe('none'); // 1ª falha
    expect(decideApiAlert([F, F, S]).action).toBe('none'); // 2ª
    expect(decideApiAlert([F, F, F, S])).toMatchObject({ action: 'down', streak: 3 });
    expect(decideApiAlert([F, F, F, F, S]).action).toBe('none'); // 4ª: já avisou
    expect(decideApiAlert([F, F, F, F, F, F, F, F, F, F]).action).toBe('none'); // queda longa: sem repetir
  });
  it('3 falhas e nada mais velho na lista também conta (histórico curto)', () => {
    expect(decideApiAlert([F, F, F]).action).toBe('down');
  });
  it('avisa "up" no 1º sucesso depois de pelo menos 3 falhas seguidas', () => {
    expect(decideApiAlert([S, F, F, F, S])).toMatchObject({ action: 'up', previousStreak: 3 });
    expect(decideApiAlert([S, F, F, F, F, F, F, F])).toMatchObject({ action: 'up', previousStreak: 7 });
    expect(decideApiAlert([S, F, F, S]).action).toBe('none'); // só 2 falhas: nem chegou a avisar a queda
    expect(decideApiAlert([S, S, F, F, F]).action).toBe('none'); // o 2º sucesso seguido não repete o aviso
  });
  it('pings pulados (fora da janela do dia) e cancelados são IGNORADOS: não quebram a sequência', () => {
    expect(decideApiAlert([F, null, F, 'skipped', F, S]).action).toBe('down');
    expect(decideApiAlert([S, null, F, 'skipped', F, 'cancelled', F]).action).toBe('up');
  });
  it('sem dado: nada a fazer', () => {
    expect(decideApiAlert([]).action).toBe('none');
    expect(decideApiAlert([null, 'skipped']).action).toBe('none');
  });
  it('o limite é configurável', () => {
    expect(decideApiAlert([F, F, S], 2).action).toBe('down');
  });
});

describe('pingStepResult', () => {
  const jobs = (conclusion) => [{ name: 'ping', steps: [{ name: 'Janela do dia', conclusion: 'success' }, { name: 'Ping /health', conclusion }] }];
  it('lê a conclusão do passo do ping', () => {
    expect(pingStepResult(jobs('failure'))).toBe('failure');
    expect(pingStepResult(jobs('skipped'))).toBe('skipped');
  });
  it('sem o job ou sem o passo: null', () => {
    expect(pingStepResult([])).toBeNull();
    expect(pingStepResult([{ name: 'outro', steps: [] }])).toBeNull();
    expect(pingStepResult(undefined)).toBeNull();
  });
});

describe('alertText', () => {
  it('queda cita a contagem e o item 309; volta é curto', () => {
    const d = alertText('down', 3);
    expect(d.title).toMatch(/FORA DO AR/);
    expect(d.hint).toMatch(/3 pings/);
    expect(d.hint).toMatch(/item 309/);
    expect(alertText('up', 0).title).toMatch(/VOLTOU/);
  });
});
