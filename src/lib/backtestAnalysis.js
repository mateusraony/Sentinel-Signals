// Diagnóstico pós-backtest — responde "DE ONDE vem o resultado?", não
// "qual parâmetro ajustar?".
//
// Motivo de existir (docs/known-risks.md item 44): a primeira medição real
// deu expectância BRUTA negativa (-0,061 R em 109 operações). Nesse cenário,
// varrer combinações de flags é a pior jogada disponível — cada gate é um
// filtro, corta a amostra, alarga o intervalo de confiança, e testar N
// configurações e escolher a melhor produz um vencedor por sorte. Com
// sd(R) ~ 1,1 e ~55 operações após um filtro, o MÁXIMO de 16 tentativas
// inúteis ainda é esperado em torno de +0,2 R. Este módulo é a alternativa:
// decompõe as operações que JÁ existem, sem gastar nenhuma tentativa.
//
// Propriedade central: `contributionR` de cada balde é `sumR / rCounted` do
// conjunto TODO, então os baldes somam EXATAMENTE a expectância geral. Não é
// uma comparação de médias entre grupos de tamanhos diferentes (que engana
// quando um balde tem 3 operações e outro tem 80) — é uma decomposição
// aditiva: cada linha diz quantos R da expectância final vieram dali.
//
// Puro, sem I/O — mesmo padrão de tradeMetrics.js/opExitRules.js. O CLI
// (scripts/analyze-backtest.mjs) e o workflow só formatam o que sai daqui.
import {
  DEFAULT_COST_MODEL,
  calcCostR,
  calcRealizedR,
  classifyOutcome,
  countFundingSettlements,
  getClosedAt,
  getOpenedAt,
  isClosedOp,
  resolveCostModel,
} from './tradeMetrics.js';

const MS_PER_HOUR = 3600000;

// Motivo de saída legível. `status` sozinho junta Time Stop e Chop Exit no
// mesmo balde 'CLOSED' — que são mecanismos diferentes, com implicações
// opostas (um diz que a operação apodreceu, outro que o regime virou), então
// closed_reason refina quando existe.
export function exitReasonKey(op) {
  const status = op?.status ?? 'UNKNOWN';
  if (status === 'CLOSED' && op?.closed_reason) return `CLOSED:${op.closed_reason}`;
  return status;
}

