// docs/known-risks.md item 275 — relatório diário da regra EMA 10/21 +
// Supertrend(10,3). Só acompanha; os testes garantem que ele usa a MESMA regra
// do pré-registro do tempo novo (item 274), só velas fechadas, e que o
// andamento é a conta anunciada.
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { buildDays, dailySignals } from './dailyTrend.mjs';
import { buildDailyRuleReport, progressOf, formatDailyRuleTelegram, formatDailyRuleMarkdown } from './dailyRuleReport.mjs';
import { mulberry32 } from '../src/lib/seededRandom.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREREG_PATH = resolve(__dirname, '../docs/experiments/daily-ema-supertrend-forward-prereg.json');
const PREREG = JSON.parse(readFileSync(PREREG_PATH, 'utf8'));
const DAY = 24 * 60 * 60 * 1000;
const PARAMS = { emaFast: PREREG.emaFast, emaSlow: PREREG.emaSlow, stAtrPeriod: PREREG.stAtrPeriod, stFactor: PREREG.stFactor };

// Passeio aleatório diário a partir de fromMs (velas inteiras de 00:00 UTC).
function walk(seed, fromMs, n) {
  const rand = mulberry32(seed);
  let price = 100;
  return Array.from({ length: n }, (_, i) => {
    const open = price;
    price *= 1 + (rand() - 0.5) * 0.08;
    const high = Math.max(open, price) * (1 + rand() * 0.02);
    const low = Math.min(open, price) * (1 - rand() * 0.02);
    return { openTime: fromMs + i * DAY, closeTime: fromMs + (i + 1) * DAY - 1, open, high, low, close: price, volume: 1 };
  });
}

const FROM = Date.parse('2026-01-01T00:00:00.000Z');
// Relatório rodando às 00:23 UTC: a última vela fechada é a de ontem.
const at = (isoDay) => Date.parse(`${isoDay}T00:23:00.000Z`);
const candlesUntil = (seed, nowMs) => walk(seed, FROM, Math.floor(nowMs / DAY) - FROM / DAY);
const marketAt = (nowMs) => Object.fromEntries(PREREG.primarySymbols.map((s, i) => [s, candlesUntil(100 + i, nowMs)]));

describe('mesma regra do pré-registro do tempo novo (item 274)', () => {
  it('o estado de cada moeda é o último dailySignals com os parâmetros do pré-registro', () => {
    const nowMs = at('2026-11-20');
    const market = marketAt(nowMs);
    const r = buildDailyRuleReport(market, PREREG, { nowMs });
    expect([PREREG.emaFast, PREREG.emaSlow, PREREG.stAtrPeriod, PREREG.stFactor, PREREG.costBpsPerSide]).toEqual([10, 21, 10, 3, 6]);
    expect(r.coins).toHaveLength(19);
    for (const c of r.coins) {
      const days = buildDays(market[c.symbol], { endMs: nowMs });
      expect(c.status).toBe('ok');
      expect(c.state).toBe(dailySignals(days, PARAMS).at(-1));
    }
    expect(r.long.length + r.flat.length).toBe(19);
    expect(r.asOf).toBe('2026-11-19');
  });

  it('vela ainda aberta (closeTime depois de agora) é ignorada', () => {
    const nowMs = at('2026-11-20');
    const market = marketAt(nowMs);
    const base = buildDailyRuleReport(market, PREREG, { nowMs });
    const withOpen = Object.fromEntries(Object.entries(market).map(([s, c]) => {
      const last = c.at(-1);
      // A vela de hoje, em formação, com um fechamento absurdo: não pode mudar nada.
      return [s, [...c, { ...last, openTime: last.openTime + DAY, closeTime: last.closeTime + DAY, close: last.close * 3, high: last.close * 3 }]];
    }));
    expect(buildDailyRuleReport(withOpen, PREREG, { nowMs })).toEqual(base);
  });

  it('troca de estado aparece em "entrou"/"saiu" no dia em que acontece', () => {
    const candles = walk(7, FROM, 400);
    const signals = dailySignals(candles, PARAMS);
    const flip = signals.findIndex((s, i) => i > 200 && s !== null && signals[i - 1] !== null && s !== signals[i - 1]);
    expect(flip).toBeGreaterThan(0);
    const nowMs = candles[flip].closeTime + 1 + 23 * 60 * 1000;
    const r = buildDailyRuleReport({ BTCUSDT: candles }, PREREG, { nowMs });
    const btc = r.coins.find((c) => c.symbol === 'BTCUSDT');
    expect(btc.changed).toBe(true);
    expect(signals[flip] === 1 ? r.entered : r.exited).toEqual(['BTCUSDT']);
    // No dia seguinte, sem nova troca, não aparece de novo.
    if (signals[flip + 1] === signals[flip]) {
      const next = buildDailyRuleReport({ BTCUSDT: candles }, PREREG, { nowMs: nowMs + DAY });
      expect([...next.entered, ...next.exited]).toEqual([]);
    }
  });
});

describe('vela atrasada não vira troca de hoje (review do Codex, PR #501)', () => {
  it('se as velas param logo depois de uma troca, a troca não se repete nos dias seguintes', () => {
    const candles = walk(7, FROM, 400);
    const signals = dailySignals(candles, PARAMS);
    const flip = signals.findIndex((s, i) => i > 200 && s !== null && signals[i - 1] !== null && s !== signals[i - 1]);
    const stopped = candles.slice(0, flip + 1); // ex.: moeda deslistada logo depois da troca
    const dayAfter = candles[flip].closeTime + 1 + DAY + 23 * 60 * 1000;
    const r = buildDailyRuleReport({ BTCUSDT: stopped }, PREREG, { nowMs: dayAfter });
    expect(r.stale).toEqual(['BTCUSDT']);
    expect(r.coins.find((c) => c.symbol === 'BTCUSDT').changed).toBe(false);
    expect([...r.entered, ...r.exited]).toEqual([]);
  });
});

