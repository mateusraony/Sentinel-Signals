// Diagnóstico de um relatório de backtest já existente — responde "DE ONDE
// vem o resultado?" sem rodar nenhum replay novo e sem tocar em nenhum
// parâmetro (ver docs/known-risks.md item 44 e docs/claude/backtest-usage.md).
//
// Usage:
//   node scripts/analyze-backtest.mjs [--report ./backtest-report.json] [--json]
//
// Diferente de `npm run backtest`, este script NÃO passa por esbuild: a
// análise só depende de src/lib/backtestAnalysis.js + tradeMetrics.js +
// opTransition.js, que são módulos puros sem alias `@/`, então o Node importa
// direto. É por isso que ele também roda dentro do workflow sem passo de
// build.
//
// Precisa do JSON COMPLETO (o artifact `backtest-report` do run, ou o --out
// local) — o resumo publicado na aba Summary do job remove `overall.curve`
// de propósito, e é justamente `curve` que carrega cada operação.
import { readFileSync } from 'node:fs';
import { analyzeReport } from '../src/lib/backtestAnalysis.js';

function parseArgs(argv) {
  const args = { report: './backtest-report.json', json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--report' || arg === '--out') args.report = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return args;
}

const fmt = (value, digits = 3) => (value === null || value === undefined ? '—' : value.toFixed(digits));
const pct = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);
const hours = (value) => {
  if (value === null || value === undefined) return '—';
  return value >= 48 ? `${(value / 24).toFixed(1)}d` : `${value.toFixed(1)}h`;
};

function table(rows) {
  if (rows.length === 0) return ['(sem operações)'];
  const headers = Object.keys(rows[0]);
  const widths = headers.map((h) => Math.max(h.length, ...rows.map((r) => String(r[h]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(headers.map((h) => r[h])))];
}

// Formatação compartilhada pelo terminal e pelo resumo do workflow — as duas
// superfícies mostram os MESMOS números, para um print de uma nunca conflitar
// com o outro.
export function renderAnalysis(analysis) {
  const out = [];
  const { cost, holdHours: hold } = analysis;

  out.push(`Operações fechadas: ${analysis.totalClosed} (com R calculável: ${analysis.rCounted})`);
  out.push(`Expectância líquida: ${fmt(analysis.expectancyR)} R`);
  out.push('');

  out.push('DE ONDE VEM O RESULTADO — por motivo de saída');
  out.push('(contribuição = quantos R da expectância final vieram deste balde;');
  out.push(' as linhas somam exatamente a expectância acima)');
  out.push(...table(analysis.byExitReason.map((b) => ({
    motivo: b.key,
    ops: b.count,
    '%': pct(b.share),
    'W/L/BE': `${b.wins}/${b.losses}/${b.be}`,
    'contrib R': fmt(b.contributionR),
    'média R': fmt(b.avgR),
    'tempo méd': hours(b.avgHoldHours),
  }))));
  out.push('');

  out.push('DE ONDE VEM O RESULTADO — por símbolo');
  out.push(...table(analysis.bySymbol.map((b) => ({
    símbolo: b.symbol,
    ops: b.count,
    'W/L/BE': `${b.wins}/${b.losses}/${b.be}`,
    'contrib R': fmt(b.contributionR),
    'média R': fmt(b.avgR),
  }))));
  out.push('');

  out.push('ESTABILIDADE NO TEMPO — por trimestre');
  out.push('(ordem cronológica, não por contribuição — aqui o que informa é a');
  out.push(' sequência: degradação, concentração num período, ou estabilidade)');
  out.push(...table(analysis.byPeriod.map((b) => ({
    trimestre: b.period,
    ops: b.count,
    'W/L/BE': `${b.wins}/${b.losses}/${b.be}`,
    'contrib R': fmt(b.contributionR),
    'média R': fmt(b.avgR),
  }))));
  // As duas linhas juntas, sempre: concentração máxima (tudo num trimestre
  // lucrativo) dá 100% na primeira, e só a segunda denuncia.
  out.push(`Dos trimestres que operaram, positivos: ${pct(analysis.positivePeriodsShare)}`);
  out.push(`Trimestres com alguma operação: ${analysis.activePeriods} de ${analysis.totalPeriods}`
    + `${analysis.activePeriodsShare === null ? ' (janela desconhecida)' : ` (${pct(analysis.activePeriodsShare)} da janela)`}`);
  out.push('');

  out.push('CUSTO — de que é feito');
  out.push(...table([{
    componente: 'taxa',
    'R por op': fmt(cost.avgFeeR, 4),
    'fatia': pct(cost.feeShare),
  }, {
    componente: 'slippage',
    'R por op': fmt(cost.avgSlippageR, 4),
    'fatia': pct(cost.slippageShare),
  }, {
    componente: 'funding',
    'R por op': fmt(cost.avgFundingR, 4),
    'fatia': pct(cost.fundingShare),
  }, {
    componente: 'TOTAL',
    'R por op': fmt(cost.avgCostR, 4),
    // '—' também quando o custo total é zero: 100% de nada é enganoso.
    'fatia': cost.feeShare === null ? '—' : '100.0%',
  }]));
  // Duas frases separadas de propósito: atravessar a fronteira é geometria da
  // duração, pagar depende da taxa configurada. Num run --no-costs a primeira
  // continua informativa e a segunda tem que dizer zero.
  out.push(`Fronteiras de 8h atravessadas por operação: ${fmt(cost.avgBoundariesCrossed, 1)}`);
  out.push(cost.fundingCharged
    ? `Operações que pagaram funding: ${cost.opsWithFunding} de ${analysis.totalClosed}`
    : 'Funding não cobrado neste run (taxa 0) — nenhuma operação pagou.');
  out.push('');

  out.push('TEMPO EM POSIÇÃO');
  out.push(`média ${hours(hold.avg)} · mediana ${hours(hold.median)} `
    + `· mínimo ${hours(hold.min)} · máximo ${hours(hold.max)} (${hold.counted} operações medidas)`);

  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('node scripts/analyze-backtest.mjs [--report ./backtest-report.json] [--json]');
    return;
  }

  const report = JSON.parse(readFileSync(args.report, 'utf-8'));
  const analysis = analyzeReport(report);

  if (args.json) {
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }

  console.log(`\n=== Diagnóstico: ${args.report} ===`);
  if (report.trialLabel) console.log(`Tentativa: ${report.trialLabel}`);
  if (report.range) console.log(`Período: ${report.range.from} → ${report.range.to}`);
  if (report.costs && report.costs.model && report.costs.model.applied === false) {
    console.log('⚠️  Run SEM custos (--no-costs) — a decomposição de custo abaixo será toda zero.');
  }
  console.log('');
  console.log(renderAnalysis(analysis).join('\n'));

  // O diagnóstico descreve a amostra; não a torna conclusiva. Repetir o
  // veredito aqui evita que uma tabela bem formatada passe a sensação de que
  // o resultado virou decisão.
  if (report.costs && report.costs.conclusive === false) {
    console.log(`\n⚠️  O relatório de origem é INCONCLUSIVO (${report.costs.inconclusiveReason}).`);
    console.log('   Este diagnóstico mostra a composição do resultado, não o valida.');
  }
  console.log('');
}

// Só executa quando chamado como CLI — o workflow importa renderAnalysis.
if (process.argv[1] && process.argv[1].endsWith('analyze-backtest.mjs')) main();
