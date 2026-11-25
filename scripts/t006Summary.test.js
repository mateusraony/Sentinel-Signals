import { describe, it, expect } from 'vitest';
import { summarizeT006, checkReproduction } from './t006Summary.js';
import { opsFromReport } from './t004Summary.js';

const rep = (rs, sym = 'BTCUSDT') => ({ overall: { curve: rs.map((r, i) => ({ op: { symbol: sym, candle_open_time: `2026-0${(i % 9) + 1}-01T00:00:00Z`, side: 'BUY' }, r })) } });
const win = (b, bOff, a, aOn) => ({ B_producao: rep(b), B_sem_protecao: rep(bOff), A_modo_pine: rep(a), A_com_protecao: rep(aOn) });

describe('summarizeT006', () => {
  it('PRIMÁRIO = sem proteção − com proteção (B); ESPELHO = modo Pine − com proteção (A)', () => {
    const w = win([0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2], [1, 1, 1, 1]);
    const out = summarizeT006({ W1: w, W2: w });
    expect(out.windows[0].primario.diff).toBeCloseTo(1, 10);
    expect(out.windows[0].espelho.diff).toBeCloseTo(1, 10);
  });
  it('desligar: só com PRIMÁRIO > 0,05 nas duas janelas e IC95 acima de zero em ambas', () => {
    const forte = win([0, 0.1, 0, 0.1, 0, 0.1], [1, 1.1, 1, 1.1, 1, 1.1], [0], [0]);
    expect(summarizeT006({ W1: forte, W2: forte }).verdict).toBe('desligar_a_protecao');
  });
  it('manter: PRIMÁRIO <= 0 em QUALQUER janela', () => {
    const pos = win([0, 0, 0], [1, 1, 1], [0], [0]);
    const neg = win([1, 1, 1], [0, 0, 0], [0], [0]);
    expect(summarizeT006({ W1: pos, W2: neg }).verdict).toBe('manter_a_protecao');
  });
  it('inconclusivo: positivo mas com IC cruzando zero', () => {
    const ruido = win([0, 3, -3, 2, -2, 1], [0.2, 3.2, -2.8, 2.2, -1.8, 1.2], [0], [0]);
    expect(summarizeT006({ W1: ruido, W2: ruido }).verdict).toBe('inconclusivo');
  });
  it('o texto traz as duas tabelas, o veredito e a oscilação (desvio de R)', () => {
    const w = win([1, -1, 2, -2], [0.5, -0.5, 1, -1], [1], [1]);
    const { markdown } = summarizeT006({ W1: w, W2: w });
    expect(markdown).toMatch(/PRIMÁRIO/);
    expect(markdown).toMatch(/ESPELHO/);
    expect(markdown).toMatch(/Veredito pela regra pré-registrada/);
    expect(markdown).toMatch(/Oscilação de R/);
  });
});

describe('checkReproduction (os braços do T-2026-004 devem reproduzir)', () => {
  const opsByArm = { A_modo_pine: opsFromReport(rep([1, 1, -1, 0.5])), B_producao: opsFromReport(rep([0.1, 0.1])) };
  it('mesmo N e mesmo R/op: ok', () => {
    const r = checkReproduction('W1', opsByArm, { W1: { A_modo_pine: { n: 4, expectancia_R: 0.375 }, B_producao: { n: 2, expectancia_R: 0.1 } } });
    expect(r.every((x) => x.ok)).toBe(true);
  });
  it('N ou R/op diferente: não reproduziu, e o resumo avisa', () => {
    const r = checkReproduction('W1', opsByArm, { W1: { A_modo_pine: { n: 5, expectancia_R: 0.375 } } });
    expect(r[0].ok).toBe(false);
    const w = win([1], [1], [1], [1]);
    const out = summarizeT006({ W1: w }, { W1: { A_modo_pine: { n: 99, expectancia_R: 9 } } });
    expect(out.markdown).toMatch(/NÃO reproduziu/);
  });
});
