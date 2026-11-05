// Resumo por scan nos logs (pedido do usuário, 05/11/2026). O que se prova:
//  - cada transição vira o contador certo (TP1/TP2/stop/tempo/chop/invalidada/atualização/descartada pelo CAS) e a
//    criação conta só quando `created === true`;
//  - o embrulho em `backend.tradeOps` NÃO muda retorno, exceção nem argumentos, e `restore` devolve o original;
//  - a linha só tem contagens e códigos de motivo curtos: um segredo plantado no erro, uma URL, um preço ou um id de
//    operação NUNCA chegam ao log (o repositório é PÚBLICO — o log do Actions é legível sem login);
//  - passada com lock ocupado aparece como `lock=ocupado` (era invisível: "0 ativo(s)" parecia uma passada normal);
//  - entrada ruim não lança.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OPS_FIELDS, MAX_FUNNEL_CODES, MAX_LINE_LENGTH, emptyOpsCounts, sanitizeCode, classifyTransition,
  instrumentTradeOps, summarizeScanPass, formatScanSummary,
} from './scanSummary.mjs';

const SEGREDO = 'postgres://usuario:SENHA-SECRETA-123@ep-teste.neon.tech/db';

describe('classifyTransition', () => {
  const casos = [
    ['SIGNAL_CONFIRMED', { status: 'RUNNER_ACTIVE' }, 'tp1'],
    ['RUNNER_ACTIVE', { status: 'TP2_HIT' }, 'tp2'],
    ['SIGNAL_CONFIRMED', { status: 'STOP_HIT' }, 'stop'],
    ['RUNNER_ACTIVE', { status: 'STOP_HIT' }, 'stop'],
    ['RUNNER_ACTIVE', { status: 'INVALIDATED' }, 'invalidadas'],
    ['SIGNAL_CONFIRMED', { status: 'CLOSED', closed_reason: 'TIME_STOP' }, 'tempo'],
    ['SIGNAL_CONFIRMED', { status: 'CLOSED', closed_reason: 'CHOP_EXIT' }, 'chop'],
    ['SIGNAL_CONFIRMED', { status: 'CLOSED', closed_reason: 'INVALIDATION' }, 'invalidadas'],
    ['SIGNAL_CONFIRMED', { status: 'CLOSED', closed_reason: 'TP1_FULL' }, 'outras_saidas'],
    ['SIGNAL_CONFIRMED', { status: 'CLOSED' }, 'outras_saidas'],
    ['RUNNER_ACTIVE', { status: 'RUNNER_ACTIVE', current_stop: 1 }, 'atualizadas'], // mesmo status = rotina
    ['SIGNAL_CONFIRMED', { current_stop: 1, mfe_r: 0.4 }, 'atualizadas'], // sem status
    ['SIGNAL_CONFIRMED', { promotion_status: 'EXPIRED' }, 'atualizadas'],
    ['SIGNAL_CONFIRMED', { status: 'ALGO_NOVO' }, 'atualizadas'],
  ];
  it.each(casos)('%s + %j → %s', (from, patch, esperado) => {
    expect(classifyTransition(from, patch)).toBe(esperado);
  });
  it('patch inválido não lança', () => {
    for (const patch of [undefined, null, 7, 'x', []]) expect(classifyTransition('SIGNAL_CONFIRMED', patch)).toBe('atualizadas');
  });
});

describe('sanitizeCode — nada vindo do scanner é impresso como está', () => {
  it('aceita código curto em snake_case e põe em minúsculas', () => {
    expect(sanitizeCode('regime_rejected')).toBe('regime_rejected');
    expect(sanitizeCode('  No_Trigger ')).toBe('no_trigger');
  });
  it('texto livre, URL, espaço, quebra de linha, vazio, longo demais e não-string viram codigo_invalido', () => {
    for (const x of [SEGREDO, 'regime rejected', 'a\nb', '', 'x'.repeat(41), 7, null, undefined, {}, 'a-b']) {
      expect(sanitizeCode(x)).toBe('codigo_invalido');
    }
  });
});

