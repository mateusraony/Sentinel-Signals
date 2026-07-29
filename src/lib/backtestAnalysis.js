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
  ZERO_COST,
  calcCostR,
  calcRAtTp1,
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

// Todos os trimestres do intervalo PEDIDO, inclusive os sem nenhuma operação.
// Sem isto, `byPeriod` só conteria os trimestres que tiveram operação — e a
// concentração máxima (tudo num trimestre só, dele positivo) leria como "100%
// dos trimestres positivos", exatamente o oposto do que a métrica existe para
// detectar. Achado de revisão externa (Codex, PR #91).
export function enumeratePeriods(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
  const periods = [];
  const cursor = new Date(fromMs);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  cursor.setUTCMonth(Math.floor(cursor.getUTCMonth() / 3) * 3);
  while (cursor.getTime() <= toMs) {
    periods.push(`${cursor.getUTCFullYear()}-Q${Math.floor(cursor.getUTCMonth() / 3) + 1}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 3);
  }
  return periods;
}

export function sideKey(op) {
  const side = op?.side;
  return side === 'BUY' || side === 'SELL' ? side : 'UNKNOWN';
}

// ARMADILHA que este balde existe para evitar: operação da cascata SMC tem
// `tier` AUSENTE quando `smcTierEnabled` está desligado — que é o default
// (`scanner.js:634`). E `tier_time_stop_bars` cai no literal 96, que é
// exatamente o valor de T3 sem ser T3 (`scanner.js:637`). Inferir o tier a
// partir dele produziria uma tabela de aparência completa e errada, atribuindo
// a T3 operações que nunca foram classificadas. Ausente vira balde próprio.
export function tierKey(op) {
  const tier = op?.tier;
  return tier === 'T1' || tier === 'T2' || tier === 'T3' ? tier : 'SEM_TIER';
}

// Resultado da arbitragem cross-cascade (Fase 1, item 39), lido do campo que o
// scanner de fato persiste (`arbitration_outcome`, `scanner.js:741`).
//
// NÃO usar `confidence_penalty_total > 0` como proxy de "recebeu aviso" —
// achado de revisão externa (Codex, PR #94), confirmado: a penalidade vem de
// `pineConfig.arbOppositeScorePenalty ?? 15` (`signalArbitration.js:97`), que é
// configurável e pode ser 0; e `critical_opposite` no modo log-only não aplica
// penalidade nenhuma. Nos dois casos a operação FOI avisada e a soma continua
// zero, então o proxy classificaria errado, em silêncio.
export function arbitrationOutcomeKey(op) {
  const outcome = op?.arbitration_outcome;
  return typeof outcome === 'string' && outcome ? outcome : 'SEM_ARBITRAGEM';
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
export function analyzeOps(ops, { costModel, epsilonR = 0.05, epsilonPct = 0.1, rangeMs } = {}) {
  const closed = (ops || []).filter(isClosedOp);
  const models = costComponentModels(costModel);

  const rows = closed.map((op) => ({
    op,
    outcome: classifyOutcome(op, { epsilonR, epsilonPct, costModel }),
    r: calcRealizedR(op, costModel),
    // BRUTO, sempre — a atribuição do runner compara duas geometrias de saída,
    // e o cenário "fechou no TP1" não tem custo calculável (a operação não
    // existiu). Descontar custo de um lado só infla o resultado a favor da
    // hipótese em ~0,045 R. Ver known-risks item 46.
    grossR: calcRealizedR(op, ZERO_COST),
    costR: calcCostR(op, costModel),
    hours: holdHours(op),
  }));

  const rCountedTotal = rows.filter((row) => row.r !== null).length;
  const sumRTotal = rows.reduce((acc, row) => acc + (row.r ?? 0), 0);

  // Um eixo de decomposição = uma função de chave. Extraído quando o número de
  // eixos passou de 3 para 7: além de matar a repetição, deixa num lugar só a
  // garantia que realmente importa — TODO balde, de todo eixo, passa pelo mesmo
  // `tallyBucket` e pelo mesmo `finishBucket`, então a propriedade aditiva
  // (contribuições somam a expectância) vale em todos por construção, não por
  // sete implementações que por acaso concordam.
  const bucketRows = (keyFn, extraFn, seedKeys = []) => {
    const map = new Map();
    for (const key of seedKeys) map.set(key, emptyBucket(extraFn(key, null)));
    for (const row of rows) {
      const key = keyFn(row.op);
      if (!map.has(key)) map.set(key, emptyBucket(extraFn(key, row.op)));
      tallyBucket(map.get(key), row);
    }
    return map;
  };

  const byExitReason = bucketRows(exitReasonKey, (key, op) => ({
    key,
    status: op?.status ?? 'UNKNOWN',
    closedReason: op?.closed_reason ?? null,
  }));
  const bySymbol = bucketRows((op) => op.symbol ?? 'UNKNOWN', (symbol) => ({ symbol }));
  // Semeia os trimestres do intervalo pedido ANTES de contar, para os sem
  // operação aparecerem com count 0 em vez de sumirem da tabela.
  const windowPeriods = enumeratePeriods(rangeMs?.fromMs, rangeMs?.toMs);
  const byPeriod = bucketRows(periodKey, (period) => ({ period }), windowPeriods);
  const bySide = bucketRows(sideKey, (side) => ({ side }));
  const byTier = bucketRows(tierKey, (tier) => ({ tier }));
  // O cruzamento é onde a afirmação "BUY Tier 3 destrói o resultado" vive —
  // nenhum dos dois eixos isolados a responde.
  const bySideTier = bucketRows(
    (op) => `${sideKey(op)} ${tierKey(op)}`,
    (key) => ({ key, side: key.split(' ')[0], tier: key.split(' ')[1] }),
  );
  const byArbitration = bucketRows(arbitrationOutcomeKey, (key) => ({ key }));

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

  // ATRIBUIÇÃO DO RUNNER — a única peça da geometria de saída que nenhuma fase
  // mediu. Não é um eixo de baldes: é uma subtração entre dois cenários sobre
  // as MESMAS operações.
  //
  // Não há look-ahead: só entram operações que comprovadamente atingiram o TP1
  // (`tp1_hit` é fato observado) e o TP1 é um nível conhecido na entrada. O
  // contrafactual é sobre GESTÃO, nunca sobre preço — não pergunta "e se o
  // preço tivesse ido a outro lugar", pergunta "e se tivéssemos fechado tudo no
  // nível que o preço comprovadamente tocou".
  //
  // `avgContributionR` divide pelo MESMO `rCountedTotal` dos demais eixos, para
  // ser somável/comparável com `expectancyR` em vez de ser uma média sobre um
  // subconjunto (que é o erro que a decomposição inteira existe para evitar).
  let sumGrossR = 0; let sumGrossAtTp1 = 0;
  let opsWithTp1 = 0; let reachedTp2 = 0; let betterAtTp1 = 0; let worseAtTp1 = 0;
  for (const { op, grossR } of rows) {
    if (grossR === null) continue;
    sumGrossR += grossR;
    const atTp1 = calcRAtTp1(op);
    // TP1 irrecuperável (doc corrompido) degrada para "runner não avaliável" —
    // contribui 0 para a atribuição em vez de sumir da expectância bruta.
    if (atTp1 === null) { sumGrossAtTp1 += grossR; continue; }
    sumGrossAtTp1 += atTp1;
    opsWithTp1 += 1;
    if (op.status === 'TP2_HIT') reachedTp2 += 1;
    if (atTp1 > grossR) betterAtTp1 += 1; else if (atTp1 < grossR) worseAtTp1 += 1;
  }

  const hoursList = rows.map((row) => row.hours).filter((h) => h !== null);
  const activeCount = [...byPeriod.values()].filter((b) => b.count > 0).length;

  return {
    costModel: models.resolved,
    totalClosed: closed.length,
    rCounted: rCountedTotal,
    // Igual ao summarizeOps().expectancyR do mesmo conjunto — recalculado aqui
    // só para a soma das contribuições poder ser conferida contra ele.
    expectancyR: mean(sumRTotal, rCountedTotal),
    byExitReason: finish(byExitReason),
    bySymbol: finish(bySymbol),
    // Eixos de verificação das afirmações da auditoria externa (2026-07-28).
    // Mesma propriedade aditiva dos demais: as contribuições de cada eixo somam
    // exatamente a expectância geral, então cada linha diz quantos R vieram
    // dali — não é comparação de médias entre grupos de tamanhos diferentes.
    bySide: finish(bySide),
    byTier: finish(byTier),
    bySideTier: finish(bySideTier),
    byArbitration: finish(byArbitration),
    byPeriod: finishChronological(byPeriod),
    // DUAS medidas, e é preciso ler as duas juntas — separadas de propósito
    // porque cada uma sozinha engana:
    //
    // `positivePeriodsShare` = positivos ÷ trimestres COM operação. Responde
    // "quando operou, operou bem?".
    // `activePeriodsShare` = trimestres com operação ÷ trimestres da JANELA.
    // Responde "operou o tempo todo, ou só num pedaço?".
    //
    // O caso que motivou a separação: tudo concentrado num trimestre lucrativo
    // dá positivePeriodsShare = 100% — que lido sozinho parece estabilidade
    // perfeita e é o oposto disso. Com activePeriodsShare = 1/16 ao lado, a
    // concentração fica visível. `null` quando a janela é desconhecida
    // (chamada direta a analyzeOps sem rangeMs) — nunca um número inventado.
    positivePeriodsShare: activeCount > 0
      ? [...byPeriod.values()].filter((b) => b.count > 0 && b.sumR >= 0).length / activeCount
      : null,
    activePeriodsShare: windowPeriods.length > 0 ? activeCount / windowPeriods.length : null,
    activePeriods: activeCount,
    totalPeriods: windowPeriods.length || byPeriod.size,
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
    runner: {
      opsWithTp1,
      reachedTp2,
      betterAtTp1,
      worseAtTp1,
      // Invariante testada: avgContributionR === grossExpectancyR - grossExpectancyRAtTp1.
      grossExpectancyR: mean(sumGrossR, rCountedTotal),
      grossExpectancyRAtTp1: mean(sumGrossAtTp1, rCountedTotal),
      totalContributionR: sumGrossR - sumGrossAtTp1,
      avgContributionR: mean(sumGrossR - sumGrossAtTp1, rCountedTotal),
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
    // A janela vem do relatório, não das operações: é a diferença entre
    // "trimestres que operaram" e "trimestres que existiam para operar".
    // `fromMs`/`toMs` são o que buildReport grava; as strings ISO são fallback
    // para relatório editado à mão ou truncado — sem isso a janela viraria
    // "desconhecida" em silêncio, que é pior que estar errada de forma visível.
    rangeMs: report?.range
      ? {
        fromMs: report.range.fromMs ?? Date.parse(report.range.from),
        toMs: report.range.toMs ?? Date.parse(report.range.to),
      }
      : undefined,
  });
}
