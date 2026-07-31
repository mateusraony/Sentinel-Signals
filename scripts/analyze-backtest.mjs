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
  const { cost, holdHours: hold, runner } = analysis;

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

  // Eixos de verificação (auditoria 2026-07-28). O cruzamento lado × tier é o
  // que decide a afirmação "BUY Tier 3 destrói o resultado" — os eixos isolados
  // não respondem, porque um BUY ruim em T3 aparece diluído nos dois.
  const eixo = (titulo, linhas, rotulo, campo) => {
    out.push(titulo);
    out.push(...table(linhas.map((b) => ({
      [rotulo]: b[campo],
      ops: b.count,
      'W/L/BE': `${b.wins}/${b.losses}/${b.be}`,
      'contrib R': fmt(b.contributionR),
      'média R': fmt(b.avgR),
    }))));
    out.push('');
  };

  eixo('POR LADO', analysis.bySide, 'lado', 'side');
  eixo('POR TIER', analysis.byTier, 'tier', 'tier');
  eixo('POR LADO × TIER — o cruzamento que decide', analysis.bySideTier, 'lado/tier', 'key');
  if (analysis.byTier.some((b) => b.tier === 'SEM_TIER' && b.count > 0)) {
    out.push('⚠️  Há operações SEM_TIER. Operação da cascata SMC não recebe tier');
    out.push('   quando smcTierEnabled está desligado (o default), e o valor 96 de');
    out.push('   tier_time_stop_bars parece T3 sem ser. Elas ficam em balde próprio');
    out.push('   de propósito — não são T3.');
    out.push('');
  }
  eixo('POR RESULTADO DE ARBITRAGEM cross-cascade', analysis.byArbitration, 'resultado', 'key');

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

  // A única peça da geometria de SAÍDA que é medida aqui. Os demais eixos
  // decompõem o resultado; este compara o resultado real com o que teria sido
  // fechando 100% no TP1 — sobre as mesmas operações, sem look-ahead (só entram
  // as que comprovadamente atingiram o TP1). Ver docs/known-risks.md item 46.
  out.push('O RUNNER PAGOU? — resultado real vs. fechar 100% no TP1');
  out.push('(bruto contra bruto: o cenário TP1 não tem custo calculável, então');
  out.push(' descontar custo de um lado só enviesaria a comparação)');
  if (runner.opsWithTp1 === 0) {
    out.push('(nenhuma operação atingiu TP1 — nada a atribuir)');
  } else {
    out.push(...table([{
      cenário: 'real (com runner)',
      'expectância bruta': fmt(runner.grossExpectancyR),
    }, {
      cenário: '100% no TP1',
      'expectância bruta': fmt(runner.grossExpectancyRAtTp1),
    }, {
      cenário: 'CONTRIBUIÇÃO DO RUNNER',
      'expectância bruta': fmt(runner.avgContributionR),
    }]));
    out.push(`Operações que atingiram TP1: ${runner.opsWithTp1} · destas, chegaram ao TP2: ${runner.reachedTp2}`);
    out.push(`Fechar no TP1 teria sido melhor em ${runner.betterAtTp1}, pior em ${runner.worseAtTp1}`);
    out.push(`Total que o runner adicionou (ou tirou): ${fmt(runner.totalContributionR, 1)} R`);
  }
  out.push('');

  out.push('TEMPO EM POSIÇÃO');
  out.push(`média ${hours(hold.avg)} · mediana ${hours(hold.median)} `
    + `· mínimo ${hours(hold.min)} · máximo ${hours(hold.max)} (${hold.counted} operações medidas)`);
  out.push('');

  // known-risks item 47.2 — o motor não deve ser aprovado só porque poucas
  // operações excepcionais compensaram o resto.
  const { concentration: conc } = analysis;
  out.push('CONCENTRAÇÃO DO RESULTADO');
  out.push(`Top 5 operações: ${fmt(conc.top5ContributionR, 1)} R (${pct(conc.top5Share)} do total)`);
  out.push(`Top 10 operações: ${fmt(conc.top10ContributionR, 1)} R (${pct(conc.top10Share)} do total)`);
  const maiorEixo = (rotulo, entry) => entry
    ? `Maior contribuição ${rotulo}: ${entry.key} com ${fmt(entry.contributionR)} R (${pct(entry.share)})`
    : `Maior contribuição ${rotulo}: (sem dado)`;
  out.push(maiorEixo('por símbolo', conc.largestSymbol));
  out.push(maiorEixo('por trimestre', conc.largestPeriod));
  out.push(maiorEixo('por lado', conc.largestSide));
  out.push('');

  // MFE/MAE — known-risks item 47.2. Só populado em operações passadas pelo
  // motor DEPOIS desta mudança (campo aditivo, sem backfill em ops antigas).
  const { excursion: exc } = analysis;
  out.push('EXCURSÃO MÁXIMA (MFE/MAE)');
  if (exc.counted === 0) {
    out.push('(nenhuma operação com mfe_r/mae_r — todas anteriores a este campo)');
  } else {
    out.push(`MFE médio ${fmt(exc.avgMfeR)} R (mediana ${fmt(exc.medianMfeR)}) · `
      + `MAE médio ${fmt(exc.avgMaeR)} R (mediana ${fmt(exc.medianMaeR)}) — ${exc.counted} operações`);
    out.push(`Bars até TP1 (média): ${fmt(exc.avgBarsToTp1, 1)} · Bars até stop (média): ${fmt(exc.avgBarsToStop, 1)}`);
    out.push(`Das que pararam no stop, chegaram a ficar positivas antes: `
      + `${exc.stoppedAfterProfitCount} de ${exc.stoppedCount} (${pct(exc.stoppedAfterProfitShare)})`);
  }

  return out;
}