// Bucket temporal do resultado: ano-trimestre do FECHAMENTO (o instante em que
// o R foi realizado, mesma referência que summarizeOps usa para ordenar a
// curva). Trimestre e não mês: a 109 operações/ano, buckets mensais dariam ~9
// operações cada — ruído puro. Existe para responder "o resultado depende de
// uma janela curta?", que é um veto explícito de qualquer critério de
// aprovação sério, sem precisar construir walk-forward.
export function periodKey(op) {
  const closedAt = getClosedAt(op);
  if (!closedAt) return 'UNKNOWN';
  const date = new Date(closedAt);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return 'UNKNOWN';
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

export function holdHours(op) {
  const openedAt = getOpenedAt(op);
  const closedAt = getClosedAt(op);
  if (!openedAt || !closedAt) return null;
  const startMs = new Date(openedAt).getTime();
  const endMs = new Date(closedAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return (endMs - startMs) / MS_PER_HOUR;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const mean = (sum, n) => (n > 0 ? sum / n : null);

function emptyBucket(extra) {
  return {
    count: 0, rCount: 0, wins: 0, losses: 0, be: 0,
    sumR: 0, sumCostR: 0, costRCount: 0, sumHoldHours: 0, holdCount: 0,
    ...extra,
  };
}

function tallyBucket(bucket, { outcome, r, costR, hours }) {
  bucket.count += 1;
  if (outcome === 'WIN') bucket.wins += 1;
  else if (outcome === 'LOSS') bucket.losses += 1;
  else if (outcome === 'BE') bucket.be += 1;
  if (r !== null) { bucket.sumR += r; bucket.rCount += 1; }
  if (costR !== null) { bucket.sumCostR += costR; bucket.costRCount += 1; }
  if (hours !== null) { bucket.sumHoldHours += hours; bucket.holdCount += 1; }
}

// `rCountedTotal` é o denominador COMPARTILHADO — é ele que faz os baldes
// somarem a expectância geral em vez de virarem médias incomparáveis.
function finishBucket(bucket, totalCount, rCountedTotal) {
  return {
    ...bucket,
    share: totalCount > 0 ? bucket.count / totalCount : 0,
    avgR: mean(bucket.sumR, bucket.rCount),
    contributionR: rCountedTotal > 0 ? bucket.sumR / rCountedTotal : 0,
    avgCostR: mean(bucket.sumCostR, bucket.costRCount),
    avgHoldHours: mean(bucket.sumHoldHours, bucket.holdCount),
  };
}

// Custo em R separado por componente. Feito com três chamadas isoladas a
// calcCostR em vez de reimplementar a fórmula: o custo é linear em cada termo
// de bps, então taxa + slippage + funding reconstroem o total exato — e usar
// a API pública garante que a decomposição nunca divirja do custo realmente
// cobrado (é a mesma razão de resolveCostModel ser importado, não copiado).
function costComponentModels(costModel) {
  const m = resolveCostModel(costModel);
  return {
    resolved: m,
    fee: { feeBpsEntry: m.feeBpsEntry, feeBpsExit: m.feeBpsExit, slippageBpsPerSide: 0, fundingBpsPer8h: 0 },
    slippage: { feeBpsEntry: 0, feeBpsExit: 0, slippageBpsPerSide: m.slippageBpsPerSide, fundingBpsPer8h: 0 },
    funding: { feeBpsEntry: 0, feeBpsExit: 0, slippageBpsPerSide: 0, fundingBpsPer8h: m.fundingBpsPer8h },
  };
}

/**
 * Decompõe um conjunto de operações fechadas.
 *
 * Operações ainda abertas são descartadas (mesma regra de summarizeOps), e
 * operações sem R calculável entram na contagem do balde mas não na soma de R
 * — nunca são silenciosamente contadas como zero.
 */
export function analyzeOps(ops, { costModel, epsilonR = 0.05, epsilonPct = 0.1 } = {}) {
  const closed = (ops || []).filter(isClosedOp);
  const models = costComponentModels(costModel);

  const rows = closed.map((op) => ({
    op,
    outcome: classifyOutcome(op, { epsilonR, epsilonPct, costModel }),
    r: calcRealizedR(op, costModel),
    costR: calcCostR(op, costModel),
    hours: holdHours(op),
  }));

  const rCountedTotal = rows.filter((row) => row.r !== null).length;
  const sumRTotal = rows.reduce((acc, row) => acc + (row.r ?? 0), 0);

  const byExitReason = new Map();
  const bySymbol = new Map();
  const byPeriod = new Map();
  for (const row of rows) {
    const exitKey = exitReasonKey(row.op);
    if (!byExitReason.has(exitKey)) {
      byExitReason.set(exitKey, emptyBucket({
        key: exitKey,
        status: row.op.status ?? 'UNKNOWN',
        closedReason: row.op.closed_reason ?? null,
      }));
    }
    tallyBucket(byExitReason.get(exitKey), row);

    const symbol = row.op.symbol ?? 'UNKNOWN';
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, emptyBucket({ symbol }));
    tallyBucket(bySymbol.get(symbol), row);

    const period = periodKey(row.op);
    if (!byPeriod.has(period)) byPeriod.set(period, emptyBucket({ period }));
    tallyBucket(byPeriod.get(period), row);
  }

  // Pior contribuição primeiro: a primeira linha é literalmente "de onde vem
  // o prejuízo". Ordenar por avgR colocaria um balde de 2 operações no topo.
  const finish = (map) => [...map.values()]
    .map((bucket) => finishBucket(bucket, closed.length, rCountedTotal))
    .sort((a, b) => a.contributionR - b.contributionR);

  // Exceção deliberada à ordenação acima: período é o único eixo em que a
  // ORDEM CRONOLÓGICA é a informação. Ordenar por contribuição esconderia
  // justamente o que se quer ver — se o resultado degrada, se está
  // concentrado num trimestre, ou se é estável ao longo do tempo.
  const finishChronological = (map) => [...map.values()]
    .map((bucket) => finishBucket(bucket, closed.length, rCountedTotal))
    .sort((a, b) => (a.period > b.period ? 1 : a.period < b.period ? -1 : 0));

  // Fronteira atravessada != funding pago. calcTradeCost gateia as liquidações
  // pela taxa (`fundingBpsPer8h > 0 ? ... : 0`) e aqui vale o mesmo: num run
  // --no-costs ninguém pagou nada. Mas a CONTAGEM de fronteiras continua sendo
  // medida nos dois regimes de propósito — ela é telemetria de duração (quantas
  // janelas de 8h a posição atravessa), que é exatamente o número por trás da
  // hipótese "o funding domina o custo" do item 44, e some justo no run
  // --no-costs que serve para o A/B.
  let sumFeeR = 0; let sumSlippageR = 0; let sumFundingR = 0; let sumCostR = 0;
  let costRCount = 0; let sumBoundaries = 0; let opsWithFunding = 0;
  const fundingCharged = models.resolved.fundingBpsPer8h > 0;
  for (const { op, costR } of rows) {
    const boundaries = countFundingSettlements(op);
    sumBoundaries += boundaries;
    if (fundingCharged && boundaries > 0) opsWithFunding += 1;
    if (costR === null) continue;
    costRCount += 1;
    sumCostR += costR;
    sumFeeR += calcCostR(op, models.fee) ?? 0;
    sumSlippageR += calcCostR(op, models.slippage) ?? 0;
    sumFundingR += calcCostR(op, models.funding) ?? 0;
  }
  const share = (part) => (sumCostR > 0 ? part / sumCostR : null);

  const hoursList = rows.map((row) => row.hours).filter((h) => h !== null);

  return {
    costModel: models.resolved,
    totalClosed: closed.length,
    rCounted: rCountedTotal,
    // Igual ao summarizeOps().expectancyR do mesmo conjunto — recalculado aqui
    // só para a soma das contribuições poder ser conferida contra ele.
    expectancyR: mean(sumRTotal, rCountedTotal),
    byExitReason: finish(byExitReason),
    bySymbol: finish(bySymbol),
    byPeriod: finishChronological(byPeriod),
    // Fração dos trimestres com contribuição >= 0. Resultado que vem de um
    // único trimestre bom não é estratégia, é sorte datada.
    positivePeriodsShare: byPeriod.size > 0
      ? [...byPeriod.values()].filter((b) => b.sumR >= 0).length / byPeriod.size
      : null,
    cost: {
      avgCostR: mean(sumCostR, costRCount),
      avgFeeR: mean(sumFeeR, costRCount),
      avgSlippageR: mean(sumSlippageR, costRCount),
      avgFundingR: mean(sumFundingR, costRCount),
      feeShare: share(sumFeeR),
      slippageShare: share(sumSlippageR),
      fundingShare: share(sumFundingR),
      // Geometria (sempre medida) vs. pagamento (só quando a taxa é > 0).
      avgBoundariesCrossed: mean(sumBoundaries, closed.length),
      opsWithFunding,
      fundingCharged,
      costRCount,
    },
    holdHours: {
      counted: hoursList.length,
      avg: mean(hoursList.reduce((a, b) => a + b, 0), hoursList.length),
      median: median(hoursList),
      min: hoursList.length > 0 ? Math.min(...hoursList) : null,
      max: hoursList.length > 0 ? Math.max(...hoursList) : null,
    },
  };
}

/**
 * Extrai as operações de um relatório de backtest. `overall.curve` carrega o
 * objeto completo de cada operação — é o artifact do run, não o resumo do job
 * (que remove `curve` de propósito para caber no GITHUB_STEP_SUMMARY).
 */
export function opsFromReport(report) {
  const curve = report?.overall?.curve;
  if (!Array.isArray(curve)) {
    throw new Error(
      'Relatório sem overall.curve — use o JSON completo (artifact backtest-report), não o resumo publicado no job.',
    );
  }
  return curve.map((entry) => entry?.op).filter(Boolean);
}

/** Conveniência: relatório → diagnóstico, reusando o modelo de custo do run. */
export function analyzeReport(report, { costModel } = {}) {
  const fromReport = report?.costs?.model;
  // O relatório ecoa o modelo aplicado com uma flag extra (`applied`) que não
  // faz parte do modelo — repassá-la é inofensivo (resolveCostModel ignora
  // chaves desconhecidas), mas o custo ZERO precisa sobreviver: um run
  // --no-costs tem que continuar sendo lido como custo zero aqui.
  return analyzeOps(opsFromReport(report), {
    costModel: costModel ?? fromReport ?? DEFAULT_COST_MODEL,
  });
}