describe('instrumentTradeOps', () => {
  const novo = () => {
    const chamadas = [];
    const tradeOps = {
      createTradeOpIfNoneActive: async (...args) => { chamadas.push(['create', args]); return tradeOps._create; },
      transitionTradeOp: async (...args) => { chamadas.push(['transition', args]); return tradeOps._transition; },
      clearActiveOp: async () => 'intocada',
      _create: { created: true, doc: { id: 'x' } },
      _transition: { applied: true, patch: {} },
    };
    return { tradeOps, chamadas };
  };

  it('conta operação aberta só quando created === true', async () => {
    const { tradeOps } = novo();
    const t = instrumentTradeOps(tradeOps);
    await tradeOps.createTradeOpIfNoneActive('a', 'id1', {}, '4h_15m');
    tradeOps._create = { created: false, existingId: 'z' };
    await tradeOps.createTradeOpIfNoneActive('a', 'id2', {}, '4h_15m');
    expect(t.snapshot().abertas).toBe(1);
  });

  it('conta cada transição aplicada no contador certo e a descartada pelo CAS à parte', async () => {
    const { tradeOps } = novo();
    const t = instrumentTradeOps(tradeOps);
    const faz = async (from, patch, res) => { tradeOps._transition = res; await tradeOps.transitionTradeOp('op', from, patch, { assetId: 'a' }); };
    await faz('SIGNAL_CONFIRMED', { status: 'RUNNER_ACTIVE' }, { applied: true });
    await faz('RUNNER_ACTIVE', { status: 'STOP_HIT' }, { applied: true });
    await faz('RUNNER_ACTIVE', { current_stop: 2 }, { applied: true });
    await faz('RUNNER_ACTIVE', { current_stop: 3 }, { applied: true });
    await faz('RUNNER_ACTIVE', { status: 'TP2_HIT' }, { applied: false, currentStatus: 'STOP_HIT' });
    const c = t.snapshot();
    expect(c).toMatchObject({ tp1: 1, stop: 1, atualizadas: 2, cas_descartadas: 1, tp2: 0, abertas: 0 });
  });

  it('não muda argumentos, retorno nem `this` da função original', async () => {
    const { tradeOps, chamadas } = novo();
    instrumentTradeOps(tradeOps);
    const opts = { assetId: 'a' };
    const patch = { status: 'STOP_HIT' };
    const r = await tradeOps.transitionTradeOp('op1', 'RUNNER_ACTIVE', patch, opts);
    expect(r).toBe(tradeOps._transition);
    expect(chamadas[0][1][0]).toBe('op1');
    expect(chamadas[0][1][2]).toBe(patch);
    expect(chamadas[0][1][3]).toBe(opts);
  });

  it('a exceção original continua subindo e não é contada', async () => {
    const tradeOps = { transitionTradeOp: async () => { throw new Error('banco caiu'); } };
    const t = instrumentTradeOps(tradeOps);
    await expect(tradeOps.transitionTradeOp('op', 'X', {})).rejects.toThrow('banco caiu');
    expect(t.snapshot()).toEqual(emptyOpsCounts());
  });

  it('retorno estranho (undefined, texto) não quebra a contagem nem o scan', async () => {
    const tradeOps = { transitionTradeOp: async () => undefined, createTradeOpIfNoneActive: async () => 'ok' };
    const t = instrumentTradeOps(tradeOps);
    expect(await tradeOps.transitionTradeOp('op', 'X', {})).toBeUndefined();
    expect(await tradeOps.createTradeOpIfNoneActive('a', 'b', {})).toBe('ok');
    expect(t.snapshot()).toEqual(emptyOpsCounts());
  });

  it('restore devolve as funções originais; funções ausentes são ignoradas', async () => {
    const { tradeOps } = novo();
    const origCreate = tradeOps.createTradeOpIfNoneActive;
    const t = instrumentTradeOps(tradeOps);
    expect(tradeOps.createTradeOpIfNoneActive).not.toBe(origCreate);
    t.restore();
    expect(tradeOps.createTradeOpIfNoneActive).toBe(origCreate);
    expect(() => instrumentTradeOps({}).snapshot()).not.toThrow();
    expect(() => instrumentTradeOps(null).snapshot()).not.toThrow();
  });

  it('o snapshot é uma cópia: mexer nele não altera a contagem', async () => {
    const { tradeOps } = novo();
    const t = instrumentTradeOps(tradeOps);
    const s = t.snapshot();
    s.abertas = 99;
    expect(t.snapshot().abertas).toBe(0);
  });
});