// Round 3 (docs/known-risks.md item 50) — imprime as 3 seções de funil que
// buildReport já calcula mas que, até este round, nenhuma superfície
// imprimia (nem o CLI, nem o resumo do workflow): rfRegime (novo),
// smcRegime (existia desde a Fase 3, nunca impresso) e smcTrigger (novo).
// Lê o `report` bruto, não o `analysis` derivado de analyzeReport — essas
// seções são sobre TENTATIVAS de entrada, não sobre operações fechadas, que
// é o escopo fechado de backtestAnalysis.js (ver cabeçalho do arquivo).
function renderGateSection(title, section) {
  const out = [title];
  const okCount = section.passed ?? section.confirmed ?? 0;
  out.push(`total: ${section.total} · ok: ${okCount} · rejeitado: ${section.rejected ?? 0} · `
    + `avaliações: ${section.attempts.evaluations} · sinais com retry: ${section.attempts.retried} · `
    + `máx. tentativas por sinal: ${section.attempts.maxAttempts}`);
  if (section.byTrigger) {
    out.push(...table(Object.entries(section.byTrigger).map(([trigger, count]) => ({ gatilho: trigger, confirmados: count }))));
  }
  // Codex review (PR #103, P2): rfRegime/smcRegime/smcTrigger são Maps por
  // dedup_key (último-escreve-ganha, mesma convenção de retest/displacement)
  // — byReason conta SINAIS cujo motivo FINAL foi aquele, não quantas vezes
  // o gate rodou (isso já está em `attempts.evaluations` na linha acima).
  // Rotular a coluna como "avaliações" sugeria o contrário.
  const reasonEntries = Object.entries(section.byReason || {});
  out.push(...(reasonEntries.length > 0
    ? table(reasonEntries.map(([reason, count]) => ({ motivo: reason, sinais: count })))
    : ['(sem rejeições)']));
  if (section.adxStats) out.push(`ADX nas rejeições por ADX fraco — média ${section.adxStats.avgRejected} (mín ${section.adxStats.minRejected}, máx ${section.adxStats.maxRejected})`);
  if (section.chopStats) out.push(`Choppiness nas rejeições por mercado lateralizado — média ${section.chopStats.avgRejected} (mín ${section.chopStats.minRejected}, máx ${section.chopStats.maxRejected})`);
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

  if (report.rfRegime) {
    console.log('');
    console.log(renderGateSection('FUNIL DE REGIME — RF (4h_15m)', report.rfRegime).join('\n'));
  }
  if (report.smcRegime) {
    console.log('');
    console.log(renderGateSection('FUNIL DE REGIME — SMC (1h_5m, opt-in smcTierEnabled)', report.smcRegime).join('\n'));
  }
  if (report.smcTrigger) {
    console.log('');
    console.log(renderGateSection('GATILHO DE ENTRADA — SMC 5m (1h_5m)', report.smcTrigger).join('\n'));
  }

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
