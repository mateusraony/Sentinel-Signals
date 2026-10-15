// Dados sintéticos para scripts/dailyTrend.test.mjs e para a calibração do
// item 271 (erro tipo I e poder ANTES do run real, lição do item 269) — só
// teste, nunca produção. Velas diárias das moedas do pré-registro, com as
// listagens tardias aproximadas das reais.
//
// Cenários:
//   'iid'     — ruído gaussiano, σ 4%/dia, sem deriva (nula limpa).
//   'adverse' — nula hostil: cauda gorda (t de 4 gl), volatilidade em blocos
//               de 30–90 dias entre 1,5% e 6%, fator de mercado comum (ρ 0,5)
//               e deriva positiva de 0,1%/dia. Nenhuma informação de momento.
//   'trend'   — poder: deriva em regimes persistentes (duração média de 60
//               dias, comum a todas as moedas), ±`drift` por dia, sobre o ruído
//               do 'adverse' sem a deriva fixa.
//
// Uso como CLI (calibração; imprime JSON):
//   node scripts/__fixtures__/dailyTrendSynth.mjs --scenario adverse --n 50 --seed-offset 0 [--drift 0.002]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../../src/lib/seededRandom.js';
import { runDailyTrend } from '../dailyTrend.mjs';

const DAY = 24 * 60 * 60 * 1000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PREREG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/experiments/daily-ema-supertrend-prereg.json'), 'utf8'));

// Listagens tardias aproximadas das reais (as outras moedas começam no fetchFrom).
export const LATE_START = { DYDXUSDT: '2021-09-08', PENDLEUSDT: '2023-07-03', ZROUSDT: '2024-06-20', PAXGUSDT: '2020-09-04' };

function gaussFrom(rand) {
  return () => { const u = Math.max(rand(), 1e-12); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };
}

// t de Student com 4 gl, normalizado para variância 1.
function student4From(rand, gauss) {
  return () => {
    const chi2 = -2 * Math.log(Math.max(rand(), 1e-12) * Math.max(rand(), 1e-12));
    return (gauss() / Math.sqrt(chi2 / 4)) / Math.SQRT2;
  };
}

/**
 * @returns {Record<string, object[]>} velas diárias por símbolo
 */
export function synthMarket({ seed, scenario = 'iid', drift = 0.002, prereg = PREREG, symbols = [...prereg.primarySymbols, ...prereg.descriptiveSymbols] }) {
  const fromMs = Date.parse(`${prereg.fetchFrom}T00:00:00Z`);
  const lastOpen = Date.parse(prereg.end) + 1 - DAY;
  const nDays = Math.round((lastOpen - fromMs) / DAY) + 1;

  // Componentes comuns por data (fator de mercado e regime de deriva).
  const common = mulberry32(seed * 7919 + 13);
  const cg = gaussFrom(common);
  const market = new Array(nDays);
  const regimeDrift = new Array(nDays);
  let sign = 1;
  for (let d = 0; d < nDays; d += 1) {
    market[d] = cg();
    if (common() < 1 / 60) sign = -sign;
    regimeDrift[d] = sign * drift;
  }

  const out = {};
  symbols.forEach((symbol, i) => {
    const rand = mulberry32(seed * 104729 + i * 31 + 1);
    const g = gaussFrom(rand);
    const t4 = student4From(rand, g);
    const start = LATE_START[symbol] ? Date.parse(`${LATE_START[symbol]}T00:00:00Z`) : fromMs;
    const candles = [];
    let price = 100;
    let vol = 0.03;
    let left = 0;
    for (let t = start; t <= lastOpen; t += DAY) {
      const d = Math.round((t - fromMs) / DAY);
      let r;
      if (scenario === 'iid') {
        r = 0.04 * g();
      } else {
        if (left <= 0) { vol = 0.015 + rand() * 0.045; left = 30 + Math.floor(rand() * 60); }
        left -= 1;
        const shock = Math.sqrt(0.5) * market[d] + Math.sqrt(0.5) * t4();
        r = (scenario === 'trend' ? regimeDrift[d] : 0.001) + vol * shock;
      }
      const open = price;
      price *= Math.exp(r);
      const wick = Math.abs(g()) * 0.3 * (scenario === 'iid' ? 0.04 : vol);
      candles.push({ openTime: t, closeTime: t + DAY - 1, open, high: Math.max(open, price) * (1 + wick), low: Math.min(open, price) * (1 - wick), close: price });
    }
    out[symbol] = candles;
  });
  return out;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[argv[i].slice(2)] = next; i += 1; } else args[argv[i].slice(2)] = true;
  }
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const scenario = args.scenario || 'iid';
  const n = Number(args.n || 50);
  const offset = Number(args['seed-offset'] || 0);
  const drift = Number(args.drift || 0.002);
  const rows = [];
  for (let k = 0; k < n; k += 1) {
    const r = runDailyTrend(synthMarket({ seed: offset + k + 1, scenario, drift, symbols: PREREG.primarySymbols }), PREREG, { descriptive: false });
    rows.push({ seed: offset + k + 1, verdict: r.verdict, pPortfolio: r.tests[0].full.p, pBtc: r.tests[1].full.p, pass: r.tests.map((t) => t.pass) });
  }
  console.log(JSON.stringify({ scenario, drift: scenario === 'trend' ? drift : null, n, offset, rows }));
}
