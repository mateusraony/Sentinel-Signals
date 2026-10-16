// Relatório diário da regra EMA 10/21 + Supertrend(10,3) — docs/known-risks.md
// item 275. Parte pura (sem rede, sem Date.now); a CLI é
// scripts/daily-rule-report.mjs e o envio, scripts/adminTelegram.js.
//
// Só ACOMPANHA, não decide nada: a decisão de que a regra funciona saiu dos
// itens 271/272, e a confirmação em tempo novo é o teste pré-registrado do
// item 274 (só a partir de 2028-10-17). A regra e os parâmetros vêm do MESMO
// pré-registro de compra do item 274 (sem cópia), então o relatório não tem
// como divergir do que será testado.
import { buildDays, dailySignals, symbolDailySeries } from './dailyTrend.mjs';
import { escaparHtml } from '../src/lib/notificationTemplates.js';

const DAY = 24 * 60 * 60 * 1000;

const short = (symbol) => symbol.replace(/USDT$/, '');
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const brDay = (ms) => { const [y, m, d] = isoDay(ms).split('-'); return `${d}/${m}/${y}`; };
const pct = (x) => `${x >= 0 ? '+' : '−'}${(Math.abs(x) * 100).toFixed(1).replace('.', ',')}%`;

/**
 * Andamento desde o início pré-registrado: carteira de peso igual entre as
 * moedas com dia válido, rebalanceada todo dia. Custo por lado a cada troca,
 * partindo de FORA (prev = 0) — quem começou a seguir no 1º dia pagou a
 * entrada. O teste de 2028 usa o custo circular de scripts/weeklyTrend.mjs
 * (necessário para a nula); a diferença é no máximo uma troca por moeda,
 * desprezível num número que só acompanha.
 * @param {{ symbol: string, entries: { weekStart: number, pos: number, ret: number }[] }[]} series
 */
export function progressOf(series, costPerSide) {
  const byDay = new Map();
  for (const { entries } of series) {
    let prevRule = 0;
    let prevHold = 0;
    for (const e of entries) {
      const acc = byDay.get(e.weekStart) || { rule: 0, hold: 0, exposure: 0, count: 0 };
      acc.rule += e.pos * e.ret - costPerSide * Math.abs(e.pos - prevRule);
      acc.hold += e.ret - costPerSide * Math.abs(1 - prevHold);
      acc.exposure += e.pos;
      acc.count += 1;
      byDay.set(e.weekStart, acc);
      prevRule = e.pos;
      prevHold = 1;
    }
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a - b).map(([, a]) => a);
  if (!days.length) return null;
  const compound = (key) => days.reduce((eq, a) => eq * (1 + a[key] / a.count), 1) - 1;
  return {
    days: days.length,
    ruleReturn: compound('rule'),
    buyHoldReturn: compound('hold'),
    exposure: days.reduce((s, a) => s + a.exposure / a.count, 0) / days.length,
  };
}

/**
 * @param {Record<string, object[]>} dailyBySymbol velas diárias por símbolo
 * @param {object} prereg docs/experiments/daily-ema-supertrend-forward-prereg.json
 * @param {{ nowMs: number }} options instante do relatório (só velas fechadas até ele contam)
 */
export function buildDailyRuleReport(dailyBySymbol, prereg, { nowMs }) {
  const params = { emaFast: prereg.emaFast, emaSlow: prereg.emaSlow, stAtrPeriod: prereg.stAtrPeriod, stFactor: prereg.stFactor };
  const startMs = Date.parse(prereg.start);
  const endMs = Math.min(nowMs, Date.parse(prereg.end));
  // Vela diária mais recente que já devia ter fechado: a de ontem (UTC).
  const expectedLastOpen = Math.floor(nowMs / DAY) * DAY - DAY;

  const series = [];
  const coins = prereg.primarySymbols.map((symbol) => {
    const days = buildDays(dailyBySymbol[symbol], { endMs: nowMs });
    if (!days.length) return { symbol, status: 'no_data' };
    const lastOpen = days.at(-1).openTime;
    const base = { symbol, lastCandle: isoDay(lastOpen), close: days.at(-1).close, stale: lastOpen < expectedLastOpen };
    // Mesmo aquecimento do pré-registro: antes dele o estado não é confiável.
    if (days.length < prereg.warmupDaysAfterListing) return { ...base, status: 'warming' };
    const signals = dailySignals(days, params);
    const state = signals.at(-1);
    if (state === null) return { ...base, status: 'warming' };
    // Troca só entre dois dias de calendário seguidos com sinal.
    const prev = days.length > 1 && days.at(-2).openTime === lastOpen - DAY ? signals.at(-2) : null;
    series.push({ symbol, entries: symbolDailySeries(days, signals, { startMs, endMs, warmupDays: prereg.warmupDaysAfterListing }) });
    return { ...base, status: 'ok', state, changed: prev !== null && prev !== state };
  });

  const ok = coins.filter((c) => c.status === 'ok');
  return {
    asOf: isoDay(expectedLastOpen),
    start: isoDay(startMs),
    coins,
    long: ok.filter((c) => c.state === 1).map((c) => c.symbol),
    flat: ok.filter((c) => c.state === 0).map((c) => c.symbol),
    entered: ok.filter((c) => c.changed && c.state === 1).map((c) => c.symbol),
    exited: ok.filter((c) => c.changed && c.state === 0).map((c) => c.symbol),
    noData: coins.filter((c) => c.status === 'no_data').map((c) => c.symbol),
    warming: coins.filter((c) => c.status === 'warming').map((c) => c.symbol),
    stale: coins.filter((c) => c.stale).map((c) => c.symbol),
    progress: progressOf(series, prereg.costBpsPerSide / 10000),
    universe: prereg.primarySymbols.length,
  };
}

