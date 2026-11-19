// Leitor da taxa de juros do Fed (NY Fed) — docs/known-risks.md item 285, addendum 36. FASE DE OBSERVAÇÃO: o formato é o pesquisado, ainda NÃO verificado no JSON bruto.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEffr, fetchPolicyRate, describePolicyRate, NYFED_EFFR_URL } from './contextRates.mjs';
import { main } from './context-collect.mjs';

const NOW = Date.parse('2026-11-19T15:00:00Z');
const body = (over = {}) => JSON.stringify({ refRates: [{ effectiveDate: '2026-11-18', type: 'EFFR', percentRate: 3.83, targetRateFrom: 3.75, targetRateTo: 4, ...over }] });

describe('parseEffr', () => {
  it('a faixa-alvo de 0,25 ponto e a taxa efetiva', () => {
    expect(parseEffr(body(), NOW)).toEqual({ date: '2026-11-18', from: 3.75, to: 4, effective: 3.83 });
    expect(parseEffr(body({ targetRateFrom: 0, targetRateTo: 0.25, percentRate: 0.08 }), NOW)).toMatchObject({ from: 0, to: 0.25 });
  });
  it('fora de qualquer conferência vira null — nunca um número duvidoso', () => {
    for (const over of [
      { targetRateTo: 4.1 }, // não é passo de 0,25
      { targetRateFrom: 3.85, targetRateTo: 4.1, percentRate: 3.9 }, // faixa de 0,25 mas fora dos passos de 0,25
      { targetRateFrom: 3.5 }, // faixa de 0,5
      { targetRateFrom: 4, targetRateTo: 3.75 }, // invertida
      { targetRateTo: 10.25, targetRateFrom: 10 }, // acima do teto de plausibilidade
      { targetRateFrom: null, targetRateTo: null }, // SOFR e outras linhas não trazem faixa
      { percentRate: 9 }, // taxa efetiva longe da faixa: outra série
      { percentRate: 'x' },
      { effectiveDate: '2026-11-08' }, // 11 dias: velha
      { effectiveDate: '2026-12-30' }, // no futuro
      { effectiveDate: 'ontem' },
    ]) expect(parseEffr(body(over), NOW), JSON.stringify(over)).toBeNull();
    for (const x of ['', 'x', '{}', '{"refRates":[]}', '{"refRates":["x"]}', null]) expect(parseEffr(x, NOW)).toBeNull();
  });
});

describe('fetchPolicyRate e describePolicyRate', () => {
  it('ok, HTTP de erro, formato errado e rede caída — só códigos, nunca texto de erro', async () => {
    let seen;
    const ok = await fetchPolicyRate({ fetchImpl: async (u) => { seen = u; return new Response(body()); }, nowMs: NOW });
    expect(seen).toBe(NYFED_EFFR_URL);
    expect(ok).toEqual({ rate: { date: '2026-11-18', from: 3.75, to: 4, effective: 3.83 }, reason: 'ok' });
    expect((await fetchPolicyRate({ fetchImpl: async () => new Response('x', { status: 503 }), nowMs: NOW })).reason).toBe('http');
    expect((await fetchPolicyRate({ fetchImpl: async () => new Response('{}'), nowMs: NOW })).reason).toBe('formato');
    expect(await fetchPolicyRate({ fetchImpl: async (u) => { throw new Error(`falha ${u}`); }, nowMs: NOW })).toEqual({ rate: null, reason: 'rede' });
  });
  it('a linha do resumo diz que é só observação e traz a faixa; a falha diz por quê', () => {
    expect(describePolicyRate({ rate: { date: '2026-11-18', from: 3.75, to: 4, effective: 3.83 }, reason: 'ok' }))
      .toBe('Juros do Fed (NY Fed, só observação: ainda NÃO entra no events.json nem no Telegram): faixa-alvo de 3,75% a 4,00% (limite superior 4,00%), taxa efetiva 3,83% em 2026-11-18.');
    expect(describePolicyRate({ rate: null, reason: 'formato' })).toMatch(/a resposta não está no formato esperado\.$/);
    expect(describePolicyRate(null)).toBeNull();
  });
});

describe('o coletor mostra a taxa no resumo, e o modo "janela" não consulta o Fed nem o NY Fed', () => {
  const run = async (env, fetchImpl, dir) => {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try { await main(['--dir', dir], env, { fetchImpl, now: () => NOW }); } finally { console.log = orig; }
    return logs.join('\n');
  };
  it('coleta normal: a linha dos juros aparece; ela NÃO vira evento nem entra no events.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-'));
    const out = await run({}, async (u) => (String(u) === NYFED_EFFR_URL ? new Response(body()) : new Response('x', { status: 500 })), dir);
    expect(out).toContain('faixa-alvo de 3,75% a 4,00%');
    expect(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')).not.toMatch(/3,75|4,00|targetRate/);
  });
  it('janela: com um CPI esperando o número, nenhuma chamada vai ao Fed nem ao NY Fed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-'));
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify([{ id: 'CPI-2026-11-19', kind: 'CPI', reference: '2026-10', startsAtUtc: '2026-11-19T13:30:00.000Z', status: 'oficial', firstSeenAt: '2026-11-01T00:00:00.000Z', lastChangedAt: '2026-11-01T00:00:00.000Z', values: null }]));
    const urls = [];
    const out = await run({ COLLECT_MODE: 'janela' }, async (u) => { urls.push(String(u)); return new Response('x', { status: 500 }); }, dir);
    expect(out).not.toContain('Juros do Fed');
    expect(urls.some((u) => u.includes('federalreserve.gov') || u.includes('newyorkfed.org'))).toBe(false);
    expect(urls.length).toBeGreaterThan(0); // o coletor trabalhou (consultou as outras fontes)
  });
});
