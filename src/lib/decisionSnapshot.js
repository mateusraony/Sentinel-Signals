// Fase 1 — Explainability V2 (Decision Snapshot). Builders puros que
// EMPACOTAM fatos que scanner.js já tem em escopo no momento de uma decisão
// — nunca recalculam a decisão em si. `src/lib/signalRejection.js` já
// resolve o motivo CATEGÓRICO (`reason_code`/`reason_detail`, write-on-
// change); este módulo adiciona o bloco `facts{}` numérico que hoje é
// calculado e descartado (ex.: scanner.js `rfRegimeOutcomes.push(...)`
// só alimenta o relatório de backtest, nunca chega à produção).
//
// Contrato deliberado (não um schema por reason_code): `facts` é um mapa
// aberto, preenchido só com o que faz sentido para aquele reason_code — o
// consumidor (`decisionExplanation.js`) já sabe, pelo `reason_code`, quais
// chaves esperar. `rules[]` é opcional e pequeno: só os gates que ESTA
// decisão avaliou, não uma reconstrução da árvore inteira do motor.
//
// Fail-closed: ausência de dado vira `data_status: 'UNKNOWN'`, nunca um
// valor favorável inventado. Nenhuma função aqui faz I/O — quem escreve é
// scanner.js, exatamente como opExitRules.js/opTransition.js.
//
// Se você adicionar um builder de gestão (HOLDING/PROTECTED) espelhando uma
// condição de src/lib/opExitRules.js, mantenha um comentário cruzado nos
// dois arquivos apontando um pro outro — este módulo RÓTULA a condição, não
// a recalcula com autoridade; só opExitRules.js decide o stop de verdade.

export const DECISION = Object.freeze({
  ENTRY_BLOCKED: 'ENTRY_BLOCKED',
  ENTRY_PENDING: 'ENTRY_PENDING',
  HOLDING: 'HOLDING',
  PROTECTED: 'PROTECTED',
  EXIT: 'EXIT',
});

export const DATA_STATUS = Object.freeze({
  LIVE: 'LIVE',
  STALE: 'STALE',
  UNKNOWN: 'UNKNOWN',
});

function baseSnapshot({
  decision, reasonCode, reasonDetail = null, facts = {}, rules = [],
  evaluatedAt, marketTime = null, executor = null, dataStatus,
}) {
  return {
    decision,
    reason_code: reasonCode,
    reason_detail: reasonDetail,
    facts,
    rules,
    evaluated_at: evaluatedAt,
    market_time: marketTime,
    executor,
    data_status: dataStatus,
  };
}

// `evaluateRegime` (scanner.js) — gate ADX + Choppiness por tier. `regime`
// é o retorno dela ({ ok, adxOk, chopOk }); `tfData` é o mesmo `results['4h']`/
// `tfData1h` já buscado nesta passada — não busca nada novo. `detail` é o
// categórico já produzido por `regimeDetail()` (signalRejection.js), passado
// aqui só para virar `reason_detail` — este builder não decide o detalhe.
export function buildRegimeSnapshot({
  regime, tfData, detail = null, executor = null, evaluatedAt = new Date().toISOString(),
}) {
  const tier = tfData?.tier ?? null;
  const adx = tfData?.adx?.adx ?? null;
  const chop = Number.isFinite(tfData?.chop) ? tfData.chop : null;
  const dataStatus = (adx == null || chop == null || !tier) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE;
  return baseSnapshot({
    decision: DECISION.ENTRY_BLOCKED,
    reasonCode: 'regime_rejected',
    reasonDetail: detail,
    facts: {
      adx,
      adx_min: tier?.adxMinVal ?? null,
      chop,
      chop_max: tier?.chopMaxVal ?? null,
      tier: tier?.tier ?? null,
    },
    rules: [
      { id: 'ADX', pass: regime?.adxOk !== false, fact_keys: ['adx', 'adx_min'] },
      { id: 'CHOP', pass: regime?.chopOk !== false, fact_keys: ['chop', 'chop_max'] },
    ],
    evaluatedAt,
    marketTime: tfData?.lastCandleTime ?? null,
    executor,
    dataStatus,
  });
}