describe('summarizeScanPass', () => {
  const ativo = (symbol, persistedSignals, reasons = [], success = true) => ({
    symbol, success, persisted: { persistedSignals, entryFunnelOutcomes: reasons.map((reason) => ({ dedup_key: `${symbol}_k`, cascade: '4h_15m', reason })) },
  });

  it('passada normal: ativos ok, sinais novos e funil por motivo', () => {
    const s = summarizeScanPass({
      scanResult: { total: 3, results: [ativo('BTCUSDT', 1, ['regime_rejected']), ativo('ETHUSDT', 0, ['regime_rejected', 'no_trigger']), ativo('SOLUSDT', 0)] },
      priceCheckResult: { errors: [] },
      ops: { ...emptyOpsCounts(), abertas: 1, atualizadas: 2 },
    });
    expect(s).toMatchObject({ lock: 'ok', assetsTotal: 3, assetsOk: 3, assetsFailed: 0, newSignals: 1, priceCheck: 'ok' });
    expect(s.funnel).toEqual([['regime_rejected', 2], ['no_trigger', 1]]);
    expect(s.ops).toMatchObject({ abertas: 1, atualizadas: 2 });
  });

  it('lock ocupado (a passada de ~1 s com "0 ativo(s)") aparece como lock=ocupado', () => {
    const s = summarizeScanPass({ scanResult: { total: 0, results: [], skipped: true }, priceCheckResult: { errors: [] }, ops: emptyOpsCounts() });
    expect(s.lock).toBe('ocupado');
    expect(formatScanSummary(s)).toContain('lock=ocupado');
  });

  it('falha de ativo conta à parte; price-check pulado e com erros', () => {
    expect(summarizeScanPass({ scanResult: { total: 2, results: [ativo('A', 0), { symbol: 'B', success: false, error: 'boom' }] } }))
      .toMatchObject({ assetsOk: 1, assetsFailed: 1 });
    expect(summarizeScanPass({ priceCheckResult: { errors: [], skipped: true } }).priceCheck).toBe('pulado');
    expect(summarizeScanPass({ priceCheckResult: { errors: [{ error: 'a' }, { error: 'b' }] } }).priceCheck).toBe('erros:2');
  });

  it('mais de 8 motivos: os mais frequentes aparecem, o resto soma em "demais"', () => {
    const motivos = [];
    for (let i = 0; i < 12; i += 1) for (let k = 0; k <= i; k += 1) motivos.push(`motivo_${String(i).padStart(2, '0')}`);
    const s = summarizeScanPass({ scanResult: { total: 1, results: [ativo('A', 0, motivos)] } });
    expect(s.funnel.length).toBe(MAX_FUNNEL_CODES + 1);
    expect(s.funnel[0]).toEqual(['motivo_11', 12]);
    expect(s.funnel.at(-1)[0]).toBe('demais');
    expect(s.funnel.reduce((n, [, c]) => n + c, 0)).toBe(motivos.length); // nada se perde na soma
  });

  it('empate de contagem: ordem alfabética, independente da ordem em que os motivos chegaram', () => {
    const a = summarizeScanPass({ scanResult: { total: 1, results: [ativo('A', 0, ['zeta', 'alfa', 'meio'])] } });
    const b = summarizeScanPass({ scanResult: { total: 1, results: [ativo('A', 0, ['meio', 'zeta', 'alfa'])] } });
    expect(a.funnel.map(([c]) => c)).toEqual(['alfa', 'meio', 'zeta']);
    expect(b.funnel).toEqual(a.funnel);
  });

  it('motivo com texto livre/URL vira codigo_invalido (nunca é impresso como está)', () => {
    const s = summarizeScanPass({ scanResult: { total: 1, results: [ativo('A', 0, [SEGREDO, 'regime_rejected'])] } });
    expect(s.funnel).toContainEqual(['codigo_invalido', 1]);
    expect(JSON.stringify(s)).not.toContain('SENHA-SECRETA');
  });

  it('entrada ruim ou ausente não lança', () => {
    for (const x of [undefined, null, {}, { scanResult: 7 }, { scanResult: { results: [null, 3, 'x', {}] } }, { ops: { abertas: 'x', tp1: -4 } }]) {
      expect(() => summarizeScanPass(x)).not.toThrow();
    }
    expect(summarizeScanPass({ ops: { abertas: -3, tp1: NaN } }).ops.abertas).toBe(0);
  });
});