const list = (symbols) => (symbols.length ? symbols.map(short).join(', ') : '—');

function progressLine(r) {
  if (!r.progress) return `Começa a contar depois do fechamento de ${brDay(Date.parse(r.start))}.`;
  const p = r.progress;
  return `${p.days} ${p.days === 1 ? 'dia' : 'dias'} · regra ${pct(p.ruleReturn)} · comprar e segurar ${pct(p.buyHoldReturn)} · comprado ${Math.round(p.exposure * 100)}% do tempo`;
}

function warnings(r) {
  return [
    r.noData.length ? `Sem dado: ${list(r.noData)}` : null,
    r.stale.length ? `Vela de ontem ainda não chegou: ${list(r.stale)}` : null,
    r.warming.length ? `Histórico curto demais: ${list(r.warming)}` : null,
  ].filter(Boolean);
}

/** Mensagem do Telegram (HTML, parse_mode do send() de adminTelegram.js). */
export function formatDailyRuleTelegram(r) {
  const e = escaparHtml;
  const asOfMs = Date.parse(r.asOf);
  const changes = r.entered.length || r.exited.length
    ? [
      r.entered.length ? `🟢 Entrou (comprado): ${e(list(r.entered))}` : null,
      r.exited.length ? `⚪ Saiu (fora): ${e(list(r.exited))}` : null,
    ].filter(Boolean).join('\n')
    : 'Nenhuma troca hoje.';
  const warn = warnings(r);
  return [
    '📈 <b>Regra diária EMA 10/21 + Supertrend</b>',
    `Fechamento de ${brDay(asOfMs)} (UTC) · vale para ${brDay(asOfMs + DAY)}`,
    '',
    '<b>Trocas</b>',
    changes,
    '',
    `<b>Comprado (${r.long.length}):</b> ${e(list(r.long))}`,
    `<b>Fora (${r.flat.length}):</b> ${e(list(r.flat))}`,
    ...(warn.length ? ['', ...warn.map((w) => `⚠️ ${e(w)}`)] : []),
    '',
    `<b>Andamento desde ${brDay(Date.parse(r.start))}</b> (só acompanhamento, não decide)`,
    e(progressLine(r)),
    '',
    `<i>Regra de carteira (as ${r.universe} moedas juntas; o BTC sozinho não passou no teste). Só sinalização, nenhuma ordem é enviada. Decisão do tempo novo: 17/10/2028.</i>`,
  ].join('\n');
}

/** Resumo do job (markdown). */
export function formatDailyRuleMarkdown(r) {
  const asOfMs = Date.parse(r.asOf);
  const stateText = (c) => {
    if (c.status === 'no_data') return 'sem dado';
    if (c.status === 'warming') return 'histórico curto';
    return c.state === 1 ? 'comprado' : 'fora';
  };
  const rows = r.coins.map((c) => `| ${short(c.symbol)} | ${stateText(c)} | ${c.changed ? (c.state === 1 ? 'entrou' : 'saiu') : ''} | ${c.lastCandle ?? '—'}${c.stale ? ' ⚠️' : ''} | ${c.close ?? '—'} |`);
  return [
    `## Regra diária EMA 10/21 + Supertrend — fechamento de ${brDay(asOfMs)} (UTC)`,
    '',
    `Comprado: **${r.long.length}** · Fora: **${r.flat.length}** · Entraram: ${list(r.entered)} · Saíram: ${list(r.exited)}`,
    ...warnings(r).map((w) => `\n⚠️ ${w}`),
    '',
    '| Moeda | Estado | Troca hoje | Última vela | Fechamento |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    `**Andamento desde ${brDay(Date.parse(r.start))}** (só acompanhamento, não decide): ${progressLine(r)}`,
    '',
    '_Só sinalização, nenhuma ordem é enviada. A decisão formal do tempo novo é em 2028-10-17 (item 274)._',
  ].join('\n');
}
