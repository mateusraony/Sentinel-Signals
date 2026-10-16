#!/usr/bin/env node
// CLI do relatório diário da regra EMA 10/21 + Supertrend(10,3) —
// docs/known-risks.md item 275. A lógica mora em scripts/dailyRuleReport.mjs
// (testável sem rodar main); o envio, em scripts/adminTelegram.js.
//
// Uso:
//   node scripts/daily-rule-report.mjs [--data-dir candles] \
//     [--prereg docs/experiments/daily-ema-supertrend-forward-prereg.json] [--send] [--now 2026-10-18T00:23:00Z]
//
// Lê SIMBOLO_1d.json (gerados por scripts/fetch-backtest-data.mjs) e imprime o
// resumo em markdown. Com --send, manda a mensagem pelo bot do canal 24h
// (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID). Só acompanha: não decide nada e não
// envia ordem. Código 1 quando nenhuma moeda tem dado ou quando --send não
// conseguiu entregar a mensagem (o job tem que aparecer vermelho).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDailyRuleReport, formatDailyRuleMarkdown, formatDailyRuleTelegram } from './dailyRuleReport.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const preregPath = args.prereg || path.join('docs', 'experiments', 'daily-ema-supertrend-forward-prereg.json');
  const dataDir = args['data-dir'] || 'candles';
  const nowMs = args.now ? Date.parse(args.now) : Date.now();
  if (!Number.isFinite(nowMs)) {
    console.error('[daily-rule-report] --now inválido');
    process.exitCode = 1;
    return;
  }
  const prereg = JSON.parse(fs.readFileSync(preregPath, 'utf8'));

  const dailyBySymbol = {};
  for (const symbol of prereg.primarySymbols) {
    const file = path.join(dataDir, `${symbol}_1d.json`);
    if (fs.existsSync(file)) dailyBySymbol[symbol] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  const report = buildDailyRuleReport(dailyBySymbol, prereg, { nowMs });
  console.log(formatDailyRuleMarkdown(report));
  if (report.noData.length === report.universe) {
    console.error('[daily-rule-report] nenhuma moeda tem dado — nada foi enviado.');
    process.exitCode = 1;
    return;
  }

  if (args.send) {
    // Import tardio: rodar sem --send não carrega nada do canal 24h.
    const { isTelegramConfigured, notifyDailyRuleReport } = await import('./adminTelegram.js');
    if (!isTelegramConfigured()) {
      console.error('[daily-rule-report] Telegram não configurado (faltam TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) — nada foi enviado.');
      process.exitCode = 1;
      return;
    }
    const delivered = await notifyDailyRuleReport(formatDailyRuleTelegram(report));
    if (!delivered) {
      console.error('[daily-rule-report] o Telegram não confirmou a entrega da mensagem.');
      process.exitCode = 1;
      return;
    }
    console.log('\n_Mensagem enviada ao Telegram._');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('[daily-rule-report] FALHOU:', err);
    process.exitCode = 1;
  });
}