describe('formatScanSummary — a linha do log', () => {
  it('passada sem nada: linha curta e estável', () => {
    const s = summarizeScanPass({ scanResult: { total: 10, results: Array.from({ length: 10 }, (_, i) => ({ symbol: `A${i}`, success: true, persisted: { persistedSignals: 0, entryFunnelOutcomes: [] } })) }, priceCheckResult: { errors: [] }, ops: emptyOpsCounts() });
    expect(formatScanSummary(s)).toBe('[scan] resumo: lock=ok ativos_ok=10/10 sinais_novos=0 ops=nenhuma funil=nenhum price_check=ok');
  });

  it('passada com atividade: só os contadores não zerados aparecem', () => {
    const line = formatScanSummary({
      lock: 'ok', assetsTotal: 10, assetsOk: 9, assetsFailed: 1, newSignals: 2, priceCheck: 'ok',
      ops: { ...emptyOpsCounts(), abertas: 1, stop: 1, atualizadas: 3 },
      funnel: [['regime_rejected', 7], ['no_trigger', 3]],
    });
    expect(line).toBe('[scan] resumo: lock=ok ativos_ok=9/10 falhas=1 sinais_novos=2 ops{abertas=1 stop=1 atualizadas=3} funil{regime_rejected=7 no_trigger=3} price_check=ok');
  });

  it('SEGURANÇA (repo público): segredo no erro, URL, preço e id de operação nunca chegam à linha', () => {
    const s = summarizeScanPass({
      scanResult: {
        total: 1,
        results: [{
          symbol: 'BTCUSDT', success: false, error: `connect ECONNREFUSED ${SEGREDO}`,
          persisted: { persistedSignals: 0, entryFunnelOutcomes: [{ dedup_key: 'BTCUSDT_4h_1730000000000_BUY', cascade: '4h_15m', reason: SEGREDO }], entry_price: 67123.45, opId: 'op_BTCUSDT_BUY_1' },
        }],
      },
      priceCheckResult: { errors: [{ error: SEGREDO, symbol: 'ETHUSDT' }] },
      ops: emptyOpsCounts(),
    });
    const line = formatScanSummary(s);
    for (const proibido of ['SENHA-SECRETA', 'postgres://', 'neon.tech', 'ECONNREFUSED', 'BTCUSDT', 'ETHUSDT', '67123', 'op_', 'BUY', 'SELL', 'dedup']) {
      expect(line).not.toContain(proibido);
    }
    expect(line).toMatch(/^\[scan\] resumo: [\x20-\x7e]+$/); // uma linha, só ASCII imprimível
  });

  it('estado malformado não lança e cai em valores seguros', () => {
    for (const x of [undefined, null, {}, { lock: 'qualquer coisa', priceCheck: 'texto livre ' + SEGREDO, funnel: [['Ruim Código', 3], [7, 2], null] }]) {
      let line;
      expect(() => { line = formatScanSummary(x); }).not.toThrow();
      expect(line.startsWith('[scan] resumo: lock=ok')).toBe(true);
      expect(line).not.toContain('SENHA-SECRETA');
    }
    // o formatador também sanitiza o código por conta própria (não confia em quem montou o resumo)
    const ruim = formatScanSummary({ funnel: [['Ruim Código', 3], ['regime_rejected', 1]] });
    expect(ruim).toContain('funil{codigo_invalido=3 regime_rejected=1}');
    expect(ruim).not.toContain('Ruim');
  });

  it('a linha nunca passa do teto de tamanho', () => {
    const funnel = Array.from({ length: 200 }, (_, i) => [`motivo_muito_comprido_numero_${i}`, 999999]);
    const line = formatScanSummary({ lock: 'ok', assetsTotal: 10, assetsOk: 10, funnel, ops: Object.fromEntries(OPS_FIELDS.map((k) => [k, 999999])) });
    expect(line.length).toBeLessThanOrEqual(MAX_LINE_LENGTH);
  });
});