// Tendência do timeframe maior virou contra o lado do sinal
// (`tf4hDir !== sigDir` / `tfData1h.smc.trend !== sigDir` em scanner.js).
// `currentDirection`/`signalDirection` são os dois inteiros (1/-1) já
// comparados no ponto de chamada — este builder só nomeia o resultado.
export function buildTrendReversedSnapshot({
  currentDirection, signalDirection, detail = null, executor = null,
  marketTime = null, evaluatedAt = new Date().toISOString(),
}) {
  const dataStatus = (currentDirection == null || signalDirection == null)
    ? DATA_STATUS.UNKNOWN
    : DATA_STATUS.LIVE;
  return baseSnapshot({
    decision: DECISION.ENTRY_BLOCKED,
    reasonCode: 'trend_reversed',
    reasonDetail: detail,
    facts: {
      current_direction: currentDirection ?? null,
      signal_direction: signalDirection ?? null,
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus,
  });
}

// Fase 3 — gestão de TradeOperation ATIVA (HOLDING/PROTECTED). Distância
// "positiva" sempre significa a mesma coisa nos dois lados (BUY/SELL): quanto
// falta/quanta folga existe, nunca um sinal que troca de significado por
// lado. Mesma convenção de `sign` que o bloco de MFE/MAE de scanner.js já usa
// (`sign = isBuy ? 1 : -1`) — não é um cálculo novo, é a mesma ideia aplicada
// a displays diferentes.
function signedMove(value, reference, isBuy) {
  if (!Number.isFinite(value) || !Number.isFinite(reference)) return null;
  return (isBuy ? 1 : -1) * (value - reference);
}

// Pré-TP1, proteção desligada (`op.pre_tp1_stop_protection_enabled !== true`)
// ou dado insuficiente para avaliá-la nesta passada (`!tfData.atrValue`) —
// scanner.js nem chega a chamar `advancePreTp1StopProtection`/
// `advancePreTp1Trailing`. Não há avanço de stop possível aqui; os únicos
// fatos genuínos são a distância até TP1 e até o stop já vigente.
export function buildAwaitingTp1Snapshot({
  closePrice, stop, tp1, isBuy, executor = null, marketTime = null,
  evaluatedAt = new Date().toISOString(),
}) {
  const distanceToTp1 = signedMove(tp1, closePrice, isBuy);
  const distanceToStop = signedMove(closePrice, stop, isBuy);
  return baseSnapshot({
    decision: DECISION.HOLDING,
    reasonCode: 'awaiting_tp1',
    facts: { distance_to_tp1: distanceToTp1, distance_to_stop: distanceToStop },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: (distanceToTp1 == null || distanceToStop == null) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// Pré-TP1, modo breakeven (`op.pre_tp1_stop_mode !== 'trailing'`) — espelha
// `opExitRules.js:advancePreTp1StopProtection`. A decisão PROTECTED-vs-HOLDING
// NUNCA re-testa o critério interno dela (`favorableMove < atrValue *
// triggerAtrMult`) — compara os dois valores de stop que scanner.js já
// calculou (antes/depois de chamá-la), então não há como divergir do que a
// função realmente fez. `favorable_move`/`required_move` são só contexto de
// exibição, não decidem nada.
export function buildPreTp1BreakevenSnapshot({
  isBuy, entry, stopBefore, stopAfter, closePrice, atrValue, triggerAtrMult,
  executor = null, marketTime = null, evaluatedAt = new Date().toISOString(),
}) {
  const advanced = stopAfter !== stopBefore;
  const favorableMove = signedMove(closePrice, entry, isBuy);
  const requiredMove = Number.isFinite(atrValue) && Number.isFinite(triggerAtrMult) ? atrValue * triggerAtrMult : null;
  return baseSnapshot({
    decision: advanced ? DECISION.PROTECTED : DECISION.HOLDING,
    reasonCode: advanced ? 'breakeven_triggered' : 'pre_tp1_protection_armed_not_triggered',
    facts: {
      favorable_move: favorableMove, required_move: requiredMove,
      atr: Number.isFinite(atrValue) ? atrValue : null, trigger_atr_mult: triggerAtrMult ?? null,
      stop_before: stopBefore, stop_after: stopAfter,
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: (favorableMove == null || requiredMove == null) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// Pré-TP1, modo trailing contínuo (`op.pre_tp1_stop_mode === 'trailing'`) —
// espelha `opExitRules.js:advancePreTp1Trailing`. Mesma disciplina do
// breakeven acima: decisão por comparação de stop antes/depois, nunca por
// re-testar o critério interno. `favorableExtreme === null` (ainda sem MFE
// utilizável) é um estado genuíno, não dado ausente — `data_status` continua
// LIVE, só `facts.favorable_move` fica `null`.
export function buildPreTp1TrailingSnapshot({
  isBuy, entry, stopBefore, stopAfter, favorableExtreme, atrValue, startAtrMult, trailAtrMult,
  executor = null, marketTime = null, evaluatedAt = new Date().toISOString(),
}) {
  const advanced = stopAfter !== stopBefore;
  const favorableMove = favorableExtreme == null ? null : signedMove(favorableExtreme, entry, isBuy);
  const requiredMove = Number.isFinite(atrValue) && Number.isFinite(startAtrMult) ? atrValue * startAtrMult : null;
  return baseSnapshot({
    decision: advanced ? DECISION.PROTECTED : DECISION.HOLDING,
    reasonCode: advanced ? 'pre_tp1_trailing_advanced' : 'pre_tp1_trailing_dormant',
    facts: {
      favorable_move: favorableMove, required_move: requiredMove,
      atr: Number.isFinite(atrValue) ? atrValue : null,
      start_atr_mult: startAtrMult ?? null, trail_atr_mult: trailAtrMult ?? null,
      stop_before: stopBefore, stop_after: stopAfter,
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: !Number.isFinite(atrValue) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// Achado de revisão independente (2026-09-17): no candle EXATO em que TP1
// dispara, `scanner.js` muda `newStatus` para `RUNNER_ACTIVE` e move o stop
// pra entrada (breakeven) — mas nem o bloco pré-TP1 nem o pós-TP1 rodam
// nessa mesma passada (os dois são gateados por `newStatus === op.status`/
// `newStatus === 'RUNNER_ACTIVE' && candleUsable`, e o status já mudou
// ANTES desses gates serem avaliados). Sem este builder, o `decision_snapshot`
// ficava congelado no último valor PRÉ-TP1 (ex.: "Monitorando — faltam X até
// o TP1") numa operação que já é runner. Não reusa `buildRunnerTrailingSnapshot`
// de propósito: o stop não moveu por trilha ATR aqui, moveu porque TP1
// disparou — atribuir à trilha seria descrever o motivo errado.
export function buildTp1HitSnapshot({
  stopBefore, stopAfter, tp1, executor = null, marketTime = null, evaluatedAt = new Date().toISOString(),
}) {
  const advanced = stopAfter !== stopBefore;
  return baseSnapshot({
    decision: advanced ? DECISION.PROTECTED : DECISION.HOLDING,
    reasonCode: advanced ? 'tp1_hit_stop_to_breakeven' : 'tp1_hit_stop_unchanged',
    facts: { stop_before: stopBefore, stop_after: stopAfter, tp1: Number.isFinite(tp1) ? tp1 : null },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: DATA_STATUS.LIVE,
  });
}

// Pós-TP1, runner ATR-based (`op.exit_mode` é `HYBRID_RF_ATR`/`ATR_TRAILING`
// — na prática toda operação real) — espelha
// `opExitRules.js:advanceTrailingStop`. Mesma disciplina: decisão por
// comparação de stop antes/depois.
export function buildRunnerTrailingSnapshot({
  stopBefore, stopAfter, closePrice, atrValue, trailMult,
  executor = null, marketTime = null, evaluatedAt = new Date().toISOString(),
}) {
  const advanced = stopAfter !== stopBefore;
  return baseSnapshot({
    decision: advanced ? DECISION.PROTECTED : DECISION.HOLDING,
    reasonCode: advanced ? 'runner_trailing_advanced' : 'runner_trailing_dormant',
    facts: {
      atr: Number.isFinite(atrValue) ? atrValue : null, trail_mult: trailMult ?? null,
      stop_before: stopBefore, stop_after: stopAfter,
      close_price: Number.isFinite(closePrice) ? closePrice : null,
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: !Number.isFinite(atrValue) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// Pós-TP1, runner NÃO ATR-based (`op.exit_mode` legado/outro) ou ATR
// indisponível nesta passada — o runner aqui é gerenciado pela invalidação
// RF (branch separada em scanner.js), não por trailing de stop. Raro em
// produção (os dois pontos de criação de operação sempre gravam
// `exit_mode: 'HYBRID_RF_ATR'|`), mas cobre operações legadas sem cair em
// ausência total de explicação.
export function buildRunnerRfManagedSnapshot({
  closePrice, stop, tp2, tp2Disabled = false, isBuy, executor = null,
  marketTime = null, evaluatedAt = new Date().toISOString(),
}) {
  const distanceToStop = signedMove(closePrice, stop, isBuy);
  const distanceToTp2 = tp2Disabled ? null : signedMove(tp2, closePrice, isBuy);
  return baseSnapshot({
    decision: DECISION.HOLDING,
    reasonCode: 'runner_rf_managed',
    facts: { distance_to_stop: distanceToStop, distance_to_tp2: distanceToTp2 },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: distanceToStop == null ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// Fase 4 — Explainability V2 (EXIT). decision é sempre DECISION.EXIT. Cada
// ponto de interceptação de scanner.js ganha seu PRÓPRIO reason_code — nunca
// um builder genérico "exit" — porque os gates por trás de cada saída são
// diferentes (ex.: INVALIDATED pré-TP1 é decidido por CONTAGEM de candles
// contra o RF revertido; INVALIDATED pós-TP1/RF é uma comparação DIRETA no
// candle atual, sem contador nenhum — misturar os dois num só reason_code
// descreveria o mecanismo errado num dos dois casos). reason_code aqui NÃO é
// o mesmo vocabulário de TradeOperation.closed_reason (que continua existindo
// e é gravado do mesmo jeito de sempre) — é sempre igual ou MAIS granular,
// nunca mais grosseiro (STOP_HIT/TP2_HIT nem têm closed_reason hoje). Cada
// builder só empacota facts que scanner.js já tem em escopo no ponto exato da
// decisão — nunca reimplementa o if/else que decidiu newStatus.

// STOP_HIT, pré-TP1 (scanner.js ~3804) ou pós-TP1/runner (~4005) — `stage`
// distingue os dois só para o reason_code; os facts são os mesmos porque o
// gate em si (stopCheckPrice cruzou op.current_stop) é idêntico nos dois
// pontos.
export function buildStopHitSnapshot({
  stage, stop, closePrice, stopCheckPrice, entryPrice, barsSinceEntry, ambiguous = false,
  executor = null, marketTime = null, evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: stage === 'runner' ? 'stop_hit_runner' : 'stop_hit_pre_tp1',
    facts: {
      stop: Number.isFinite(stop) ? stop : null,
      close_price: Number.isFinite(closePrice) ? closePrice : null,
      stop_check_price: Number.isFinite(stopCheckPrice) ? stopCheckPrice : null,
      entry_price: Number.isFinite(entryPrice) ? entryPrice : null,
      bars_since_entry: Number.isFinite(barsSinceEntry) ? barsSinceEntry : null,
      exit_ambiguous: Boolean(ambiguous),
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: (stop == null || stopCheckPrice == null) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// TP2_HIT (scanner.js ~4016) — sempre pós-TP1/runner, único ponto candle-based.
export function buildTp2HitSnapshot({
  tp2, tpCheckPrice, entryPrice, executor = null, marketTime = null,
  evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: 'tp2_hit',
    facts: {
      tp2: Number.isFinite(tp2) ? tp2 : null,
      tp_check_price: Number.isFinite(tpCheckPrice) ? tpCheckPrice : null,
      entry_price: Number.isFinite(entryPrice) ? entryPrice : null,
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: (tp2 == null || tpCheckPrice == null) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// INVALIDATED, pré-TP1 (scanner.js ~3814) — único gate movido por CONTAGEM de
// candles com RF revertido (rf_reverse_bars_count/nextRfReverseCount, P0-e).
// reverseBars/invalidRfBars são os dois valores que invalidationTriggered de
// fato compara — nunca reusar este builder no pós-TP1, que não tem contador.
export function buildInvalidatedRfBarsSnapshot({
  reverseBars, invalidRfBars, rfDir, rfFilt, closePrice,
  executor = null, marketTime = null, evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: 'invalidated_rf_bars_pre_tp1',
    facts: {
      reverse_bars: Number.isFinite(reverseBars) ? reverseBars : null,
      invalid_rf_bars: Number.isFinite(invalidRfBars) ? invalidRfBars : null,
      rf_direction: rfDir ?? null,
      rf_filter_value: Number.isFinite(rfFilt) ? rfFilt : null,
      close_price: Number.isFinite(closePrice) ? closePrice : null,
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: !Number.isFinite(reverseBars) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// INVALIDATED, pós-TP1, cascata RF (scanner.js ~4043) — comparação DIRETA no
// candle atual (rfInval), sem contador de barras. Reason_code separado do
// builder acima de propósito (ver comentário de cabeçalho desta seção).
export function buildInvalidatedRfDirectSnapshot({
  rfDir, rfFilt, closePrice, executor = null, marketTime = null,
  evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: 'invalidated_rf_direct_runner',
    facts: {
      rf_direction: rfDir ?? null,
      rf_filter_value: Number.isFinite(rfFilt) ? rfFilt : null,
      close_price: Number.isFinite(closePrice) ? closePrice : null,
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: (rfFilt == null || closePrice == null) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// INVALIDATED, pós-TP1, cascata SMC 1h_5m (scanner.js ~4025) — estrutura
// reverteu (tfData.smc.trend), gate independente da RF.
export function buildInvalidatedSmcStructureSnapshot({
  smcTrend, isBuy, closePrice, executor = null, marketTime = null,
  evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: 'invalidated_smc_structure',
    facts: {
      smc_trend: smcTrend ?? null,
      signal_direction: isBuy ? 1 : -1,
      close_price: Number.isFinite(closePrice) ? closePrice : null,
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: smcTrend == null ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// CLOSED/CHOP_EXIT (scanner.js ~3820) — Choppiness passou do limite pré-TP1.
export function buildChopExitSnapshot({
  chop, chopMax, closePrice, executor = null, marketTime = null,
  evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: 'chop_exit',
    facts: {
      chop: Number.isFinite(chop) ? chop : null,
      chop_max: chopMax ?? null,
      close_price: Number.isFinite(closePrice) ? closePrice : null,
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: chop == null ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// CLOSED/TIME_STOP (scanner.js ~3826) — prazo máximo sem TP1, por tempo
// decorrido (barsOpen), não candle novo.
export function buildTimeStopSnapshot({
  barsOpen, timeStopBars, entryRef, closePrice, executor = null, marketTime = null,
  evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: 'time_stop',
    facts: {
      bars_open: Number.isFinite(barsOpen) ? barsOpen : null,
      time_stop_bars: Number.isFinite(timeStopBars) ? timeStopBars : null,
      entry_ref: entryRef ?? null,
      close_price: Number.isFinite(closePrice) ? closePrice : null,
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: !Number.isFinite(barsOpen) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// CLOSED/TP1_FULL (scanner.js ~3845) — sem runner, TP1 encerra a posição por
// completo. Distinto de buildTp1HitSnapshot (Fase 3, que é HOLDING/PROTECTED
// com runner ativo) — aqui a operação termina, não continua gerenciada.
export function buildTp1FullCloseSnapshot({
  tp1, entryPrice, barsSinceEntry, executor = null, marketTime = null,
  evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: 'tp1_full_close',
    facts: {
      tp1: Number.isFinite(tp1) ? tp1 : null,
      entry_price: Number.isFinite(entryPrice) ? entryPrice : null,
      bars_since_entry: Number.isFinite(barsSinceEntry) ? barsSinceEntry : null,
    },
    evaluatedAt,
    marketTime,
    executor,
    dataStatus: DATA_STATUS.LIVE,
  });
}

// priceCheckActiveOpsInner não tem candle/ATR/Chop/ADX/RF/SMC em escopo —
// nunca inventar esses facts aqui. reason_code com sufixo _price_check para
// não fingir paridade com os builders candle-based acima, que têm muito mais
// contexto disponível.
export function buildStopHitPriceCheckSnapshot({
  stop, price, executor = null, evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: 'stop_hit_price_check',
    facts: {
      stop: Number.isFinite(stop) ? stop : null,
      price: Number.isFinite(price) ? price : null,
    },
    evaluatedAt,
    marketTime: null,
    executor,
    dataStatus: (stop == null || price == null) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

export function buildTp2HitPriceCheckSnapshot({
  tp2, price, executor = null, evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: 'tp2_hit_price_check',
    facts: {
      tp2: Number.isFinite(tp2) ? tp2 : null,
      price: Number.isFinite(price) ? price : null,
    },
    evaluatedAt,
    marketTime: null,
    executor,
    dataStatus: (tp2 == null || price == null) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// TP1_FULL, price-check (scanner.js priceCheckActiveOpsInner) — 3º ponto
// "magro" deste loop, fechando a lacuna deixada aberta de propósito na Fase 4
// (docs/known-risks.md item 183). reason_code próprio (sufixo _price_check),
// distinto de tp1_full_close (candle-based), mesma disciplina dos outros dois.
export function buildTp1FullClosePriceCheckSnapshot({
  tp1, price, executor = null, evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: 'tp1_full_close_price_check',
    facts: {
      tp1: Number.isFinite(tp1) ? tp1 : null,
      price: Number.isFinite(price) ? price : null,
    },
    evaluatedAt,
    marketTime: null,
    executor,
    dataStatus: (tp1 == null || price == null) ? DATA_STATUS.UNKNOWN : DATA_STATUS.LIVE,
  });
}

// Fechamento manual (src/pages/Trades.jsx) — decisão humana pelo painel, não
// uma condição medida pelo motor. `facts` fica vazio de propósito: não há
// nada numérico a atribuir a um clique do usuário; o motivo já é o próprio
// reason_code/closed_reason correspondente.
export function buildManualCloseSnapshot({
  status, executor = 'manual', evaluatedAt = new Date().toISOString(),
}) {
  return baseSnapshot({
    decision: DECISION.EXIT,
    reasonCode: status === 'INVALIDATED' ? 'manual_invalidated' : 'manual_closed',
    facts: {},
    evaluatedAt,
    marketTime: null,
    executor,
    dataStatus: DATA_STATUS.LIVE,
  });
}
