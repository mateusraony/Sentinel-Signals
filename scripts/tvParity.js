// Paridade de OPERAÇÕES: lista de negociações do Strategy Tester do TradingView × operações do backtest do Sentinel (docs/known-risks.md item 308).
// Funções PURAS (sem rede, sem disco): quem lê os arquivos é o CLI (scripts/compare-tv-trades.mjs). Nada aqui escreve em banco nem envia ordem.
//
// A lista do TradingView traz DUAS linhas por "negociação" (uma Entrada e uma Saída com o mesmo número) e cada posição pode ter DUAS negociações
// (TP1 parcial + o resto: RUNNER/RF EXIT/SL). Aqui agrupamos por posição = (hora da barra de entrada, lado).
// A hora da lista é a de ABERTURA da barra em que a ordem executou (UTC no gráfico do usuário): com process_orders_on_close a entrada sai no
// FECHAMENTO dessa barra, que é o mesmo candle de sinal que o Sentinel grava em `candle_open_time`.

/** Divide uma linha CSV respeitando aspas. */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const HEADER_ALIASES = {
  n: ['número da negociação', 'numero da negociacao', 'trade #', 'trade no.'],
  type: ['tipo', 'type'],
  time: ['data e hora', 'date/time', 'date and time', 'date & time'],
  signal: ['sinal', 'signal'],
  price: ['preço usdt', 'preco usdt', 'price usdt', 'preço', 'price'],
  value: ['tamanho (valor)', 'size (value)', 'position size (value)'],
  pnl: ['l&p líquido usdt', 'l&p liquido usdt', 'net p&l usdt', 'net p&l'],
};

/**
 * Lê o CSV da "Lista de negociações" (português ou inglês) e devolve as POSIÇÕES.
 * @param {string} text conteúdo do arquivo (com ou sem BOM)
 * @returns {{ positions: Array<{ entryTime: string, side: 'BUY'|'SELL', entryPrice: number, value: number, pnl: number, pct: number, exits: Array<{ time: string, signal: string, price: number, pnl: number }> }>, tradeRows: number }}
 */
export function parseTvTrades(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('CSV de negociações vazio');
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(HEADER_ALIASES)) {
    const i = header.findIndex((h) => names.includes(h));
    if (i === -1) throw new Error(`coluna obrigatória ausente no CSV do TradingView: ${k} (esperado um destes nomes: ${names.join(' | ')})`);
    col[k] = i;
  }
  const byTrade = new Map();
  for (const l of lines.slice(1)) {
    const c = splitCsvLine(l);
    const n = c[col.n].trim();
    const kind = c[col.type].trim().toLowerCase();
    const isEntry = kind.startsWith('entrada') || kind.startsWith('entry');
    const isExit = kind.startsWith('saída') || kind.startsWith('saida') || kind.startsWith('exit');
    if (!isEntry && !isExit) continue;
    const side = kind.includes('long') ? 'BUY' : 'SELL';
    const rec = byTrade.get(n) || {};
    rec[isEntry ? 'entry' : 'exit'] = { time: c[col.time].trim(), signal: c[col.signal].trim(), price: Number(c[col.price]), value: Number(c[col.value]), pnl: Number(c[col.pnl]), side };
    byTrade.set(n, rec);
  }
  const positions = new Map();
  for (const [, t] of [...byTrade.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (!t.entry || !t.exit) continue;
    const key = `${t.entry.time}|${t.entry.side}`;
    const p = positions.get(key) || { entryTime: t.entry.time, side: t.entry.side, entryPrice: t.entry.price, value: 0, pnl: 0, pct: 0, exits: [] };
    p.value += t.entry.value;
    p.pnl += t.exit.pnl;
    p.exits.push({ time: t.exit.time, signal: t.exit.signal, price: t.exit.price, pnl: t.exit.pnl });
    positions.set(key, p);
  }
  const list = [...positions.values()].map((p) => ({ ...p, pct: p.value ? (100 * p.pnl) / p.value : 0 }));
  return { positions: list, tradeRows: byTrade.size };
}

/** Motivo normalizado da saída FINAL de uma posição do TradingView. */
export function tvExitReason(position) {
  const last = [...position.exits].sort((a, b) => (a.time < b.time ? -1 : 1)).at(-1);
  const s = String(last.signal).toUpperCase();
  const hadTp1 = position.exits.some((e) => String(e.signal).toUpperCase() === 'TP1');
  if (s.startsWith('TIME STOP')) return 'time_stop';
  if (s === 'RF EXIT') return 'rf_exit';
  if (s === 'BUY' || s === 'SELL') return 'reversal';
  if (s === 'SL') return hadTp1 ? 'stop_after_tp1' : 'stop';
  if (s === 'RUNNER') return 'stop_after_tp1';
  if (s === 'TP1') return 'tp1_only';
  return 'other';
}

