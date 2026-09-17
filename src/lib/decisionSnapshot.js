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