describe('avisos', () => {
  it('sem dado, vela de ontem faltando e histórico curto', () => {
    const nowMs = at('2026-11-20');
    const market = marketAt(nowMs);
    delete market.ETHUSDT;
    market.SOLUSDT = market.SOLUSDT.slice(0, -1);
    market.ONDOUSDT = market.ONDOUSDT.slice(-60);
    const r = buildDailyRuleReport(market, PREREG, { nowMs });
    expect(r.noData).toEqual(['ETHUSDT']);
    expect(r.stale).toEqual(['SOLUSDT']);
    expect(r.warming).toEqual(['ONDOUSDT']);
    expect(r.long.length + r.flat.length).toBe(17);
    const msg = formatDailyRuleTelegram(r);
    expect(msg).toContain('Sem dado: ETH');
    expect(msg).toContain('Vela de ontem ainda não chegou: SOL');
    expect(msg).toContain('Histórico curto demais: ONDO');
  });
});

describe('andamento (só acompanha)', () => {
  it('antes do 1º dia do período não há andamento', () => {
    const nowMs = at('2026-10-17');
    const r = buildDailyRuleReport(marketAt(nowMs), PREREG, { nowMs });
    expect(r.progress).toBeNull();
    expect(formatDailyRuleTelegram(r)).toContain('Começa a contar depois do fechamento de 17/10/2026.');
  });

  it('a partir do fechamento de 17/10 conta os dias do período', () => {
    const nowMs = at('2026-10-21');
    const r = buildDailyRuleReport(marketAt(nowMs), PREREG, { nowMs });
    expect(r.progress.days).toBe(4); // 17, 18, 19 e 20/10
  });

  it('conta calculada à mão: 2 moedas, 3 dias, custo partindo de fora', () => {
    const cost = 0.0006;
    const series = [
      { symbol: 'A', entries: [{ weekStart: 0, pos: 1, ret: 0.10 }, { weekStart: DAY, pos: 1, ret: -0.05 }, { weekStart: 2 * DAY, pos: 0, ret: 0.02 }] },
      { symbol: 'B', entries: [{ weekStart: 0, pos: 0, ret: 0.04 }, { weekStart: DAY, pos: 1, ret: 0.01 }, { weekStart: 2 * DAY, pos: 1, ret: -0.03 }] },
    ];
    const p = progressOf(series, cost);
    // Regra: dia 1 = (0,10 − entrada de A + 0) / 2; dia 2 = (−0,05 + 0,01 − entrada de B) / 2;
    // dia 3 = (−saída de A − 0,03) / 2.
    const rule = (1 + (0.10 - cost) / 2) * (1 + (-0.05 + 0.01 - cost) / 2) * (1 + (-cost - 0.03) / 2) - 1;
    // Comprar e segurar: as duas entram no dia 1 e ficam.
    const hold = (1 + (0.10 - cost + 0.04 - cost) / 2) * (1 + (-0.05 + 0.01) / 2) * (1 + (0.02 - 0.03) / 2) - 1;
    expect(p.days).toBe(3);
    expect(p.ruleReturn).toBeCloseTo(rule, 12);
    expect(p.buyHoldReturn).toBeCloseTo(hold, 12);
    expect(p.exposure).toBeCloseTo((0.5 + 1 + 0.5) / 3, 12);
  });
});

describe('mensagem', () => {
  it('com as 19 moedas cabe no limite do Telegram e traz o essencial', () => {
    const nowMs = at('2026-12-01');
    const r = buildDailyRuleReport(marketAt(nowMs), PREREG, { nowMs });
    const msg = formatDailyRuleTelegram(r);
    expect(msg.length).toBeLessThan(4096);
    expect(msg).toContain('Fechamento de 30/11/2026 (UTC) · vale para 01/12/2026');
    expect(msg).toContain(`<b>Comprado (${r.long.length}):</b>`);
    expect(msg).toContain('Andamento desde 17/10/2026');
    expect(msg).toContain('nenhuma ordem é enviada');
    expect(formatDailyRuleMarkdown(r)).toContain('| Moeda | Estado | Troca hoje | Última vela | Fechamento |');
  });
});

describe('CLI', () => {
  const run = (args, env = {}) => {
    const clean = { ...process.env, ...env };
    delete clean.TELEGRAM_BOT_TOKEN;
    delete clean.TELEGRAM_CHAT_ID;
    return spawnSync(process.execPath, [resolve(__dirname, 'daily-rule-report.mjs'), ...args], { env: clean, encoding: 'utf8' });
  };

  it('sem --send imprime o resumo; com --send e sem Telegram configurado, falha sem enviar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daily-rule-'));
    try {
      const nowMs = at('2026-11-20');
      for (const [s, c] of Object.entries(marketAt(nowMs))) writeFileSync(join(dir, `${s}_1d.json`), JSON.stringify(c));
      const ok = run(['--data-dir', dir, '--now', new Date(nowMs).toISOString()]);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('Regra diária EMA 10/21 + Supertrend — fechamento de 19/11/2026');
      const send = run(['--data-dir', dir, '--now', new Date(nowMs).toISOString(), '--send']);
      expect(send.status).toBe(1);
      expect(send.stderr).toContain('Telegram não configurado');
      const empty = run(['--data-dir', join(dir, 'nada'), '--now', new Date(nowMs).toISOString()]);
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain('nenhuma moeda tem dado');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