/** Motivo normalizado da saída de uma operação do backtest do Sentinel. */
export function sentinelExitReason(op) {
  if (op.status === 'TP2_HIT') return 'tp2';
  if (op.status === 'CLOSED' && op.closed_reason === 'TIME_STOP') return 'time_stop';
  if (op.status === 'CLOSED') return String(op.closed_reason || 'closed').toLowerCase();
  if (op.status === 'INVALIDATED') return op.tp1_hit ? 'rf_exit' : 'reversal_or_invalidation';
  if (op.status === 'STOP_HIT') return op.tp1_hit ? 'stop_after_tp1' : 'stop';
  return 'other';
}

const isoKey = (iso) => String(iso).slice(0, 16).replace('T', ' ');

/**
 * Compara as posições do TradingView com as operações do relatório do backtest (`report.overall.curve`).
 * @param {ReturnType<typeof parseTvTrades>['positions']} tvPositions
 * @param {Array<{ op: any, pnlPct: number, r?: number }>} curve
 * @param {{ from?: string, priceTolerance?: number }} [opts] from = 'YYYY-MM-DD HH:mm' (só posições a partir dali); priceTolerance relativa (padrão 0,2%)
 */
export function compareTvToSentinel(tvPositions, curve, { from = '', priceTolerance = 0.002 } = {}) {
  const tv = tvPositions.filter((p) => p.entryTime >= from);
  const sen = new Map(curve.map((c) => [`${isoKey(c.op.candle_open_time)}|${c.op.side}`, c]));
  const rows = [];
  const onlyTv = [];
  for (const p of tv) {
    const c = sen.get(`${p.entryTime}|${p.side}`);
    if (!c) { onlyTv.push(p); continue; }
    const last = [...p.exits].sort((a, b) => (a.time < b.time ? -1 : 1)).at(-1);
    const samePrice = Number.isFinite(c.op.exit_price) && Math.abs(c.op.exit_price - last.price) / last.price <= priceTolerance;
    rows.push({
      entryTime: p.entryTime, side: p.side,
      tvReason: tvExitReason(p), sentinelReason: sentinelExitReason(c.op),
      tvExitTime: last.time, sentinelExitTime: isoKey(c.op.closed_at_real_time || c.op.stop_hit_real_time || c.op.closed_at || ''),
      tvExitPrice: last.price, sentinelExitPrice: c.op.exit_price, sameExit: samePrice,
      tvPct: p.pct, sentinelPct: c.pnlPct,
    });
  }
  const tvKeys = new Set(tv.map((p) => `${p.entryTime}|${p.side}`));
  const onlySentinel = [...sen.entries()].filter(([k, c]) => !tvKeys.has(k) && isoKey(c.op.candle_open_time) >= from).map(([, c]) => c);
  const differing = rows.filter((r) => !r.sameExit);
  const byCause = {};
  for (const r of differing) { const k = `${r.tvReason} × ${r.sentinelReason}`; byCause[k] = (byCause[k] || 0) + 1; }
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  return {
    tvPositions: tv.length, sentinelOps: onlySentinel.length + rows.length,
    sameEntry: rows.length, onlyTv, onlySentinel,
    sameExit: rows.filter((r) => r.sameExit).length, differing, byCause,
    tvPctSum: sum(rows, (r) => r.tvPct), sentinelPctSum: sum(rows, (r) => r.sentinelPct),
    rows,
  };
}

/** Converte o CSV de "Export chart data" do TradingView em candles do formato do backtest (JSON de scripts/__fixtures__/backtest). Descarta a última linha (barra ao vivo). */
export function tvChartCsvToCandles(text, timeframeMs) {
  const lines = String(text).replace(/^﻿/, '').trim().split(/\r?\n/);
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (n) => header.indexOf(n);
  for (const n of ['time', 'open', 'high', 'low', 'close']) if (idx(n) === -1) throw new Error(`coluna ausente no CSV do gráfico: ${n}`);
  const rows = lines.slice(1).map(splitCsvLine);
  rows.pop();
  return rows.map((r) => {
    const t = /^\d+$/.test(r[idx('time')]) ? Number(r[idx('time')]) * 1000 : Date.parse(r[idx('time')]);
    return { openTime: t, open: Number(r[idx('open')]), high: Number(r[idx('high')]), low: Number(r[idx('low')]), close: Number(r[idx('close')]), volume: idx('volume') === -1 ? 0 : Number(r[idx('volume')]), closeTime: t + timeframeMs - 1, isClosed: true };
  });
}

/** 1d a partir de 4h (6 barras por dia UTC). Dias incompletos ficam de fora. */
export function aggregateDailyFrom4h(candles4h) {
  const DAY = 86400000;
  const byDay = new Map();
  for (const c of candles4h) { const d = Math.floor(c.openTime / DAY); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(c); }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).filter(([, g]) => g.length === 6).map(([d, g]) => ({
    openTime: d * DAY, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g.at(-1).close,
    volume: g.reduce((s, x) => s + x.volume, 0), closeTime: d * DAY + DAY - 1, isClosed: true,
  }));
}