describe('o módulo é puro (mesma separação de healthAuditFormat.mjs)', () => {
  it('não importa nada: nem entidades/banco, nem firebase, nem pg, nem Telegram', () => {
    const src = readFileSync(new URL('./scanSummary.mjs', import.meta.url), 'utf8');
    const codigo = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(codigo).not.toMatch(/^\s*import\s/m);
    expect(codigo).not.toMatch(/\brequire\(/);
    expect(codigo).not.toMatch(/process\.env|fetch\(|Date\.now|new Date/);
  });
});

describe('ligação em scripts/run-scan.mjs', () => {
  const src = readFileSync(new URL('./run-scan.mjs', import.meta.url), 'utf8');
  it('importa o módulo puro e instala o contador DENTRO de main() (run-scan.test.mjs importa o arquivo com backend = {})', () => {
    expect(src).toMatch(/from '\.\/scanSummary\.mjs'/);
    const iMain = src.indexOf('async function main()');
    const iInstall = src.indexOf('instrumentTradeOps(backend.tradeOps)');
    expect(iMain).toBeGreaterThan(-1);
    expect(iInstall).toBeGreaterThan(iMain);
  });
  it('imprime o resumo dentro de try/catch não fatal, antes de "finished in"', () => {
    const iPrint = src.indexOf('formatScanSummary(summarizeScanPass(');
    const iFinished = src.indexOf('[scan] finished in');
    expect(iPrint).toBeGreaterThan(-1);
    expect(iPrint).toBeLessThan(iFinished);
    const antes = src.slice(Math.max(0, iPrint - 120), iPrint);
    expect(antes).toMatch(/try \{\s*console\.log\(\s*$/);
    const trecho = src.slice(iPrint, iFinished);
    expect(trecho).toMatch(/catch[\s\S]*não crítico/);
    // O texto da exceção NÃO vai para o log público (Codex, PR #541): mensagem fixa, nunca `err.message`.
    expect(trecho).not.toMatch(/\.message|\berr\b|\$\{/);
  });
  it('o resumo usa o objeto inteiro de scanAllAssets e de priceCheckActiveOps (lock ocupado e "pulado" não se perdem)', () => {
    expect(src).toMatch(/const scanResult = await withTimeout\(scanAllAssets\(\)/);
    expect(src).toMatch(/const priceCheckResult = await withTimeout\(priceCheckActiveOps\(\)/);
    expect(src).toMatch(/summarizeScanPass\(\{ scanResult, priceCheckResult, ops: opsTracker\.snapshot\(\) \}\)/);
  });
});

describe('de ponta a ponta (scanner simulado → linha do log)', () => {
  it('uma passada com sinal, TP1, stop, atualização e uma transição descartada vira UMA linha só com contagens', async () => {
    const tradeOps = {
      createTradeOpIfNoneActive: async () => ({ created: true, doc: { id: 'op1' } }),
      transitionTradeOp: async (id, from, patch) => (patch.status === 'TP2_HIT' ? { applied: false, currentStatus: 'STOP_HIT' } : { applied: true, patch }),
    };
    const t = instrumentTradeOps(tradeOps);
    await tradeOps.createTradeOpIfNoneActive('a1', 'op1', { entry_price: 100 }, '4h_15m');
    await tradeOps.transitionTradeOp('op1', 'SIGNAL_CONFIRMED', { status: 'RUNNER_ACTIVE' });
    await tradeOps.transitionTradeOp('op2', 'RUNNER_ACTIVE', { status: 'STOP_HIT', exit_price: 98 });
    await tradeOps.transitionTradeOp('op3', 'RUNNER_ACTIVE', { current_stop: 99 });
    await tradeOps.transitionTradeOp('op4', 'RUNNER_ACTIVE', { status: 'TP2_HIT' });
    const line = formatScanSummary(summarizeScanPass({
      scanResult: { total: 2, results: [
        { symbol: 'BTCUSDT', success: true, persisted: { persistedSignals: 1, entryFunnelOutcomes: [{ reason: 'regime_rejected' }] } },
        { symbol: 'ETHUSDT', success: true, persisted: { persistedSignals: 0, entryFunnelOutcomes: [] } },
      ] },
      priceCheckResult: { errors: [] },
      ops: t.snapshot(),
    }));
    expect(line).toBe('[scan] resumo: lock=ok ativos_ok=2/2 sinais_novos=1 ops{abertas=1 tp1=1 stop=1 atualizadas=1 cas_descartadas=1} funil{regime_rejected=1} price_check=ok');
    expect(line).not.toMatch(/98|100|BTC|ETH/);
  });
});
